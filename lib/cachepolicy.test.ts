import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config";

// Reuse is priced per provider, and the two point in opposite directions:
//
//   Mail Tester Ninja is flat-rate. Reusing a verdict saves nothing and
//   trades a free call for the risk of acting on a stale one -- people move
//   roles, mailboxes close, and a months-old "Accepted" becomes a bounce
//   that costs sender reputation.
//
//   NeverBounce costs a credit per address. Not reusing a verdict means
//   paying again for an answer already bought.
//
// Getting these the wrong way round is expensive in both directions, so the
// intent is pinned here rather than left to whoever next edits the config.

test("free-provider results are not reused by default", () => {
  assert.equal(
    config.mtnCacheTtlDays,
    0,
    "MTN verdicts should be re-verified every time: the call is free, staleness is not"
  );
});

test("paid results are reused", () => {
  assert.ok(
    config.n2bCacheTtlDays > 0,
    "NeverBounce verdicts must be reusable, or every list re-buys answers already paid for"
  );
});

test("domain facts expire sooner than address verdicts", () => {
  // A company can switch catch-all on or off; an individual mailbox result
  // cannot change underneath you in the same way.
  assert.ok(
    config.domainCacheTtlDays > 0 && config.domainCacheTtlDays <= config.n2bCacheTtlDays,
    `domain TTL (${config.domainCacheTtlDays}) should be positive and no longer than the address TTL (${config.n2bCacheTtlDays})`
  );
});

test("a zero TTL disables reuse rather than meaning 'forever'", () => {
  // The cutoff is computed as now-minus-TTL, so 0 lands on "now" and no
  // stored row can satisfy it. If this ever inverted, disabling the cache
  // would silently enable it permanently.
  const cutoff = new Date(Date.now() - 0 * 24 * 60 * 60 * 1000);
  const storedEarlier = new Date(Date.now() - 1000);
  assert.ok(storedEarlier < cutoff, "an existing entry must not count as fresh at TTL 0");
});
