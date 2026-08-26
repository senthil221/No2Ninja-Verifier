import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redisConnection, type MtnVerifyJobData, type N2bPollJobData } from "../lib/queue";
import { config, assertProviderKeysConfigured } from "../lib/config";
import { mtnClient, classifyMtnMessage } from "../lib/mtn";
import { recordMtnResult, recordMtnExhausted, pollN2bBatchOnce } from "../lib/pipeline";

assertProviderKeysConfigured();

class TransientMtnError extends Error {
  constructor(
    public mtnStatus: string,
    public mtnMessage: string
  ) {
    super(`MTN transient result: ${mtnMessage}`);
  }
}

const mtnWorker = new Worker<MtnVerifyJobData>(
  "mtn-verify",
  async (job: Job<MtnVerifyJobData>) => {
    const { listRowId, listId, email } = job.data;
    const result = await mtnClient.verify(email);
    const outcome = classifyMtnMessage(result.message);

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
    limiter: { max: config.mtn.rateLimitMax, duration: config.mtn.rateLimitWindowMs },
  }
);

mtnWorker.on("failed", async (job, err) => {
  if (!job) return;
  const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isLastAttempt) return;

  if (err instanceof TransientMtnError) {
    await recordMtnExhausted({
      listRowId: job.data.listRowId,
      listId: job.data.listId,
      mtnStatus: err.mtnStatus,
      mtnMessage: err.mtnMessage,
    });
  } else {
    // Unexpected failure (network blip, etc.) after exhausting retries —
    // still needs to fall through to N2B rather than leaving the row stuck.
    await recordMtnExhausted({
      listRowId: job.data.listRowId,
      listId: job.data.listId,
      mtnStatus: "error",
      mtnMessage: err.message,
    });
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
