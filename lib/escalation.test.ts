import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMtnMessage, classifyMtnResult } from "./mtn";

// What reaches the paid provider is what gets billed, so the split is pinned
// here against the literal replies the live API sends.
//
//   to No2Bounce -- Catch-All, SPAM Block, Timeout, MX Error, Limited
//   settled free -- Accepted (valid), Rejected and No MX (invalid)
//
// settleMtnOutcome lives in pipeline.ts, which pulls in Prisma; replicate
// its decision here so the rules can be asserted without a database. If
// this drifts from the implementation, that is the signal to look.
function settle(
  outcome: "valid" | "invalid" | "ambiguous",
  catchAll: "accept" | "n2b" = "n2b"
): "valid" | "invalid" | "risky" | null {
  if (outcome === "valid") return "valid";
  if (outcome === "invalid") return "invalid";
  return catchAll === "accept" ? "risky" : null;
}

// "transient" rows retry on MTN first and are escalated once those are
// spent, so from the billing point of view they are on their way to the
// paid pass just as surely as an ambiguous one.
function reachesN2b(code: string, message: string): boolean {
  const outcome = classifyMtnResult(code, message);
  if (outcome === "transient") return true;
  if (outcome === "fatal") return false;
  return settle(outcome) === null;
}

test("only what MTN could not answer reaches the paid pass", () => {
  const escalated: [string, string][] = [
    ["mb", "Catch-All"],
    ["mb", "SPAM Block"],
    ["mb", "Timeout"],
    ["mb", "MX Error"],
    ["ok", "Limited"],
  ];
  for (const [code, message] of escalated) {
    assert.ok(reachesN2b(code, message), `"${message}" should reach No2Bounce`);
  }
});

test("rejected and no-MX are settled invalid without paying for a rerun", () => {
  for (const [code, message] of [
    ["ko", "Rejected"],
    ["ko", "No MX"],
  ] as [string, string][]) {
    const outcome = classifyMtnResult(code, message) as "valid" | "invalid" | "ambiguous";
    assert.equal(settle(outcome), "invalid", `"${message}" should settle as invalid`);
    assert.ok(!reachesN2b(code, message), `"${message}" must never reach No2Bounce`);
  }
});

test("a confirmed valid is never escalated", () => {
  assert.equal(settle(classifyMtnMessage("Accepted") as "valid"), "valid");
  assert.ok(!reachesN2b("ok", "Accepted"), "an accepted address must never be escalated");
});

test("Limited is never settled valid, whatever code carries it", () => {
  // MTN pairs "Limited" with `ok`, but a limited answer is the server
  // declining to finish the check. Treating it as deliverable would send
  // mail to an address nothing confirmed.
  for (const code of ["ok", "mb", "", "weird"]) {
    assert.notEqual(
      classifyMtnResult(code, "Limited"),
      "valid",
      `${code}/"Limited" must not be called valid`
    );
    assert.ok(reachesN2b(code, "Limited"), `${code}/"Limited" should reach No2Bounce`);
  }
});

test("accepting catch-all keeps it out of the paid pass", () => {
  assert.equal(settle("ambiguous", "accept"), "risky");
});

test("an account failure stops the list rather than escalating it", () => {
  // A broken key says nothing about any address. Escalating on it would
  // dump the whole list into the paid provider.
  for (const message of ["Disabled Key", "Quota Exceeded", "Subscription Expired"]) {
    assert.equal(classifyMtnResult("ok", message), "fatal");
    assert.ok(!reachesN2b("ok", message), `"${message}" must never reach No2Bounce`);
  }
});
