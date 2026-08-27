import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redisConnection, type MtnVerifyJobData, type N2bPollJobData } from "../lib/queue";
import { config, assertProviderKeysConfigured, mtnRequestIntervalMs } from "../lib/config";
import { mtnClient, classifyMtnResult, MtnRateLimitedError } from "../lib/mtn";
import {
  recordMtnResult,
  recordMtnExhausted,
  recordMtnUnreachable,
  pollN2bBatchOnce,
  failListFromMtn,
  isListInactive,
} from "../lib/pipeline";

assertProviderKeysConfigured();

// Last line of defense: an uncaught error anywhere should be logged, not
// silently take down a process that may be mid-way through thousands of
// rows across multiple clients' lists.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaught exception", err);
});

class TransientMtnError extends Error {
  constructor(
    public mtnStatus: string,
    public mtnMessage: string
  ) {
    super(`MTN transient result: ${mtnMessage}`);
  }
}

const mtnWorker: Worker<MtnVerifyJobData> = new Worker<MtnVerifyJobData>(
  "mtn-verify",
  async (job: Job<MtnVerifyJobData>) => {
    const { listRowId, listId, email } = job.data;

    // A stopped or deleted list keeps receiving the jobs already queued for
    // it. Drop them rather than hammering a known-bad key thousands of
    // times, or writing rows back to a list that no longer exists.
    if (await isListInactive(listId)) return;

    let result;
    try {
      result = await mtnClient.verify(email);
    } catch (err) {
      if (err instanceof MtnRateLimitedError) {
        // Pause the whole worker, not just this job -- every other in-flight
        // request is hitting the same limit. RateLimitError returns the job
        // to the queue without consuming a retry, so being throttled costs
        // time rather than costing the row (or the list).
        console.warn(`[worker:mtn-verify] 429 received, pausing ${err.retryAfterMs}ms`);
        await mtnWorker.rateLimit(err.retryAfterMs);
        throw Worker.RateLimitError();
      }
      throw err;
    }

    const outcome = classifyMtnResult(result.code, result.message);

    if (outcome === "fatal") {
      await failListFromMtn(listId, result.message);
      return;
    }

    if (outcome === "transient") {
      throw new TransientMtnError(result.code, result.message);
    }

    await recordMtnResult({
      listRowId,
      listId,
      normalizedEmail: email,
      mtnStatus: result.code,
      mtnMessage: result.message,
      outcome,
    });
  },
  {
    connection: redisConnection,
    concurrency: config.mtn.concurrency,
    // One start per interval rather than a window's worth at once. Expressed
    // as max:1 because a window-based limit lets the entire allowance fire
    // simultaneously -- legal by the per-window total, but a burst as far as
    // the provider is concerned, which is what earned a 429. Concurrency
    // still lets slow probes overlap, so paced starts do not mean idle time.
    limiter: { max: 1, duration: mtnRequestIntervalMs() },
  }
);

mtnWorker.on("failed", async (job, err) => {
  if (!job) return;

  // A throttled job is being retried, not abandoned -- it must never be
  // read as the provider being unreachable, which would stop the list.
  if (err?.name === "RateLimitError" || err instanceof MtnRateLimitedError) return;

  const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isLastAttempt) return;

  // BullMQ does not await or catch this listener's promise -- an unhandled
  // rejection here becomes a process-level unhandledRejection, which by
  // default crashes the whole worker (and every list it's processing, not
  // just this row). Everything below must never throw past this point.
  try {
    if (err instanceof TransientMtnError) {
      await recordMtnExhausted({
        listRowId: job.data.listRowId,
        listId: job.data.listId,
        mtnStatus: err.mtnStatus,
        mtnMessage: err.mtnMessage,
      });
    } else {
      // We never got an answer from MTN at all (DNS, TLS, socket, timeout).
      // That says nothing about the address, so escalating it to the paid
      // provider would charge for a row the cheap pass never actually
      // checked. Park it back as pending and stop the list instead -- a
      // network blip must not turn into a bill.
      console.error(
        `[worker:mtn-verify] unreachable for ${job.data.email}: ${err.message}`
      );
      await recordMtnUnreachable({
        listRowId: job.data.listRowId,
        listId: job.data.listId,
        message: err.message,
      });
    }
  } catch (handlerErr) {
    console.error("[worker:mtn-verify] failed to record exhausted row", handlerErr);
  }
});

const n2bPollWorker = new Worker<N2bPollJobData>(
  "n2b-poll",
  async (job: Job<N2bPollJobData>) => {
    await pollN2bBatchOnce(job.data.batchId);
  },
  { connection: redisConnection }
);

for (const worker of [mtnWorker, n2bPollWorker]) {
  worker.on("error", (err) => console.error(`[worker:${worker.name}] error`, err));
}

console.log("Waterfall Verifier worker started (mtn-verify, n2b-poll queues).");
