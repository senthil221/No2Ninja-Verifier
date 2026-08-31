import { test } from "node:test";
import assert from "node:assert/strict";
import { mtnJobId, shouldProcessMtnJob } from "./mtn-queue-policy";

test("MTN job IDs are stable, non-numeric, and BullMQ-safe", () => {
  assert.equal(mtnJobId("row-123"), "mtn-row-123");
  assert.equal(mtnJobId("row-123"), mtnJobId("row-123"));
  assert.doesNotMatch(mtnJobId("row-123"), /^\d+$/);
  assert.doesNotMatch(mtnJobId("row-123"), /:/);
});

test("only a still-pending row on a running MTN list reaches the provider", () => {
  assert.equal(shouldProcessMtnJob("running_mtn", "pending"), true);
  assert.equal(shouldProcessMtnJob("queued", "pending"), false);
  assert.equal(shouldProcessMtnJob("running_mtn", "mtn_done"), false);
  assert.equal(shouldProcessMtnJob("running_mtn", "needs_n2b"), false);
  assert.equal(shouldProcessMtnJob("failed", "pending"), false);
  assert.equal(shouldProcessMtnJob("stopped", "pending"), false);
  assert.equal(shouldProcessMtnJob(undefined, undefined), false);
});
