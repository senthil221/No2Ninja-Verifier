import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mtnFocusBlockReason,
  mtnJobId,
  shouldProcessMtnJob,
} from "./mtn-queue-policy";

test("MTN job IDs are stable, non-numeric, and BullMQ-safe", () => {
  assert.equal(mtnJobId("row-123"), "mtn-row-123");
  assert.equal(mtnJobId("row-123"), mtnJobId("row-123"));
  assert.doesNotMatch(mtnJobId("row-123"), /^\d+$/);
  assert.doesNotMatch(mtnJobId("row-123"), /:/);
});

test("only a still-pending row on a running MTN list reaches the provider", () => {
  assert.equal(shouldProcessMtnJob("running_mtn", "pending"), true);
  assert.equal(shouldProcessMtnJob("running_mtn", "mtn_done"), false);
  assert.equal(shouldProcessMtnJob("running_mtn", "needs_n2b"), false);
  assert.equal(shouldProcessMtnJob("failed", "pending"), false);
  assert.equal(shouldProcessMtnJob("stopped", "pending"), false);
  assert.equal(shouldProcessMtnJob(undefined, undefined), false);
});

test("focus is allowed only for the sole running MTN list", () => {
  assert.equal(mtnFocusBlockReason("running_mtn", 0), null);
  assert.match(mtnFocusBlockReason("running_mtn", 1) ?? "", /Another list/);
  assert.match(mtnFocusBlockReason("stopped", 0) ?? "", /not currently/);
});
