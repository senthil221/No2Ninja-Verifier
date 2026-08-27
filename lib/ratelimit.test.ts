import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mtnClient, MtnRateLimitedError } from "./mtn";
import { mtnRequestIntervalMs, config } from "./config";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers })) as typeof fetch;
}

test("a 429 raises a rate-limit error, not a generic failure", async () => {
  // This distinction is the whole point: a generic error is treated as the
  // provider being unreachable, which stops the entire list. Being asked to
  // slow down must cost time, not the run.
  stub(429);
  await assert.rejects(
    () => mtnClient.verify("a@example.com"),
    (err: Error) => err instanceof MtnRateLimitedError
  );
});

test("honours Retry-After when the provider sends one", async () => {
  stub(429, { "retry-after": "5" });
  await assert.rejects(
    () => mtnClient.verify("a@example.com"),
    (err: MtnRateLimitedError) => err.retryAfterMs === 5000
  );
});

test("falls back to a full window when Retry-After is absent or junk", async () => {
  for (const headers of [{}, { "retry-after": "soon" }]) {
    stub(429, headers);
    await assert.rejects(
      () => mtnClient.verify("a@example.com"),
      (err: MtnRateLimitedError) => err.retryAfterMs === config.mtn.rateLimitWindowMs
    );
  }
});

test("other HTTP failures stay generic errors", async () => {
  stub(500);
  await assert.rejects(
    () => mtnClient.verify("a@example.com"),
    (err: Error) => !(err instanceof MtnRateLimitedError)
  );
});

test("paced interval stays under the plan's own rate", () => {
  const interval = mtnRequestIntervalMs();
  const perWindow = config.mtn.rateLimitWindowMs / interval;
  assert.ok(
    perWindow < config.mtn.rateLimitMax,
    `paced rate ${perWindow.toFixed(1)} must stay under the limit ${config.mtn.rateLimitMax}`
  );
  // Pacing that drifts far below the allowance would be needlessly slow.
  assert.ok(perWindow > config.mtn.rateLimitMax * 0.7, "pacing should still use most of the allowance");
});
