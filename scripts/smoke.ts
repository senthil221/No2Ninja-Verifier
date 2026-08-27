/**
 * End-to-end smoke test against the real stack.
 *
 * "Deployed" previously meant "the containers started", which is not the
 * same as "the pipeline works" -- several releases in this project started
 * cleanly and were completely broken. This drives an actual list through
 * ingest, the cache passes and the cheap provider, asserts the results are
 * what those addresses should produce, and deletes everything it created.
 *
 * It does NOT spend NeverBounce credits: it stops at the review gate, which
 * is exactly where a real list stops.
 *
 *   npm run smoke
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { ingestList, startVerification, deleteList } from "../lib/pipeline";
import { assertProviderKeysConfigured } from "../lib/config";

const CLIENT_NAME = "__smoke_test__";
const TIMEOUT_MS = 180_000;

// Addresses whose behaviour is stable and knowable, so the expectation is a
// real assertion rather than a snapshot of whatever happened to come back.
const FIXTURE = `email,first_name,company
schalonm@cashncarryelectric.com,Known,Good
contact@thisdomaindoesnotexist-verifiertest.com,No,MX
zzz.verifier.test.88213@gmail.com,Ghost,Gmail
not-an-email,Bad,Syntax
zzz.verifier.test.88213@gmail.com,Dupe,Gmail
`;

interface Expectation {
  email: string;
  expectCode: string;
  describe: string;
}

const EXPECTED: Expectation[] = [
  { email: "schalonm@cashncarryelectric.com", expectCode: "ok", describe: "a real mailbox" },
  {
    email: "contact@thisdomaindoesnotexist-verifiertest.com",
    expectCode: "ko",
    describe: "a domain with no MX",
  },
  { email: "zzz.verifier.test.88213@gmail.com", expectCode: "ko", describe: "a rejected mailbox" },
];

const failures: string[] = [];
function check(ok: boolean, message: string) {
  if (ok) {
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

async function waitForSettled(listId: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await prisma.list.findUniqueOrThrow({
      where: { id: listId },
      select: { status: true },
    });
    // running_mtn is the only state that resolves itself; everything else is
    // either finished or waiting on a person.
    if (list.status !== "running_mtn" && list.status !== "pending") return list.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout";
}

async function main() {
  assertProviderKeysConfigured();
  console.log("Smoke test: driving a real list through the pipeline\n");

  // Never reuse a previous run's leftovers -- a stale client would make the
  // cache resolve rows and hide a broken provider call.
  await cleanup();

  const client = await prisma.client.create({ data: { name: CLIENT_NAME } });
  let listId: string | null = null;

  try {
    console.log("1. Ingest");
    const list = await ingestList({
      clientId: client.id,
      name: "smoke",
      sourceFileName: "smoke.csv",
      fileContents: FIXTURE,
    });
    listId = list.id;

    check(list.totalRows === 3, `parsed 3 usable rows from 5 lines (got ${list.totalRows})`);
    check(list.skippedInvalid === 1, `skipped 1 malformed address (got ${list.skippedInvalid})`);
    check(list.skippedDupes === 1, `skipped 1 duplicate (got ${list.skippedDupes})`);

    console.log("\n2. Cheap pass");
    await startVerification(list.id);
    const status = await waitForSettled(list.id);
    check(status !== "timeout", `settled within ${TIMEOUT_MS / 1000}s (status: ${status})`);
    check(
      status !== "failed",
      `list did not fail${status === "failed" ? " -- check worker logs" : ""}`
    );

    console.log("\n3. Provider responses");
    const rows = await prisma.listRow.findMany({ where: { listId: list.id } });

    for (const expected of EXPECTED) {
      const row = rows.find((r) => r.normalizedEmail === expected.email);
      if (!row) {
        check(false, `row present for ${expected.describe}`);
        continue;
      }
      // A null code means the provider was never actually reached -- the
      // failure mode that looked like "verification is slow" for a whole day.
      check(
        row.mtnStatus === expected.expectCode,
        `${expected.describe} -> code "${expected.expectCode}" (got "${row.mtnStatus}" / "${row.mtnMessage}")`
      );
    }

    const stuck = rows.filter((r) => r.stage === "pending").length;
    check(stuck === 0, `no rows left unprocessed (${stuck} stuck)`);

    const spend = await prisma.creditLedger.aggregate({
      _sum: { amount: true },
      where: { listId: list.id },
    });
    check(
      (spend._sum.amount ?? 0) === 0,
      `no credits spent reaching the review gate (spent ${spend._sum.amount ?? 0})`
    );
  } finally {
    console.log("\n4. Cleanup");
    if (listId) await deleteList(listId).catch(() => {});
    await cleanup();
    console.log("  removed test client and list");
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
