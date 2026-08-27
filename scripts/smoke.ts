/**
 * End-to-end smoke test against the real stack.
 *
 * "Deployed" previously meant "the containers started", which is not the
 * same as "the pipeline works" -- several releases in this project started
 * cleanly and were completely broken. This drives an actual list through
 * ingest, the caches and the cheap provider, then deletes what it created.
 *
 * It does NOT spend NeverBounce credits: it stops at the review gate, which
 * is where a real list stops.
 *
 *   npm run smoke
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { ingestList, startVerification, deleteList } from "../lib/pipeline";
import { assertProviderKeysConfigured } from "../lib/config";

const CLIENT_NAME = "__smoke_test__";
const TIMEOUT_MS = 180_000;

// A never-before-seen address at a domain that is emphatically not
// catch-all. Both caches must miss it, which is what forces a real call to
// the provider -- reusing a fixed address only proves the cache works, as
// the first version of this script discovered the hard way.
const UNIQUE_MISS = `smoke-${randomBytes(8).toString("hex")}@gmail.com`;

// Already known to the caches by now. Included to prove the free paths
// still resolve it rather than paying to re-ask.
const DEAD_DOMAIN = "contact@thisdomaindoesnotexist-verifiertest.com";

const FIXTURE = `email,first_name,company
${UNIQUE_MISS},Fresh,Miss
${DEAD_DOMAIN},No,MX
${UNIQUE_MISS},Dupe,Miss
not-an-email,Bad,Syntax
`;

const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
}

async function waitForSettled(listId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await prisma.list.findUniqueOrThrow({
      where: { id: listId },
      select: { status: true },
    });
    if (list.status !== "running_mtn" && list.status !== "pending") return list.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout";
}

async function main() {
  assertProviderKeysConfigured();
  console.log("Smoke test: driving a real list through the pipeline\n");

  await cleanup();
  const client = await prisma.client.create({ data: { name: CLIENT_NAME } });
  let listId: string | null = null;

  try {
    console.log("1. Ingest and parsing");
    const list = await ingestList({
      clientId: client.id,
      name: "smoke",
      sourceFileName: "smoke.csv",
      fileContents: FIXTURE,
    });
    listId = list.id;

    check(list.totalRows === 2, `2 usable rows from 4 lines (got ${list.totalRows})`);
    check(list.skippedInvalid === 1, `1 malformed address skipped (got ${list.skippedInvalid})`);
    check(list.skippedDupes === 1, `1 duplicate skipped (got ${list.skippedDupes})`);

    console.log("\n2. Pipeline runs to a decision point");
    await startVerification(list.id);
    const status = await waitForSettled(list.id);
    check(status !== "timeout", `settled within ${TIMEOUT_MS / 1000}s (status: ${status})`);
    check(status !== "failed", "list did not fail");

    const rows = await prisma.listRow.findMany({ where: { listId: list.id } });

    console.log("\n3. The provider was actually reached");
    const fresh = rows.find((r) => r.normalizedEmail === UNIQUE_MISS);
    // A null code here means no call was made or none came back -- the
    // failure that once looked like "verification is just slow".
    check(
      !!fresh && ["ok", "ko", "mb"].includes(fresh.mtnStatus ?? ""),
      `uncached address got a real provider verdict (got "${fresh?.mtnStatus}" / "${fresh?.mtnMessage}")`
    );
    check(
      fresh?.mtnMessage?.toLowerCase() === "rejected",
      `a nonexistent Gmail mailbox is rejected (got "${fresh?.mtnMessage}")`
    );

    console.log("\n4. Free paths still resolve what is already known");
    const dead = rows.find((r) => r.normalizedEmail === DEAD_DOMAIN);
    check(
      dead?.finalStatus === "invalid",
      `a domain with no MX resolves invalid (got "${dead?.finalStatus}")`
    );
    check(
      dead?.finalSource === "cache" || dead?.mtnStatus === "ko",
      `resolved from cache or a direct verdict, not escalated (source "${dead?.finalSource}")`
    );

    console.log("\n5. Nothing was left behind or charged");
    check(rows.filter((r) => r.stage === "pending").length === 0, "no rows left unprocessed");

    const spend = await prisma.creditLedger.aggregate({
      _sum: { amount: true },
      where: { listId: list.id },
    });
    check(
      (spend._sum.amount ?? 0) === 0,
      `no credits spent reaching the review gate (spent ${spend._sum.amount ?? 0})`
    );
  } finally {
    console.log("\n6. Cleanup");
    if (listId) await deleteList(listId).catch(() => {});
    await cleanup();
    // The throwaway address would otherwise sit in the cache forever.
    await prisma.emailCache.deleteMany({ where: { normalizedEmail: UNIQUE_MISS } }).catch(() => {});
    console.log("  removed test client, list and cache entry");
  }

  console.log();
  if (failures.length > 0) {
    console.error(`SMOKE TEST FAILED -- ${failures.length} check(s) did not pass:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED -- the pipeline works end to end.");
}

async function cleanup() {
  const existing = await prisma.client.findMany({ where: { name: CLIENT_NAME } });
  for (const c of existing) {
    const lists = await prisma.list.findMany({ where: { clientId: c.id }, select: { id: true } });
    for (const l of lists) await prisma.list.delete({ where: { id: l.id } }).catch(() => {});
    await prisma.client.delete({ where: { id: c.id } }).catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error("\nSMOKE TEST ERRORED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
