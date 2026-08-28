import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResultCsv } from "./n2b";

// Captured verbatim from a real No2Bounce report. None of this is in the
// public docs, and the verdict column ("finalScoreValue") contains none of
// the words a naive header match would look for -- which is exactly how it
// got missed once already.
const REAL_REPORT = `"email","finalScore","finalScoreValue","catchall"
"demo@gmail.com","0","UnDeliverable",false
"demo1@outlook.com","99","Deliverable/AcceptAll",true
"demo2@yahoo.com","0","UnDeliverable/AcceptAll",true`;

test("parses the real report format", () => {
  const rows = parseResultCsv(REAL_REPORT);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.email),
    ["demo@gmail.com", "demo1@outlook.com", "demo2@yahoo.com"]
  );
  // A missed verdict column would silently mark everything unknown.
  assert.ok(
    rows.every((r) => r.rawStatus.length > 0),
    "verdict column must be found"
  );
});

test("an accept-all 'Deliverable' is risky, not valid", () => {
  // The domain accepts everything, so a high score is the domain answering,
  // not proof the mailbox exists. Calling it valid would be the expensive
  // kind of wrong -- it puts unverified addresses into a send.
  const [, acceptAll] = parseResultCsv(REAL_REPORT);
  assert.equal(acceptAll!.rawStatus, "Deliverable/AcceptAll");
  assert.equal(acceptAll!.status, "risky");
});

test("undeliverable verdicts map to invalid, with or without accept-all", () => {
  const rows = parseResultCsv(REAL_REPORT);
  assert.equal(rows[0]!.status, "invalid", "plain UnDeliverable");
  assert.equal(rows[2]!.status, "invalid", "UnDeliverable/AcceptAll");
});

test("a confirmed deliverable maps to valid", () => {
  const rows = parseResultCsv(`"email","finalScore","finalScoreValue","catchall"
"real@example.com","100","Deliverable",false`);
  assert.equal(rows[0]!.status, "valid");
});

test("tolerates an unknown verdict column name", () => {
  const rows = parseResultCsv(`email,status
a@b.com,Deliverable`);
  assert.equal(rows[0]!.email, "a@b.com");
  assert.equal(rows[0]!.status, "valid");
});

// The export's "valid" file is what actually gets mailed, so the one thing
// that must never drift is which verdicts are allowed into it. No2Bounce
// answers with Deliverable, CatchAll/AcceptAll, Invalid, Bounce or Spam --
// only the first is a statement about the mailbox.
const VERDICTS: [string, "valid" | "invalid" | "risky" | "unknown"][] = [
  ["Deliverable", "valid"],
  ["CatchAll", "risky"],
  ["AcceptAll", "risky"],
  ["Deliverable/AcceptAll", "risky"],
  ["Invalid", "invalid"],
  ["UnDeliverable", "invalid"],
  ["Bounce", "invalid"],
  ["Spam", "risky"],
  ["Deliverable/Spam", "risky"],
];

function statusOf(verdict: string) {
  return parseResultCsv(`email,finalScoreValue\nx@y.com,${verdict}`)[0]!.status;
}

test("only a confirmed deliverable is counted valid", () => {
  for (const [verdict, expected] of VERDICTS) {
    assert.equal(statusOf(verdict), expected, `"${verdict}" should map to ${expected}`);
  }
});

test("nothing but a plain deliverable ever reaches the send list", () => {
  for (const [verdict, expected] of VERDICTS) {
    if (expected === "valid") continue;
    assert.notEqual(statusOf(verdict), "valid", `"${verdict}" must never be valid`);
  }
  // A spam trap is deliverable in the literal sense, which is exactly why
  // the disqualifiers are checked before the word "deliverable" is honoured.
  assert.notEqual(statusOf("Deliverable/SpamTrap"), "valid");
  // And a verdict nobody has seen before is not guessed into the send list.
  assert.notEqual(statusOf("Some Future Verdict"), "valid");
});
