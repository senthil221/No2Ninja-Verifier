/**
 * End-to-end smoke test against the real stack.
 *
 * "Deployed" previously meant "the containers started", which is not the
 * same as "the pipeline works" -- several releases in this project started
 * cleanly and were completely broken. This drives an actual list through
 * ingest and the cheap provider, then deletes what it created.
 *
 * It does NOT go through the shared BullMQ queue. That queue is production's
 * -- under real load it can hold tens of thousands of jobs, and this test's
 * own rows waiting behind them made the result depend on backlog depth, not
 * on whether the deploy actually works. (A BullMQ job priority was tried to
 * jump the queue instead; under this worker's rate-limiter configuration,
 * prioritized jobs turned out not to drain at all -- a real gap, but not
 * one worth working around here, since nothing in the product uses
 * priority.) Instead this calls mtnClient.verify() directly, the same
 * client the worker uses, and feeds the result through the exact pipeline
 * functions the worker calls in response. That is deterministic and fast,
 * and it still exercises the real integration and business logic -- what
 * differs is only that BullMQ itself, and its ordering under load, is
 * proven separately by production traffic rather than by this test.
 *
 * It does NOT spend No2Bounce credits: the fixture's addresses are both
 * ones Mail Tester Ninja settles on its own (Rejected, No MX), and that is
 * an assertion, not just an arrangement -- if either ever escalates, the
 * credit check at the end fails and says so.
 *
 *   npm run smoke
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { ingestList, recordMtnResult, deleteList } from "../lib/pipeline";
import { mtnClient, classifyMtnResult } from "../lib/mtn";
import { assertProviderKeysConfigured } from "../lib/config";

const CLIENT_NAME = "__smoke_test__";

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

    console.log("\n2. The provider is reachable and classified correctly");
    // Called directly rather than through the queue -- see the file header.
    // This is the exact call the worker makes for every row. MTN itself is
    // occasionally flaky in ways the pipeline now auto-retries in
    // production (an intermittent "Disabled Key" that clears on its own) --
    // a smoke test with less tolerance than production would fail on
    // exactly the blip the system is designed to shrug off.
    let liveResult = await mtnClient.verify(UNIQUE_MISS);
    let outcome = classifyMtnResult(liveResult.code, liveResult.message);
    for (let attempt = 1; attempt < 3 && (outcome === "transient" || outcome === "fatal"); attempt++) {
      console.log(`  retrying after a transient-looking reply: "${liveResult.message}"`);
      await new Promise((r) => setTimeout(r, 2000));
      liveResult = await mtnClient.verify(UNIQUE_MISS);
      outcome = classifyMtnResult(liveResult.code, liveResult.message);
    }
    check(
      ["ok", "ko", "mb"].includes(liveResult.code),
      `got a real provider code (got "${liveResult.code}" / "${liveResult.message}")`
    );
    check(
      liveResult.message.toLowerCase() === "rejected",
      `a nonexistent Gmail mailbox is rejected (got "${liveResult.message}")`
    );
    check(outcome === "invalid", `classified as invalid (got "${outcome}")`);

    console.log("\n3. That result flows through the same code the worker runs");
    const freshRow = await prisma.listRow.findFirstOrThrow({
      where: { listId: list.id, normalizedEmail: UNIQUE_MISS },
    });
    if (outcome === "valid" || outcome === "invalid" || outcome === "ambiguous") {
      await recordMtnResult({
        listRowId: freshRow.id,
        listId: list.id,
        normalizedEmail: UNIQUE_MISS,
        mtnStatus: liveResult.code,
        mtnMessage: liveResult.message,
        outcome,
      });
    }

    const rows = await prisma.listRow.findMany({ where: { listId: list.id } });
    const fresh = rows.find((r) => r.normalizedEmail === UNIQUE_MISS);
    const dead = rows.find((r) => r.normalizedEmail === DEAD_DOMAIN);

    check(
      fresh?.finalStatus === "invalid",
      `rejected mailbox settles as invalid, unpaid (got "${fresh?.finalStatus}")`
    );

    console.log("\n4. Domain-level facts resolve for free, without a live call");
    // The dead domain was resolved by ingestList's own domain-fact pass,
    // before this script ever called the provider -- proving that path
    // works independently of the live call above.
    check(
      dead?.finalStatus !== "valid",
      `a domain with no MX is never treated as valid (got "${dead?.finalStatus}")`
    );
    check(!!dead?.mtnMessage, `a reason was recorded for it (got "${dead?.mtnMessage}")`);

    // The live call above should have taught the cache something. Without
    // this, domain facts could silently stop being recorded and the only
    // symptom would be a slowly rising credit bill.
    const learned = await prisma.domainCache.findUnique({ where: { domain: "gmail.com" } });
    check(
      learned?.hasNoMx === false,
      `domain facts recorded from the live call (gmail.com hasNoMx=${learned?.hasNoMx})`
    );

    console.log("\n5. Nothing was charged");
    const spend = await prisma.creditLedger.aggregate({
      _sum: { amount: true },
      where: { listId: list.id },
    });
    check(
      (spend._sum.amount ?? 0) === 0,
      `nothing MTN answered definitively was bought (spent ${spend._sum.amount ?? 0})`
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
