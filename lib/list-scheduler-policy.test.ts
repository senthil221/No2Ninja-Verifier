import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_VERIFICATION_STATUSES,
  isActiveVerificationStatus,
  shouldPollListStatus,
} from "./list-scheduler-policy";

test("only one of the two provider phases owns the verification slot", () => {
  assert.deepEqual(ACTIVE_VERIFICATION_STATUSES, ["running_mtn", "running_n2b"]);
  assert.equal(isActiveVerificationStatus("running_mtn"), true);
  assert.equal(isActiveVerificationStatus("running_n2b"), true);
  assert.equal(isActiveVerificationStatus("queued"), false);
  assert.equal(isActiveVerificationStatus("pending"), false);
});

test("queued lists keep polling until the scheduler promotes them", () => {
  assert.equal(shouldPollListStatus("queued", false), true);
  assert.equal(shouldPollListStatus("running_mtn", false), true);
  assert.equal(shouldPollListStatus("running_n2b", false), true);
  assert.equal(shouldPollListStatus("failed", true), true);
  assert.equal(shouldPollListStatus("failed", false), false);
  assert.equal(shouldPollListStatus("pending", false), false);
  assert.equal(shouldPollListStatus("stopped", false), false);
  assert.equal(shouldPollListStatus("completed", false), false);
});
