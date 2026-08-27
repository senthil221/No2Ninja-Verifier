import { prisma } from "./prisma";
import { config } from "./config";
import { parseEmailCsv } from "./csv";
import { mtnQueue, n2bPollQueue } from "./queue";
import { n2bClient, type N2bRowResult } from "./n2b";
import { classifyMtnResult } from "./mtn";
import { sendAlert } from "./alerts";
import type { FinalStatus, ResultSource } from "@prisma/client";

// ---------- Terminal state transitions ----------
//
// Every route into a terminal state goes through one of these, so an alert
// cannot be forgotten by a future call site. Alerting is best-effort and
// never blocks the state change itself.

async function markFailed(listId: string, error: string) {
  const list = await prisma.list.update({
    where: { id: listId },
    data: { status: "failed", lastError: error },
    include: { client: true },
  });
  await sendAlert({
    type: "list_failed",
    listId,
    listName: list.name,
    clientName: list.client.name,
    error,
  });
}

async function markNeedsApproval(listId: string, creditsRequired: number) {
  const list = await prisma.list.update({
    where: { id: listId },
    data: { status: "needs_approval" },
    include: { client: true },
  });
  const resolved = await prisma.listRow.count({
    where: { listId, finalStatus: { not: null } },
  });
  await sendAlert({
    type: "needs_decision",
    listId,
    listName: list.name,
    clientName: list.client.name,
    resolved,
    totalRows: list.totalRows,
    creditsRequired,
  });
}

async function markCompleted(listId: string) {
  const list = await prisma.list.update({
    where: { id: listId },
    data: { status: "completed", completedAt: new Date(), lastError: null },
    include: { client: true },
  });
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

  return list;
}

// Begins the cheap pass for a list sitting at the pre-flight summary.
export async function startVerification(listId: string) {
  const list = await prisma.list.findUnique({
    where: { id: listId },
    select: { status: true },
  });
  if (!list || list.status !== "pending") return;

  await enqueuePendingRows(listId);
}

const CACHE_HIT_MAP: Record<string, FinalStatus> = {
  valid: "valid",
  invalid: "invalid",
  risky: "risky",
};

// Free pass 0: resolve rows against the global EmailCache before spending
// anything on either provider.
async function runCachePass(listId: string) {
  const cutoff = new Date(Date.now() - config.emailCacheTtlDays * 24 * 60 * 60 * 1000);
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
      entry.lastN2bResult && entry.lastN2bCheckedAt && entry.lastN2bCheckedAt >= cutoff;
    const mtnFresh =
      entry.lastMtnResult && entry.lastMtnCheckedAt && entry.lastMtnCheckedAt >= cutoff;

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

async function enqueuePendingRows(listId: string) {
  const pending = await prisma.listRow.findMany({
    where: { listId, stage: "pending" },
    select: { id: true, normalizedEmail: true },
  });

  if (pending.length === 0) {
    // Nothing left for the cheap pass. Rows the cache sent straight to the
    // paid pass still have to reach the review gate, so settle the list
    // through the normal finalize path rather than calling it done.
    await prisma.list.update({ where: { id: listId }, data: { status: "running_mtn" } });
    await maybeFinalizeMtnPass(listId);
    return;
  }

  await prisma.list.update({ where: { id: listId }, data: { status: "running_mtn" } });

  await mtnQueue.addBulk(
    pending.map((row) => ({
      name: "verify",
      data: { listRowId: row.id, listId, email: row.normalizedEmail },
      opts: {
        attempts: config.mtn.maxRetries,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    }))
  );
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

    // Respect the current escalation policy: under all_except_valid an
    // "invalid" row stays parked for its second opinion.
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
  await prisma.list.update({ where: { id: listId }, data: { lastError: null } });

  // Re-apply current rules first: this can hand rows back to the cheap pass
  // (never-reached rows) or resolve them outright, so it has to run before
  // deciding what still needs doing.
  await reclassifyParkedRows(listId);

  const stillPending = await prisma.listRow.count({ where: { listId, stage: "pending" } });
  if (stillPending > 0) {
    await enqueuePendingRows(listId);
    return;
  }

  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  if (needsN2b.length === 0) {
    await markCompleted(listId);
    return;
  }

  await prisma.list.update({ where: { id: listId }, data: { status: "running_n2b" } });
  await submitN2bBatch(listId, needsN2b);
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
function settleMtnOutcome(outcome: "valid" | "invalid" | "ambiguous"): FinalStatus | null {
  if (outcome === "valid") return "valid";

  if (outcome === "invalid") {
    // Under all_except_valid, MTN's "invalid" is treated as an opinion to be
    // confirmed rather than a conclusion, so the row escalates.
    return config.mtnEscalationPolicy === "all_except_valid" ? null : "invalid";
  }

  // Catch-all.
  return config.catchAllHandling === "accept" ? "risky" : null;
}

// An account-level MTN failure (bad/disabled key, exhausted quota) says
// nothing about the addresses themselves. Stop the whole list so a
// misconfiguration can't quietly escalate every row to the paid provider.
export async function failListFromMtn(listId: string, mtnMessage: string) {
  await markFailed(
    listId,
    `Mail Tester Ninja rejected the request: "${mtnMessage}". No rows were escalated to NeverBounce. Check MTN_API_KEY.`
  );
}

// True when the list is gone or stopped -- either way its queued jobs should
// be dropped rather than processed.
export async function isListInactive(listId: string) {
  const list = await prisma.list.findUnique({ where: { id: listId }, select: { status: true } });
  return list === null || list.status === "failed";
}

// Removes the prospect data (the personal data, and the point of deleting)
// along with its rows and batches. Credit history is deliberately retained
// -- see the CreditLedger model. Jobs still queued for this list drain
// harmlessly via isListInactive.
export async function deleteList(listId: string) {
  await prisma.list.delete({ where: { id: listId } });
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

  const error = `Could not reach Mail Tester Ninja (${params.message}). No rows were charged to NeverBounce. Retry once connectivity is restored — unchecked rows will re-run on the cheap pass.`;

  // Conditional update is the transition itself: once the list is "failed"
  // it no longer matches, so an outage affecting thousands of rows moves it
  // once and alerts once rather than per row.
  const transitioned = await prisma.list.updateMany({
    where: { id: params.listId, status: { in: ["running_mtn", "running_n2b"] } },
    data: { status: "failed", lastError: error },
  });
  if (transitioned.count === 0) return;

  const list = await prisma.list.findUnique({
    where: { id: params.listId },
    include: { client: true },
  });
  if (list) {
    await sendAlert({
      type: "list_failed",
      listId: params.listId,
      listName: list.name,
      clientName: list.client.name,
      error,
    });
  }
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

async function finalizeMtnPass(listId: string) {
  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  if (needsN2b.length === 0) {
    await markCompleted(listId);
    return;
  }

  // Pause before spending. Credits are the expensive, irreversible part of
  // this pipeline, so the default is that a person sees what the cheap pass
  // found -- and what the paid pass would cost -- and decides.
  if (config.n2b.requireApproval || needsN2b.length > config.n2b.singleListCreditCap) {
    await markNeedsApproval(listId, needsN2b.length);
    return;
  }

  await submitN2bBatch(listId, needsN2b);
}

// Called from the UI when a paused list is approved for the paid pass.
export async function approveN2bSubmission(listId: string) {
  // Re-apply current classification first: never pay to re-ask something
  // MTN already answered definitively.
  await reclassifyParkedRows(listId);

  // Reclassifying can hand rows back to the cheap pass (ones MTN was never
  // actually reached for). Finish that before spending anything.
  const stillPending = await prisma.listRow.count({ where: { listId, stage: "pending" } });
  if (stillPending > 0) {
    await enqueuePendingRows(listId);
    return;
  }

  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  if (needsN2b.length === 0) {
    await markCompleted(listId);
    return;
  }

  await prisma.list.update({ where: { id: listId }, data: { status: "running_n2b" } });
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

async function submitN2bBatch(listId: string, rows: { id: string; normalizedEmail: string }[]) {
  const emails = rows.map((r) => r.normalizedEmail);

  let trackingId: string;
  try {
    ({ trackingId } = await n2bClient.submitBulk(emails));
  } catch (err) {
    // A rejected/failed API call must never take the whole worker process
    // down with it -- fail just this list and keep processing everything
    // else.
    await markFailed(listId, err instanceof Error ? err.message : String(err));
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

  const list = await prisma.list.findUnique({ where: { id: listId }, select: { name: true } });
  await prisma.creditLedger.create({
    data: { listId, listName: list?.name ?? "", provider: "n2b", amount: emails.length },
  });

  await n2bPollQueue.add(
    "poll",
    { batchId: batch.id },
    { delay: config.n2b.pollIntervalMs, removeOnComplete: true, removeOnFail: true }
  );
}

// ---------- N2B pass resolution ----------

export async function pollN2bBatchOnce(batchId: string) {
  const batch = await prisma.n2bBatch.findUniqueOrThrow({ where: { id: batchId } });

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
    await markFailed(batch.listId, result.error);
    return;
  }

  await applyN2bResults(batch.listId, batchId, result.rows, undefined);
}

async function applyN2bResults(
  listId: string,
  batchId: string,
  rows: N2bRowResult[],
  resultUrl: string | undefined
) {
  const byEmail = new Map(rows.map((r) => [r.email.trim().toLowerCase(), r]));

  const listRows = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  for (const row of listRows) {
    const result = byEmail.get(row.normalizedEmail);
    const finalStatus: FinalStatus = result?.status ?? "unknown";

    await prisma.listRow.update({
      where: { id: row.id },
      data: {
        stage: "n2b_done",
        n2bStatus: result?.rawStatus ?? "no_result",
        n2bCheckedAt: new Date(),
        finalStatus,
        finalSource: "n2b",
      },
    });

    await upsertEmailCache(row.normalizedEmail, { n2bResult: finalStatus });
  }

  await prisma.n2bBatch.update({
    where: { id: batchId },
    data: { status: "completed", completedAt: new Date(), resultUrl: resultUrl ?? null },
  });

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
