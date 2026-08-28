import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryableFailure, autoRetryDelayMs } from "./retry-policy";
import { config } from "./config";

test("a bare network failure (no HTTP status at all) is retryable", () => {
  // This is exactly what Node's fetch throws for DNS failures, refused
  // connections and timeouts -- the class of failure a retry actually fixes.
  assert.equal(isRetryableFailure(new TypeError("fetch failed")), true);
  assert.equal(isRetryableFailure("N2B poll failed: fetch failed"), true);
});

test("provider 5xx and 429 are retryable", () => {
  for (const status of [500, 502, 503, 504, 429]) {
    assert.equal(
      isRetryableFailure(new Error(`No2Bounce rejected the batch (HTTP ${status})`)),
      true,
      `HTTP ${status} should be retryable`
    );
  }
});

test("a rejected request (4xx other than 429) is not retryable", () => {
  // This is the hashkey bug from earlier: the request shape itself was
  // wrong, and retrying an identical request produces an identical 400.
  assert.equal(
    isRetryableFailure(new Error('No2Bounce rejected the batch (HTTP 400): hashkey is not allowed')),
    false
  );
  assert.equal(isRetryableFailure(new Error("failed (HTTP 401): unauthorized")), false);
  assert.equal(isRetryableFailure(new Error("failed (HTTP 404)")), false);
});

test("an unrecognised failure defaults to not retryable", () => {
  // Silently retrying something we cannot classify risks masking a real bug
  // behind two hours of retries instead of surfacing it.
  assert.equal(isRetryableFailure(new Error("something unexpected happened")), false);
  assert.equal(isRetryableFailure("plain string, no HTTP status"), false);
});

test("accepts both Error objects and bare strings", () => {
  // Some failures reach this classifier only as a message string -- e.g. a
  // poll() response that returns a failed state rather than throwing, where
  // the original Error object no longer exists by the time it is checked.
  assert.equal(isRetryableFailure("(HTTP 503)"), true);
  assert.equal(isRetryableFailure("(HTTP 403)"), false);
});

test("backoff doubles from the configured base and is capped", () => {
  assert.equal(autoRetryDelayMs(1), config.autoRetry.baseDelayMs);
  assert.equal(autoRetryDelayMs(2), config.autoRetry.baseDelayMs * 2);
  assert.equal(autoRetryDelayMs(3), config.autoRetry.baseDelayMs * 4);

  // A long-running outage must still be checked on periodically rather than
  // the delay growing without bound.
  const farOut = autoRetryDelayMs(20);
  assert.equal(farOut, config.autoRetry.maxDelayMs);
});

test("the attempt budget resolves to a bounded total wait, not an unbounded one", () => {
  let total = 0;
  for (let attempt = 1; attempt <= config.autoRetry.maxAttempts; attempt++) {
    total += autoRetryDelayMs(attempt);
  }
  // A sanity bound rather than an exact figure: this only needs to prove
  // the schedule terminates in a reasonable window (a few hours), not that
  // nobody ever tunes the defaults.
  assert.ok(total > 0);
  assert.ok(total < 24 * 60 * 60 * 1000, "the full retry budget should resolve within a day");
});
