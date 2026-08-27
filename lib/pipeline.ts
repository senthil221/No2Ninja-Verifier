import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { config } from "./config";
import { parseEmailCsv } from "./csv";
import { mtnQueue, n2bPollQueue } from "./queue";
import { n2bClient, type N2bRowResult } from "./n2b";
import { classifyMtnMessage } from "./mtn";
import type { FinalStatus, ResultSource } from "@prisma/client";

// ---------- Ingest ----------

export async function ingestList(params: {
  clientId: string;
  name: string;
  sourceFileName: string;
  fileContents: string;
}) {
  const { headers, rows } = parseEmailCsv(params.fileContents);
  if (rows.length === 0) {
    throw new Error("No valid email rows found in the uploaded file");
  }

  const list = await prisma.list.create({
    data: {
      clientId: params.clientId,
      name: params.name,
      sourceFileName: params.sourceFileName,
      totalRows: rows.length,
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

  await runCachePass(list.id);
  await enqueuePendingRows(list.id);

  return list;
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

    // Prefer the N2B result (more authoritative) if fresh, else a fresh MTN result.
    let finalStatus: FinalStatus | undefined;
    if (entry.lastN2bResult && entry.lastN2bCheckedAt && entry.lastN2bCheckedAt >= cutoff) {
      finalStatus = CACHE_HIT_MAP[entry.lastN2bResult];
    } else if (
      entry.lastMtnResult &&
      entry.lastMtnCheckedAt &&
      entry.lastMtnCheckedAt >= cutoff &&
      CACHE_HIT_MAP[entry.lastMtnResult]
    ) {
      finalStatus = CACHE_HIT_MAP[entry.lastMtnResult];
    }

    if (finalStatus) {
      await prisma.listRow.update({
        where: { id: row.id },
        data: { stage: "cache_hit", finalStatus, finalSource: "cache" },
      });
    }
  }
}

async function enqueuePendingRows(listId: string) {
  const pending = await prisma.listRow.findMany({
    where: { listId, stage: "pending" },
    select: { id: true, normalizedEmail: true },
  });

  if (pending.length === 0) {
    // Whole list resolved from cache.
    await prisma.list.update({ where: { id: listId }, data: { status: "completed", completedAt: new Date() } });
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
  const parked = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b", mtnMessage: { not: null } },
    select: { id: true, normalizedEmail: true, mtnMessage: true },
  });

  for (const row of parked) {
    const outcome = classifyMtnMessage(row.mtnMessage!);
    if (outcome !== "valid" && outcome !== "invalid") continue;

    await prisma.listRow.update({
      where: { id: row.id },
      data: { stage: "mtn_done", finalStatus: outcome, finalSource: "mtn" },
    });
    await upsertEmailCache(row.normalizedEmail, { mtnResult: outcome });
  }
}

// Resume a list that stopped partway (a provider outage, a bad key that has
// since been fixed). Picks up from whatever stage each row actually reached,
// so already-verified rows are never re-checked or re-paid for.
export async function retryList(listId: string) {
  await prisma.list.update({ where: { id: listId }, data: { lastError: null } });

  const stillPending = await prisma.listRow.count({ where: { listId, stage: "pending" } });
  if (stillPending > 0) {
    await enqueuePendingRows(listId);
    return;
  }

  await reclassifyParkedRows(listId);

  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  if (needsN2b.length === 0) {
    await prisma.list.update({
      where: { id: listId },
      data: { status: "completed", completedAt: new Date() },
    });
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
  const finalStatus: FinalStatus | null =
    params.outcome === "valid"
      ? "valid"
      : params.outcome === "invalid"
        ? "invalid"
        : config.catchAllHandling === "accept"
          ? "risky"
          : null;

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

  if (finalStatus) {
    await upsertEmailCache(params.normalizedEmail, { mtnResult: finalStatus });
  }

  await maybeFinalizeMtnPass(params.listId);
}

// An account-level MTN failure (bad/disabled key, exhausted quota) says
// nothing about the addresses themselves. Stop the whole list so a
// misconfiguration can't quietly escalate every row to the paid provider.
export async function failListFromMtn(listId: string, mtnMessage: string) {
  await prisma.list.update({
    where: { id: listId },
    data: {
      status: "failed",
      lastError: `Mail Tester Ninja rejected the request: "${mtnMessage}". No rows were escalated to NeverBounce. Check MTN_API_KEY.`,
    },
  });
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
    await prisma.list.update({
      where: { id: listId },
      data: { status: "completed", completedAt: new Date() },
    });
    return;
  }

  // Pause before spending. Credits are the expensive, irreversible part of
  // this pipeline, so the default is that a person sees what the cheap pass
  // found -- and what the paid pass would cost -- and decides.
  if (config.n2b.requireApproval || needsN2b.length > config.n2b.singleListCreditCap) {
    await prisma.list.update({ where: { id: listId }, data: { status: "needs_approval" } });
    return;
  }

  await submitN2bBatch(listId, needsN2b);
}

// Called from the UI when a paused list is approved for the paid pass.
export async function approveN2bSubmission(listId: string) {
  // Re-apply current classification first: never pay to re-ask something
  // MTN already answered definitively.
  await reclassifyParkedRows(listId);

  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });

  if (needsN2b.length === 0) {
    await prisma.list.update({
      where: { id: listId },
      data: { status: "completed", completedAt: new Date() },
    });
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
    select: { id: true, mtnMessage: true },
  });

  for (const row of parked) {
    // A catch-all domain accepted the address but guarantees nothing --
    // that is genuinely "risky", not merely unknown. Anything else went
    // unanswered, so say so rather than implying a verdict.
    const isCatchAll = (row.mtnMessage ?? "").trim().toLowerCase() === "catch-all";
    await prisma.listRow.update({
      where: { id: row.id },
      data: {
        stage: "mtn_done",
        finalStatus: isCatchAll ? "risky" : "unknown",
        finalSource: "mtn",
      },
    });
  }

  await prisma.list.update({
    where: { id: listId },
    data: { status: "completed", completedAt: new Date(), lastError: null },
  });
}

async function submitN2bBatch(listId: string, rows: { id: string; normalizedEmail: string }[]) {
  const emails = rows.map((r) => r.normalizedEmail);
  const hashkey = randomBytes(16).toString("hex");

  let trackingId: string;
  try {
    ({ trackingId } = await n2bClient.submitBulk(emails, hashkey));
  } catch (err) {
    // A rejected/failed API call must never take the whole worker process
    // down with it -- fail just this list and keep processing everything
    // else.
    await prisma.list.update({
      where: { id: listId },
      data: { status: "failed", lastError: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const batch = await prisma.n2bBatch.create({
    data: {
      listId,
      trackingId,
      hashkey,
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
  const result = await n2bClient.poll(batch.trackingId);

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
    await prisma.list.update({
      where: { id: batch.listId },
      data: { status: "failed", lastError: result.error },
    });
    return;
  }

  let rows: N2bRowResult[];
  try {
    rows =
      result.state === "complete_inline"
        ? result.rows
        : await n2bClient.fetchSignedUrlResults(result.signedUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.n2bBatch.update({ where: { id: batchId }, data: { status: "failed", error: message } });
    await prisma.list.update({ where: { id: batch.listId }, data: { status: "failed", lastError: message } });
    return;
  }

  await applyN2bResults(batch.listId, batchId, rows, result.state === "complete_signed_url" ? result.signedUrl : undefined);
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

  await prisma.list.update({
    where: { id: listId },
    data: { status: "completed", completedAt: new Date() },
  });
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
