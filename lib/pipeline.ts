import { prisma } from "./prisma";
import { config } from "./config";
import { parseEmailCsv } from "./csv";
import { mtnQueue, n2bPollQueue, listRetryQueue } from "./queue";
import { n2bClient, type N2bRowResult } from "./n2b";
import { classifyMtnResult } from "./mtn";
import { sendAlert } from "./alerts";
import { isRetryableFailure, autoRetryDelayMs } from "./retry-policy";
import { domainOf, loadDomainFacts, recordDomainFact, verdictFromDomain } from "./domains";
import type { FinalStatus, ResultSource } from "@prisma/client";
import { mtnJobId } from "./mtn-queue-policy";
import {
  ACTIVE_VERIFICATION_STATUSES,
  VERIFICATION_SCHEDULER_LOCK_SQL,
} from "./list-scheduler-policy";

// Serialises every attempt to acquire the one global verification slot,
// including attempts arriving in different Next.js/worker processes. The
// partial unique index in Postgres is the final invariant; this lock gives us
// deterministic FIFO selection instead of turning a harmless race into an
// index violation.
const VERIFICATION_SCHEDULER_LOCK = 2_026_08_31;

async function claimNextQueuedList(): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe<Array<{ lockResult: string }>>(
      VERIFICATION_SCHEDULER_LOCK_SQL,
      VERIFICATION_SCHEDULER_LOCK
    );

    const active = await tx.list.count({
      where: { status: { in: [...ACTIVE_VERIFICATION_STATUSES] } },
    });
    if (active > 0) return null;

    const next = await tx.list.findFirst({
      where: { status: "queued" },
      orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!next) return null;

    const claimed = await tx.list.updateMany({
      where: { id: next.id, status: "queued" },
      data: { status: "running_mtn", queuedAt: null },
    });
    return claimed.count === 1 ? next.id : null;
  });
}

async function resumeInFlightN2bBatch(listId: string): Promise<boolean> {
  const batch = await prisma.n2bBatch.findFirst({
    where: { listId, status: { in: ["submitted", "polling"] } },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });
  if (!batch) return false;

  await n2bPollQueue.add(
    "poll",
    { batchId: batch.id },
    { delay: config.n2b.pollIntervalMs, removeOnComplete: true, removeOnFail: true }
  );
  return true;
}

// Starts the oldest approved list only when neither provider is handling a
// different list. Waiting/delayed MTN work is rebuilt for the new owner so a
// historical queue entry can never make another list consume the allowance.
export async function dispatchNextQueuedList(): Promise<string | null> {
  const [activeMtnJobs, activeN2bJobs] = await Promise.all([
    mtnQueue.getActiveCount(),
    n2bPollQueue.getActiveCount(),
  ]);
  if (activeMtnJobs + activeN2bJobs > 0) return null;

  const listId = await claimNextQueuedList();
  if (!listId) return null;

  await Promise.all([mtnQueue.drain(true), n2bPollQueue.drain(true)]);
  try {
    await enqueuePendingRows(listId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(listId, `Could not start the queued list (${message}).`, {
      retryable: isRetryableFailure(err),
    });
  }
  return listId;
}

// Worker startup is the recovery boundary for a process interruption between
// the database claim and Redis enqueue. It also cleans queue entries left by
// the older multi-list scheduler before resuming the single active owner.
export async function recoverVerificationScheduler(): Promise<string | null> {
  const active = await prisma.list.findFirst({
    where: { status: { in: [...ACTIVE_VERIFICATION_STATUSES] } },
    select: { id: true, status: true },
  });

  await Promise.all([mtnQueue.drain(true), n2bPollQueue.drain(true)]);
  if (!active) return dispatchNextQueuedList();
  if (active.status === "running_mtn") await enqueuePendingRows(active.id);
  if (active.status === "running_n2b") await resumeInFlightN2bBatch(active.id);
  return active.id;
}

async function continueQueueAfterRelease() {
  try {
    // Completing/deleting a non-owner (for example a queued list or the
    // isolated smoke fixture) must never drain the real owner's jobs.
    const activeOwners = await prisma.list.count({
      where: { status: { in: [...ACTIVE_VERIFICATION_STATUSES] } },
    });
    if (activeOwners > 0) return;

    // Waiting/delayed entries belong to the list that just released the
    // slot. Active calls cannot be cancelled safely; dispatch waits for their
    // completion event before promoting the next list.
    await Promise.all([mtnQueue.drain(true), n2bPollQueue.drain(true)]);
    await dispatchNextQueuedList();
  } catch (err) {
    // The list that just reached a durable terminal state must stay terminal
    // even if Redis is briefly unavailable. Worker startup retries dispatch.
    console.error("[pipeline] could not dispatch the next queued list", err);
  }
}

// ---------- Terminal state transitions ----------
//
// Every route into a terminal state goes through one of these, so an alert
// cannot be forgotten by a future call site. Alerting is best-effort and
// never blocks the state change itself.

// Fails a list, and self-heals it if the failure looks transient. A network
// blip or a provider 5xx/429 gets retried on a backoff schedule without
// anyone having to notice and click Retry; anything else (a bad key, a
// malformed request) goes straight to a person, since retrying the same
// input just produces the same failure again later.
//
// Guarded with an atomic updateMany rather than a plain update: several rows
// can fail for the same reason at once (every in-flight check during an
// outage), and this must transition and schedule exactly one retry, not one
// per row.
async function markFailed(listId: string, error: string, opts: { retryable?: boolean } = {}) {
  const retryable = opts.retryable ?? false;

  const current = await prisma.list.findUnique({
    where: { id: listId },
    select: { autoRetryCount: true },
  });
  if (!current) return;

  const attempt = current.autoRetryCount + 1;
  const willAutoRetry = retryable && config.autoRetry.enabled && attempt <= config.autoRetry.maxAttempts;
  const delay = willAutoRetry ? autoRetryDelayMs(attempt) : null;

  const transitioned = await prisma.list.updateMany({
    where: { id: listId, status: { in: ["pending", "running_mtn", "running_n2b"] } },
    data: {
      status: "failed",
      lastError: error,
      retryable,
      autoRetryCount: willAutoRetry ? attempt : current.autoRetryCount,
      nextAutoRetryAt: delay !== null ? new Date(Date.now() + delay) : null,
    },
  });
  // A racing failure for the same list already handled this transition.
  if (transitioned.count === 0) return;

  await continueQueueAfterRelease();

  if (willAutoRetry && delay !== null) {
    await listRetryQueue.add(
      "retry",
      { listId },
      { delay, removeOnComplete: true, removeOnFail: true }
    );
    console.log(
      `[pipeline] list ${listId} failed (retryable), auto-retry ${attempt}/${config.autoRetry.maxAttempts} in ${Math.round(delay / 1000)}s`
    );
    // Self-healing is in progress -- do not page anyone for what may just
    // be a blip. If it keeps failing, later attempts still alert once the
    // budget above is exhausted.
    return;
  }

  const list = await prisma.list.findUnique({ where: { id: listId }, include: { client: true } });
  if (!list) return;
  await sendAlert({ type: "list_failed", listId, listName: list.name, clientName: list.client.name, error });
}

async function markCompleted(listId: string) {
  const list = await prisma.list.update({
    where: { id: listId },
    data: {
      status: "completed",
      completedAt: new Date(),
      lastError: null,
      // The list made it, so whatever retry budget it had used is no longer
      // relevant -- a future failure starts counting fresh.
      retryable: false,
      autoRetryCount: 0,
      nextAutoRetryAt: null,
    },
    include: { client: true },
  });
  await continueQueueAfterRelease();
  const [valid, spend] = await Promise.all([
    prisma.listRow.count({ where: { listId, finalStatus: "valid" } }),
    prisma.creditLedger.aggregate({ _sum: { amount: true }, where: { listId, provider: "n2b" } }),
  ]);
  await sendAlert({
    type: "list_completed",
    listId,
    listName: list.name,
    clientName: list.client.name,
    totalRows: list.totalRows,
    valid,
    creditsSpent: spend._sum.amount ?? 0,
  });
}

// ---------- Ingest ----------

export async function ingestList(params: {
  clientId: string;
  name: string;
  sourceFileName: string;
  fileContents: string;
}) {
  const { headers, rows, stats } = parseEmailCsv(params.fileContents);
  if (rows.length === 0) {
    throw new Error("No valid email rows found in the uploaded file");
  }

  const list = await prisma.list.create({
    data: {
      clientId: params.clientId,
      name: params.name,
      sourceFileName: params.sourceFileName,
      totalRows: rows.length,
      sourceRowCount: stats.dataRows,
      skippedInvalid: stats.invalidSyntax,
      skippedDupes: stats.duplicates,
      columnHeaders: headers,
      status: "pending",
    },
  });

  await prisma.listRow.createMany({
    data: rows.map((p) => ({
      listId: list.id,
      rawEmail: p.rawEmail,
      normalizedEmail: p.normalizedEmail,
      rawRow: p.rawRow,
    })),
  });

  // Resolve what's already known so the pre-flight summary can show it, but
  // stop there: nothing runs until the upload has been reviewed and started.
  await runCachePass(list.id);
  await resolveFromDomainFacts(list.id, ["pending"]);

  return list;
}

// Begins the cheap pass for a list sitting at the pre-flight summary. This
// is the last point at which a person is asked anything: from here the list
// runs through Mail Tester Ninja and straight on to No2Bounce.
export async function startVerification(listId: string, startedById?: string) {
  // Batches are submitted later, asynchronously, by the worker -- which has
  // no session to ask. Record who authorised the run now, so every credit
  // this list goes on to spend is attributable. Every approved list enters
  // the FIFO first; the dispatcher promotes exactly one when the global slot
  // is free. updateMany makes a double click idempotent.
  const queued = await prisma.list.updateMany({
    where: { id: listId, status: "pending" },
    data: {
      status: "queued",
      queuedAt: new Date(),
      ...(startedById ? { startedById } : {}),
    },
  });
  if (queued.count === 0) return;

  await dispatchNextQueuedList();
}

const CACHE_HIT_MAP: Record<string, FinalStatus> = {
  valid: "valid",
  invalid: "invalid",
  risky: "risky",
};

// Free pass 0: resolve rows against the global EmailCache before spending
// anything on either provider.
async function runCachePass(listId: string) {
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  // A TTL of 0 puts the cutoff at "now", which nothing can satisfy -- that
  // is how MTN reuse is switched off by default.
  const n2bCutoff = days(config.n2bCacheTtlDays);
  const mtnCutoff = days(config.mtnCacheTtlDays);

  const rows = await prisma.listRow.findMany({
    where: { listId, stage: "pending" },
    select: { id: true, normalizedEmail: true },
  });
  if (rows.length === 0) return;

  const emails = rows.map((r) => r.normalizedEmail);
  const cacheEntries = await prisma.emailCache.findMany({
    where: { normalizedEmail: { in: emails } },
  });
  const cacheByEmail = new Map(cacheEntries.map((c) => [c.normalizedEmail, c]));

  for (const row of rows) {
    const entry = cacheByEmail.get(row.normalizedEmail);
    if (!entry) continue;

    const n2bFresh =
      entry.lastN2bResult && entry.lastN2bCheckedAt && entry.lastN2bCheckedAt >= n2bCutoff;
    const mtnFresh =
      config.mtnCacheTtlDays > 0 &&
      entry.lastMtnResult &&
      entry.lastMtnCheckedAt &&
      entry.lastMtnCheckedAt >= mtnCutoff;

    // A previous N2B verdict is authoritative -- it is the answer the paid
    // pass would give, so reuse it and charge nothing.
    if (n2bFresh) {
      const finalStatus = CACHE_HIT_MAP[entry.lastN2bResult!];
      if (finalStatus) {
        await prisma.listRow.update({
          where: { id: row.id },
          data: { stage: "cache_hit", finalStatus, finalSource: "cache" },
        });
      }
      continue;
    }

    if (!mtnFresh) continue;
    const cachedMtn = CACHE_HIT_MAP[entry.lastMtnResult!];
    if (!cachedMtn) continue;

    // Only settle from a cached MTN verdict where a live MTN call would also
    // have settled it. Otherwise skip the redundant MTN call but still send
    // the row to the paid pass -- the cache must not quietly bypass the
    // escalation policy.
    const settled = settleMtnOutcome(cachedMtn === "valid" ? "valid" : "invalid");
    await prisma.listRow.update({
      where: { id: row.id },
      data: settled
        ? { stage: "cache_hit", finalStatus: settled, finalSource: "cache" }
        : {
            stage: "needs_n2b",
            mtnStatus: "cache",
            mtnMessage: `Cached MTN result: ${cachedMtn}`,
          },
    });
  }
}

// Settles rows whose domain already answers for them -- a domain with no MX
// cannot deliver to any address, and a confirmed catch-all can only ever
// answer "accept-all". Runs before both providers, so these cost nothing at
// all rather than one credit each.
async function resolveFromDomainFacts(
  listId: string,
  stages: ("pending" | "needs_n2b")[]
): Promise<number> {
  const rows = await prisma.listRow.findMany({
    where: { listId, stage: { in: stages } },
    select: { id: true, normalizedEmail: true },
  });
  if (rows.length === 0) return 0;

  const facts = await loadDomainFacts(rows.map((r) => domainOf(r.normalizedEmail)));
  if (facts.size === 0) return 0;

  let resolved = 0;
  for (const row of rows) {
    const verdict = verdictFromDomain(facts.get(domainOf(row.normalizedEmail)));
    if (!verdict) continue;

    await prisma.listRow.update({
      where: { id: row.id },
      data: {
        stage: "mtn_done",
        finalStatus: verdict.status,
        finalSource: "cache",
        mtnStatus: "domain",
        mtnMessage: verdict.reason,
      },
    });
    resolved++;
  }
  return resolved;
}

async function enqueuePendingRows(listId: string): Promise<number> {
  const pending = await prisma.listRow.findMany({
    where: { listId, stage: "pending" },
    select: { id: true, normalizedEmail: true },
  });

  if (pending.length === 0) {
    // Nothing left for the cheap pass. Rows the cache sent straight to the
    // paid pass still have to be submitted, so settle the list through the
    // normal finalize path rather than calling it done.
    await prisma.list.update({ where: { id: listId }, data: { status: "running_mtn" } });
    await maybeFinalizeMtnPass(listId);
    return 0;
  }

  await prisma.list.update({ where: { id: listId }, data: { status: "running_mtn" } });

  await mtnQueue.addBulk(
    pending.map((row) => ({
      name: "verify",
      data: { listRowId: row.id, listId, email: row.normalizedEmail },
      opts: {
        jobId: mtnJobId(row.id),
        attempts: config.mtn.maxRetries,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    }))
  );

  // If every bulk entry was already present, BullMQ may not recreate the
  // marker that wakes a blocked worker. A no-op job always supplies one and
  // is discarded before the provider call in worker/index.ts.
  await mtnQueue.add(
    "wake",
    { listRowId: "", listId, email: "" },
    {
      jobId: `wake-${listId}-${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: true,
    }
  );

  return pending.length;
}

// Rows waiting on N2B were parked there by whatever classification rules
// were current when they ran. Re-apply today's rules to the MTN reply we
// already stored: if MTN had in fact answered definitively (an earlier bug
// mis-parked "No MX" replies, for one), resolve the row for free instead of
// paying the expensive provider to re-answer it.
async function reclassifyParkedRows(listId: string) {
  // Rows parked with a transport error were never actually checked by MTN --
  // an earlier bug escalated those instead of retrying them. Send them back
  // to the cheap pass rather than billing the paid provider for an answer
  // nobody ever asked for.
  await prisma.listRow.updateMany({
    where: { listId, stage: "needs_n2b", mtnStatus: "error" },
    data: { stage: "pending" },
  });

  const parked = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b", mtnMessage: { not: null } },
    select: { id: true, normalizedEmail: true, mtnMessage: true, mtnStatus: true },
  });

  for (const row of parked) {
    const outcome = classifyMtnResult(row.mtnStatus ?? "", row.mtnMessage!);
    if (outcome !== "valid" && outcome !== "invalid") continue;

    const settled = settleMtnOutcome(outcome);
    if (!settled) continue;

    await prisma.listRow.update({
      where: { id: row.id },
      data: { stage: "mtn_done", finalStatus: settled, finalSource: "mtn" },
    });
    await upsertEmailCache(row.normalizedEmail, { mtnResult: outcome });
  }
}

// Resume a list that stopped partway (a provider outage, a bad key that has
// since been fixed). Picks up from whatever stage each row actually reached,
// so already-verified rows are never re-checked or re-paid for.
export async function retryList(listId: string) {
  const list = await prisma.list.findUnique({ where: { id: listId }, select: { status: true } });
  if (!list || (list.status !== "failed" && list.status !== "stopped")) return;

  // nextAutoRetryAt is cleared because the retry is happening now, not
  // pending; autoRetryCount is left alone so the backoff schedule continues
  // from where it was if this attempt fails again too.
  await prisma.list.update({
    where: { id: listId },
    data: { lastError: null, nextAutoRetryAt: null },
  });

  // Re-apply current rules first: this can hand rows back to the cheap pass
  // (never-reached rows) or resolve them outright, so it has to run before
  // deciding what still needs doing.
  await reclassifyParkedRows(listId);

  const stillPending = await prisma.listRow.count({ where: { listId, stage: "pending" } });
  const needsN2b = await prisma.listRow.count({ where: { listId, stage: "needs_n2b" } });

  if (stillPending === 0 && needsN2b === 0) {
    await markCompleted(listId);
    return;
  }

  // A retry/resume is approved work just like a fresh Start. It rejoins the
  // FIFO and cannot bypass whichever list currently owns the pipeline.
  const requeued = await prisma.list.updateMany({
    where: { id: listId, status: { in: ["failed", "stopped"] } },
    data: { status: "queued", queuedAt: new Date() },
  });
  if (requeued.count === 0) return;
  await dispatchNextQueuedList();
}

// ---------- MTN pass resolution ----------

export async function recordMtnResult(params: {
  listRowId: string;
  listId: string;
  normalizedEmail: string;
  mtnStatus: string;
  mtnMessage: string;
  outcome: "valid" | "invalid" | "ambiguous";
}) {
  const finalStatus = settleMtnOutcome(params.outcome);
  const stage = finalStatus ? "mtn_done" : "needs_n2b";

  await prisma.listRow.update({
    where: { id: params.listRowId },
    data: {
      stage,
      mtnStatus: params.mtnStatus,
      mtnMessage: params.mtnMessage,
      mtnCheckedAt: new Date(),
      mtnAttempts: { increment: 1 },
      ...(finalStatus ? { finalStatus, finalSource: "mtn" as ResultSource } : {}),
    },
  });

  // Cache what MTN concluded even when the row escalates -- it is still a
  // real observation about the address, and it lets a later list skip the
  // MTN call and go straight to the paid pass.
  const mtnVerdict = mtnVerdictFor(params.outcome);
  if (mtnVerdict) {
    await upsertEmailCache(params.normalizedEmail, { mtnResult: mtnVerdict });
  }

  // Record what the reply says about the domain itself. "No MX" is
  // conclusive for every address there; catch-all is stored as a hint from
  // MTN, to be confirmed by the paid pass before it is used to skip checks.
  const domain = domainOf(params.normalizedEmail);
  const message = params.mtnMessage.trim().toLowerCase();
  if (message === "no mx") {
    await recordDomainFact(domain, { hasNoMx: true });
  } else if (message === "catch-all") {
    await recordDomainFact(domain, { isCatchAll: true, source: "mtn" });
  } else if (params.outcome === "valid" || params.outcome === "invalid") {
    // A specific accept/reject proves the server distinguishes mailboxes,
    // so it is not a catch-all and does have an MX.
    await recordDomainFact(domain, { hasNoMx: false });
  }

  await maybeFinalizeMtnPass(params.listId);
}

// What MTN itself concluded about the address, independent of whether the
// row goes on to the paid pass.
function mtnVerdictFor(outcome: "valid" | "invalid" | "ambiguous"): FinalStatus | null {
  if (outcome === "valid") return "valid";
  if (outcome === "invalid") return "invalid";
  return null;
}

// Whether MTN's verdict is the final word for this row, or whether it hands
// on to the paid pass. Returns null to escalate.
//
// Only what MTN could not answer is worth paying for -- Catch-All, and the
// results it retried and still could not resolve (SPAM Block, Timeout, MX
// Error, Limited). Its "Rejected" and "No MX" are conclusive: the server
// refused the address, or the domain cannot receive mail at all. Buying a
// second opinion on those spends a credit to be told the same thing.
function settleMtnOutcome(outcome: "valid" | "invalid" | "ambiguous"): FinalStatus | null {
  if (outcome === "valid") return "valid";
  if (outcome === "invalid") return "invalid";

  // Catch-all.
  return config.catchAllHandling === "accept" ? "risky" : null;
}

// An account-level MTN failure (bad/disabled key, exhausted quota) says
// nothing about the addresses themselves. Stop the whole list so a
// misconfiguration can't quietly escalate every row to the paid provider.
export async function failListFromMtn(listId: string, mtnMessage: string) {
  // Auto-retried, despite the "fatal" name: in practice "Disabled Key" has
  // turned out to be an intermittent response from MTN's side rather than
  // an actually-revoked key -- manually retrying the identical key resolves
  // it. What "fatal" still guarantees is the important half: this never
  // escalates a single row to the paid provider while it's happening, no
  // matter how many rounds it takes to clear. MTN calls cost nothing, so
  // there is no downside to retrying here; if a key genuinely is dead, the
  // attempt budget below still bounds it and alerts once exhausted.
  await markFailed(
    listId,
    `Mail Tester Ninja rejected the request: "${mtnMessage}". No rows were escalated to No2Bounce.`,
    { retryable: true }
  );
}

// True when the list is gone, stopped or failed -- either way its queued
// jobs should be dropped rather than processed.
export async function isListInactive(listId: string) {
  const list = await prisma.list.findUnique({ where: { id: listId }, select: { status: true } });
  return (
    list === null || list.status === "queued" || list.status === "failed" || list.status === "stopped"
  );
}

// Halts either the active list or an approved list waiting in the FIFO.
// Everything already verified is kept, and resuming rejoins the queue.
export async function stopList(listId: string) {
  const stopped = await prisma.list.updateMany({
    where: { id: listId, status: { in: ["queued", "running_mtn", "running_n2b"] } },
    data: {
      status: "stopped",
      queuedAt: null,
      lastError: "Stopped manually. Results so far are kept — resume to continue.",
      // A deliberate stop is not the auto-retry system's business -- clear
      // its bookkeeping so the UI does not suggest a retry is still pending.
      // A scheduled retry job that fires anyway is a no-op: the worker only
      // acts on lists it finds still sitting in "failed".
      retryable: false,
      autoRetryCount: 0,
      nextAutoRetryAt: null,
    },
  });
  if (stopped.count > 0) await continueQueueAfterRelease();
}

// Removes the prospect data (the personal data, and the point of deleting)
// along with its rows and batches. Credit history is deliberately retained
// -- see the CreditLedger model. Jobs still queued for this list drain
// harmlessly via isListInactive.
export async function deleteList(listId: string) {
  await prisma.list.delete({ where: { id: listId } });
  await continueQueueAfterRelease();
}

// MTN was never reached for this row (DNS, TLS, socket, timeout). Leave it
// pending so a retry re-runs the cheap pass on it, and stop the list so the
// cause gets fixed -- never escalate it, because charging the paid provider
// for a row the cheap pass never actually checked is money spent on nothing.
export async function recordMtnUnreachable(params: {
  listRowId: string;
  listId: string;
  message: string;
}) {
  await prisma.listRow.update({
    where: { id: params.listRowId },
    data: {
      stage: "pending",
      mtnStatus: "error",
      mtnMessage: params.message,
      mtnAttempts: { increment: 1 },
    },
  });

  // This is the textbook transient case -- DNS, TLS, socket, timeout -- so
  // it self-heals via markFailed's auto-retry rather than needing a click.
  await markFailed(
    params.listId,
    `Could not reach Mail Tester Ninja (${params.message}). No rows were charged to No2Bounce. Unchecked rows re-run on the cheap pass automatically once it retries.`,
    { retryable: true }
  );
}

// Rows that exhausted MTN retries on a transient error also fall through to N2B.
export async function recordMtnExhausted(params: {
  listRowId: string;
  listId: string;
  mtnStatus: string;
  mtnMessage: string;
}) {
  await prisma.listRow.update({
    where: { id: params.listRowId },
    data: {
      stage: "needs_n2b",
      mtnStatus: params.mtnStatus,
      mtnMessage: params.mtnMessage,
      mtnCheckedAt: new Date(),
      mtnAttempts: { increment: 1 },
    },
  });
  await maybeFinalizeMtnPass(params.listId);
}

async function maybeFinalizeMtnPass(listId: string) {
  const remaining = await prisma.listRow.count({ where: { listId, stage: "pending" } });
  if (remaining > 0) return;

  // Atomic claim: only the caller that wins this transition proceeds to
  // finalize, preventing double-submission when multiple queue jobs finish
  // at nearly the same time.
  const claim = await prisma.list.updateMany({
    where: { id: listId, status: "running_mtn" },
    data: { status: "running_n2b" },
  });
  if (claim.count === 0) return;

  await finalizeMtnPass(listId);
}

// The cheap pass is done. Whatever it could not answer goes straight on to
// No2Bounce -- there is no checkpoint here. The spend was authorised when
// the run was started, and the rows that reach this point are only the ones
// MTN genuinely could not resolve.
async function finalizeMtnPass(listId: string) {
  // A list that was already in N2B when the serial scheduler was introduced
  // may have been queued behind another active list. Resume its paid batch;
  // never submit and charge for the same rows a second time.
  if (await resumeInFlightN2bBatch(listId)) return;

  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true, mtnMessage: true },
  });

  if (needsN2b.length === 0) {
    await markCompleted(listId);
    return;
  }

  await submitN2bBatch(listId, needsN2b);
}

// Close out a list using only what the cheap pass established, spending
// nothing further. This is the escape hatch: a provider being unreachable,
// or simply not being worth the spend, must never leave a list stranded.
export async function finishWithoutN2b(listId: string) {
  const parked = await prisma.listRow.findMany({
    where: { listId, stage: { in: ["needs_n2b", "pending"] } },
    select: { id: true, mtnMessage: true, mtnStatus: true },
  });

  for (const row of parked) {
    // Fall back to whatever MTN actually said rather than blanket "unknown":
    // a row it called Rejected really is invalid on the evidence we have, a
    // catch-all domain is genuinely risky, and only rows it never answered
    // are truly unknown.
    const outcome = row.mtnMessage
      ? classifyMtnResult(row.mtnStatus ?? "", row.mtnMessage)
      : "transient";
    const finalStatus: FinalStatus =
      outcome === "valid"
        ? "valid"
        : outcome === "invalid"
          ? "invalid"
          : outcome === "ambiguous"
            ? "risky"
            : "unknown";

    await prisma.listRow.update({
      where: { id: row.id },
      data: { stage: "mtn_done", finalStatus, finalSource: "mtn" },
    });
  }

  await markCompleted(listId);
}

// Chooses which of the parked rows actually need paying for.
//
// Where the cheap pass called every address at a domain catch-all, they will
// all come back accept-all -- so one address establishes the answer for the
// whole domain and the rest are held back. If the probe disproves catch-all,
// the held rows are simply submitted in the following batch, so nothing is
// lost either way. This converges in at most two rounds per domain.
async function selectRowsToCharge<
  T extends { id: string; normalizedEmail: string; mtnMessage: string | null },
>(rows: T[], forceChargeAll: boolean): Promise<T[]> {
  if (forceChargeAll) return rows;

  const facts = await loadDomainFacts(rows.map((r) => domainOf(r.normalizedEmail)));
  const charge: T[] = [];
  const probed = new Set<string>();

  for (const row of rows) {
    const domain = domainOf(row.normalizedEmail);
    const suspectedCatchAll = (row.mtnMessage ?? "").trim().toLowerCase() === "catch-all";
    const known = facts.get(domain);

    // A specific mailbox answer cannot be generalised from a neighbour, and
    // a domain already shown not to be catch-all has nothing left to probe
    // for -- both are charged individually.
    if (!suspectedCatchAll || known?.isCatchAll === false) {
      charge.push(row);
      continue;
    }

    if (probed.has(domain)) continue; // held: the probe will answer for it
    probed.add(domain);
    charge.push(row);
  }

  return charge;
}

async function submitN2bBatch(
  listId: string,
  rows: { id: string; normalizedEmail: string; mtnMessage: string | null }[]
) {
  // Safety net: probing converges in two rounds per domain, so a third
  // batch means something unforeseen. Charge everything rather than risk
  // looping while a list never finishes.
  const priorBatches = await prisma.n2bBatch.count({ where: { listId } });
  const charge = await selectRowsToCharge(rows, priorBatches >= 2);
  const emails = charge.map((r) => r.normalizedEmail);

  if (emails.length === 0) {
    await markCompleted(listId);
    return;
  }

  let trackingId: string;
  try {
    ({ trackingId } = await n2bClient.submitBulk(emails));
  } catch (err) {
    // A rejected/failed API call must never take the whole worker process
    // down with it -- fail just this list and keep processing everything
    // else. Whether it retries itself depends on what kind of failure this
    // was: a network blip or a provider 5xx auto-heals, a rejected request
    // shape (like the hashkey field this API refuses) needs a code fix and
    // would fail identically on a retry.
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(listId, message, { retryable: isRetryableFailure(err) });
    return;
  }

  const batch = await prisma.n2bBatch.create({
    data: {
      listId,
      trackingId,
      emailCount: emails.length,
      status: "submitted",
    },
  });

  // Attribution is read from the list rather than passed in, because
  // follow-up batches (the second domain-probe round, or a resumed retry)
  // are submitted by the worker, which has no session to ask.
  const list = await prisma.list.findUnique({
    where: { id: listId },
    select: { name: true, startedById: true },
  });
  await prisma.creditLedger.create({
    data: {
      listId,
      listName: list?.name ?? "",
      userId: list?.startedById ?? null,
      provider: "n2b",
      amount: emails.length,
    },
  });

  await n2bPollQueue.add(
    "poll",
    { batchId: batch.id },
    { delay: config.n2b.pollIntervalMs, removeOnComplete: true, removeOnFail: true }
  );
}

// ---------- N2B pass resolution ----------

export async function pollN2bBatchOnce(batchId: string) {
  const batch = await prisma.n2bBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { list: { select: { status: true } } },
  });
  // Historical poll jobs for a queued/stopped/completed list are harmless.
  // The scheduler re-adds the poll when that list owns the global slot.
  if (batch.list.status !== "running_n2b") return;

  // poll() downloads the result file once the batch finishes, so it can fail
  // on the network too. Treat that like any other provider failure rather
  // than letting it escape into the queue.
  let result: Awaited<ReturnType<typeof n2bClient.poll>>;
  try {
    result = await n2bClient.poll(batch.trackingId);
  } catch (err) {
    result = { state: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  await prisma.n2bBatch.update({ where: { id: batchId }, data: { lastPolledAt: new Date() } });

  if (result.state === "in_progress") {
    await n2bPollQueue.add(
      "poll",
      { batchId },
      { delay: config.n2b.pollIntervalMs, removeOnComplete: true, removeOnFail: true }
    );
    return;
  }

  if (result.state === "failed") {
    await prisma.n2bBatch.update({
      where: { id: batchId },
      data: { status: "failed", error: result.error },
    });
    await markFailed(batch.listId, result.error, { retryable: isRetryableFailure(result.error) });
    return;
  }

  // Stop/failure can release the slot while this HTTP poll is in flight.
  // Never apply that late reply to a list that no longer owns the pipeline.
  const stillOwnsSlot = await prisma.list.count({
    where: { id: batch.listId, status: "running_n2b" },
  });
  if (stillOwnsSlot === 0) return;

  await applyN2bResults(batch.listId, batchId, result.rows, undefined);
}

async function applyN2bResults(
  listId: string,
  batchId: string,
  rows: N2bRowResult[],
  resultUrl: string | undefined
) {
  const byEmail = new Map(rows.map((r) => [r.email.trim().toLowerCase(), r]));

  // Record what the report says about each domain first. Its catch-all flag
  // is the authoritative one, and it is what lets rows held back from this
  // batch resolve below without ever being charged.
  for (const r of rows) {
    if (r.catchAll === null) continue;
    await recordDomainFact(domainOf(r.email.trim().toLowerCase()), {
      isCatchAll: r.catchAll,
      source: "n2b",
    });
  }

  const listRows = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true, mtnMessage: true },
  });

  for (const row of listRows) {
    const result = byEmail.get(row.normalizedEmail);
    // Rows held back for a domain probe were never submitted, so there is
    // no verdict for them here. Leaving them alone lets the domain answer
    // for them a few lines down; marking them "unknown" would throw away
    // the whole point of holding them.
    if (!result) continue;

    await prisma.listRow.update({
      where: { id: row.id },
      data: {
        stage: "n2b_done",
        n2bStatus: result.rawStatus,
        n2bCheckedAt: new Date(),
        finalStatus: result.status,
        finalSource: "n2b",
      },
    });

    await upsertEmailCache(row.normalizedEmail, { n2bResult: result.status });
  }

  await prisma.n2bBatch.update({
    where: { id: batchId },
    data: { status: "completed", completedAt: new Date(), resultUrl: resultUrl ?? null },
  });

  // Held rows whose domain the probe has now settled resolve for free.
  await resolveFromDomainFacts(listId, ["needs_n2b"]);

  // Anything still parked means a probe disproved catch-all for its domain,
  // so those addresses do need checking individually after all.
  const stillParked = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true, mtnMessage: true },
  });
  if (stillParked.length > 0) {
    await submitN2bBatch(listId, stillParked);
    return;
  }

  await markCompleted(listId);
}

async function upsertEmailCache(
  normalizedEmail: string,
  result: { mtnResult?: FinalStatus; n2bResult?: FinalStatus }
) {
  await prisma.emailCache.upsert({
    where: { normalizedEmail },
    create: {
      normalizedEmail,
      ...(result.mtnResult ? { lastMtnResult: result.mtnResult, lastMtnCheckedAt: new Date() } : {}),
      ...(result.n2bResult ? { lastN2bResult: result.n2bResult, lastN2bCheckedAt: new Date() } : {}),
    },
    update: {
      ...(result.mtnResult ? { lastMtnResult: result.mtnResult, lastMtnCheckedAt: new Date() } : {}),
      ...(result.n2bResult ? { lastN2bResult: result.n2bResult, lastN2bCheckedAt: new Date() } : {}),
    },
  });
}
