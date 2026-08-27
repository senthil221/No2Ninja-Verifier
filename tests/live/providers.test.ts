import { test } from "node:test";
import assert from "node:assert/strict";
import { mtnClient, classifyMtnResult } from "../../lib/mtn";
import { n2bClient } from "../../lib/n2b";
import { config } from "../../lib/config";

// Contract tests: these call the real providers.
//
// Every serious bug in this integration came from writing code against the
// documentation and shipping it unverified -- a rejected `hashkey`, a poll
// response not wrapped in `data`, a verdict column no header match could
// find. Unit tests cannot catch that class of failure, because the thing
// being asserted is what the provider actually does.
//
// Run with:  npm run test:live
// These are excluded from `npm test` so CI never depends on a third party.

const hasMtn = Boolean(config.mtn.apiKey) && config.mtn.apiKey !== "ci-placeholder";
const hasN2b = Boolean(config.n2b.apiToken) && config.n2b.apiToken !== "ci-placeholder";

// Costs one credit, so it is opt-in even among the live tests.
const spendCredit = process.env.N2B_LIVE_CONTRACT === "1";

test(
  "MTN: replies with the documented code/message shape",
  { skip: hasMtn ? false : "MTN_API_KEY not set" },
  async () => {
    const r = await mtnClient.verify("test@gmail.com");

    assert.ok(typeof r.code === "string" && r.code.length > 0, "expected a code");
    assert.ok(typeof r.message === "string" && r.message.length > 0, "expected a message");
    assert.ok(
      ["ok", "ko", "mb"].includes(r.code),
      `unexpected code "${r.code}" -- classification is keyed on these three`
    );
  }
);

test(
  "MTN: a dead domain still reports as ko / No MX",
  { skip: hasMtn ? false : "MTN_API_KEY not set" },
  async () => {
    // The exact casing here matters: matching "No Mx" literally, as the docs
    // spell it, silently escalated dead domains to the paid provider.
    const r = await mtnClient.verify("contact@thisdomaindoesnotexist-verifiertest.com");
    assert.equal(r.code, "ko");
    assert.equal(classifyMtnResult(r.code, r.message), "invalid");
  }
);

test(
  "MTN: the configured key is live",
  { skip: hasMtn ? false : "MTN_API_KEY not set" },
  async () => {
    const r = await mtnClient.verify("test@gmail.com");
    assert.notEqual(
      classifyMtnResult(r.code, r.message),
      "fatal",
      `key rejected by provider: "${r.message}"`
    );
  }
);

test(
  "N2B: accepts a batch and returns a trackingId",
  { skip: hasN2b && spendCredit ? false : "set N2B_LIVE_CONTRACT=1 (spends 1 credit)" },
  async () => {
    // Submitting is the only way to prove the request body is still
    // accepted -- the documented `hashkey` field is rejected outright, and
    // that was invisible until a real submit was attempted.
    const { trackingId } = await n2bClient.submitBulk(["contract-check@gmail.com"]);
    assert.ok(trackingId && trackingId.length > 0, "expected a trackingId");

    const polled = await n2bClient.poll(trackingId);
    assert.ok(
      polled.state === "in_progress" || polled.state === "complete",
      `poll returned "${polled.state}" -- response shape may have changed`
    );
  }
);
