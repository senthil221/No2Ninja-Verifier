import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationAccounting, verificationPhase } from "./progress-accounting";

test("separates live MTN checks from final MTN resolutions", () => {
  const accounting = buildVerificationAccounting({
    liveMtnChecked: 12_933,
    stageCounts: { cache_hit: 293, mtn_done: 8_772, needs_n2b: 4_497 },
    bySource: { cache: 629, mtn: 8_436 },
  });

  assert.deepEqual(accounting, {
    checkedByMtn: 12_933,
    reusedFromCacheOrDomain: 629,
    resolvedByMtn: 8_436,
    escalatedToN2b: 4_497,
    resolvedByN2b: 0,
    waitingForMtn: 0,
  });
  assert.equal(accounting.checkedByMtn + accounting.reusedFromCacheOrDomain, 13_562);
});

test("marks a post-MTN provider failure at the N2B step", () => {
  assert.equal(
    verificationPhase("failed", { waitingForMtn: 0, escalatedToN2b: 4_497 }),
    "n2b"
  );
  assert.equal(
    verificationPhase("failed", { waitingForMtn: 200, escalatedToN2b: 0 }),
    "mtn"
  );
});
