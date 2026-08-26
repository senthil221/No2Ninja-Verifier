import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { config } from "./config";
import { parseEmailCsv } from "./csv";
import { mtnQueue, n2bPollQueue } from "./queue";
import { n2bClient, type N2bRowResult } from "./n2b";
import type { FinalStatus, ResultSource } from "@prisma/client";

// ---------- Ingest ----------

export async function ingestList(params: {
  clientId: string;
  name: string;
  sourceFileName: string;
  fileContents: string;
}) {
  const parsed = parseEmailCsv(params.fileContents);
  if (parsed.length === 0) {
    throw new Error("No valid email rows found in the uploaded file");
  }

  const list = await prisma.list.create({
    data: {
      clientId: params.clientId,
      name: params.name,
      sourceFileName: params.sourceFileName,
      totalRows: parsed.length,
      status: "pending",
    },
  });

  await prisma.listRow.createMany({
    data: parsed.map((p) => ({
      listId: list.id,
      rawEmail: p.rawEmail,
      normalizedEmail: p.normalizedEmail,
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

  if (needsN2b.length > config.n2b.singleListCreditCap) {
    await prisma.list.update({ where: { id: listId }, data: { status: "needs_approval" } });
    return;
  }

  await submitN2bBatch(listId, needsN2b);
}

// Called from the UI when a list is paused at needs_approval because the
// Pass 2 batch would exceed the configured single-list credit cap.
export async function approveN2bSubmission(listId: string) {
  const needsN2b = await prisma.listRow.findMany({
    where: { listId, stage: "needs_n2b" },
    select: { id: true, normalizedEmail: true },
  });
  await prisma.list.update({ where: { id: listId }, data: { status: "running_n2b" } });
  await submitN2bBatch(listId, needsN2b);
}

async function submitN2bBatch(listId: string, rows: { id: string; normalizedEmail: string }[]) {
  const emails = rows.map((r) => r.normalizedEmail);
  const hashkey = randomBytes(16).toString("hex");

  const { trackingId } = await n2bClient.submitBulk(emails, hashkey);

  const batch = await prisma.n2bBatch.create({
    data: {
      listId,
      trackingId,
      hashkey,
      emailCount: emails.length,
      status: "submitted",
    },
  });

  await prisma.creditLedger.create({
    data: { listId, provider: "n2b", amount: emails.length },
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
    await prisma.list.update({ where: { id: batch.listId }, data: { status: "failed" } });
    return;
  }

  const rows: N2bRowResult[] =
    result.state === "complete_inline"
      ? result.rows
      : await n2bClient.fetchSignedUrlResults(result.signedUrl);

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
