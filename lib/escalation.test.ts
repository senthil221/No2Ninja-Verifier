import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMtnMessage } from "./mtn";

// The escalation policy decides what gets billed to the paid provider, so
// pin the intent per policy against the real MTN replies.
//
// settleMtnOutcome lives in pipeline.ts, which pulls in Prisma; replicate
// its decision here so the rules can be asserted without a database. If
// this drifts from the implementation, that is the signal to look.
function settle(
  outcome: "valid" | "invalid" | "ambiguous",
  policy: "all_except_valid" | "unresolved",
  catchAll: "accept" | "n2b" = "n2b"
): "valid" | "invalid" | "risky" | null {
  if (outcome === "valid") return "valid";
  if (outcome === "invalid") return policy === "all_except_valid" ? null : "invalid";
  return catchAll === "accept" ? "risky" : null;
}

const escalates = (v: ReturnType<typeof settle>) => v === null;

test("all_except_valid sends everything but a confirmed valid to the paid pass", () => {
  const policy = "all_except_valid" as const;

  assert.equal(settle(classifyMtnMessage("Accepted") as any, policy), "valid");
  assert.ok(!escalates(settle("valid", policy)), "a valid row must never be escalated");

  for (const message of ["Rejected", "No MX", "Catch-All"]) {
    const outcome = classifyMtnMessage(message) as "valid" | "invalid" | "ambiguous";
    assert.ok(
      escalates(settle(outcome, policy)),
      `"${message}" should escalate under all_except_valid`
    );
  }
});

test("unresolved trusts MTN's invalid verdicts and escalates only the ambiguous", () => {
  const policy = "unresolved" as const;

  for (const message of ["Rejected", "No MX"]) {
    const outcome = classifyMtnMessage(message) as "valid" | "invalid" | "ambiguous";
    assert.equal(settle(outcome, policy), "invalid", `"${message}" should settle as invalid`);
  }

  assert.ok(escalates(settle("ambiguous", policy)), "catch-all should still escalate");
});

test("accepting catch-all keeps it out of the paid pass under either policy", () => {
  for (const policy of ["all_except_valid", "unresolved"] as const) {
    assert.equal(settle("ambiguous", policy, "accept"), "risky");
  }
});

test("a valid row is never escalated under any policy", () => {
  for (const policy of ["all_except_valid", "unresolved"] as const) {
    assert.equal(settle("valid", policy), "valid");
  }
});
