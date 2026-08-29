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

    // Called directly rather than through the queue -- see the file header.
    // Retried locally on a transient-looking reply: MTN itself is
    // occasionally flaky in ways the pipeline now auto-retries in
    // production (an intermittent "Disabled Key" that clears on its own),
    // and a smoke test with less tolerance than production would fail on
    // exactly the blip the system is designed to shrug off.
    async function verifyLive(email: string) {
      let result = await mtnClient.verify(email);
      let outcome = classifyMtnResult(result.code, result.message);
      for (let attempt = 1; attempt < 3 && (outcome === "transient" || outcome === "fatal"); attempt++) {
        console.log(`  retrying after a transient-looking reply: "${result.message}"`);
        await new Promise((r) => setTimeout(r, 2000));
        result = await mtnClient.verify(email);
        outcome = classifyMtnResult(result.code, result.message);
      }
      return { result, outcome };
    }

    console.log("\n2. The provider is reachable and classified correctly");
    const fresh = await verifyLive(UNIQUE_MISS);
    check(
      ["ok", "ko", "mb"].includes(fresh.result.code),
      `got a real provider code (got "${fresh.result.code}" / "${fresh.result.message}")`
    );
    check(
      fresh.result.message.toLowerCase() === "rejected",
      `a nonexistent Gmail mailbox is rejected (got "${fresh.result.message}")`
    );
    check(fresh.outcome === "invalid", `classified as invalid (got "${fresh.outcome}")`);

    // MTN-sourced facts are not reused by default (MTN_CACHE_TTL_DAYS=0 --
    // see lib/config.ts), so a domain with no MX gets a fresh call too, not
    // a cache hit. That is current, deliberate policy, not a shortcut this
    // test is allowed to assume around.
    const dead = await verifyLive(DEAD_DOMAIN);
    check(dead.outcome === "invalid", `a domain with no MX is classified invalid (got "${dead.outcome}")`);

    console.log("\n3. Both results flow through the same code the worker runs");
    const rowByEmail = new Map(
      (await prisma.listRow.findMany({ where: { listId: list.id } })).map((r) => [
        r.normalizedEmail,
        r,
      ])
    );
    for (const [email, { result, outcome }] of [
      [UNIQUE_MISS, fresh],
      [DEAD_DOMAIN, dead],
    ] as const) {
      if (outcome !== "valid" && outcome !== "invalid" && outcome !== "ambiguous") continue;
      const row = rowByEmail.get(email);
      if (!row) continue;
      await recordMtnResult({
        listRowId: row.id,
        listId: list.id,
        normalizedEmail: email,
        mtnStatus: result.code,
        mtnMessage: result.message,
        outcome,
      });
    }

    const rows = await prisma.listRow.findMany({ where: { listId: list.id } });
    const freshRow = rows.find((r) => r.normalizedEmail === UNIQUE_MISS);
    const deadRow = rows.find((r) => r.normalizedEmail === DEAD_DOMAIN);

    check(
      freshRow?.finalStatus === "invalid",
      `rejected mailbox settles as invalid, unpaid (got "${freshRow?.finalStatus}")`
    );
    check(
      deadRow?.finalStatus === "invalid",
      `no-MX domain settles as invalid, unpaid (got "${deadRow?.finalStatus}")`
    );

    console.log("\n4. Domain facts are recorded from what was just learned");
    // Without this, domain facts could silently stop being recorded and the
    // only symptom in production would be a slowly rising credit bill.
    const [gmailFact, deadDomainFact] = await Promise.all([
      prisma.domainCache.findUnique({ where: { domain: "gmail.com" } }),
      prisma.domainCache.findUnique({
        where: { domain: DEAD_DOMAIN.split("@")[1]! },
      }),
    ]);
    check(
      gmailFact?.hasNoMx === false,
      `gmail.com recorded as having mail exchange (hasNoMx=${gmailFact?.hasNoMx})`
    );
    check(
      deadDomainFact?.hasNoMx === true,
      `the dead domain recorded as having none (hasNoMx=${deadDomainFact?.hasNoMx})`
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
