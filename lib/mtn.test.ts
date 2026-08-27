import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMtnMessage, classifyMtnResult } from "./mtn";

// Verified against the live API. `code` is the documented verdict
// (ok = valid, ko = invalid, mb = unverifiable) and must outrank any guess
// at what the message wording means.
test("classifies the code/message pairs the live API actually returns", () => {
  assert.equal(classifyMtnResult("ok", "Accepted"), "valid");
  assert.equal(classifyMtnResult("ko", "Rejected"), "invalid");
  assert.equal(classifyMtnResult("ko", "No MX"), "invalid");
  assert.equal(classifyMtnResult("mb", "Catch-All"), "ambiguous");
  assert.equal(classifyMtnResult("mb", "SPAM Block"), "transient");
});

test("the code decides, even for message wording we have never seen", () => {
  // "Limited" is documented but unobserved. Whatever it means, the code is
  // the provider's own verdict and must win.
  assert.equal(classifyMtnResult("ok", "Limited"), "valid");
  assert.equal(classifyMtnResult("mb", "Limited"), "transient");
  assert.equal(classifyMtnResult("ko", "Some Future Wording"), "invalid");
});

test("an unverifiable code never resolves the address either way", () => {
  // mb means "could not verify" -- claiming valid would send mail to an
  // unconfirmed address, claiming invalid would discard a real prospect.
  for (const message of ["Timeout", "MX Error", "SPAM Block", "Anything Else"]) {
    const outcome = classifyMtnResult("mb", message);
    assert.ok(
      outcome !== "valid" && outcome !== "invalid",
      `mb/"${message}" must not resolve to a verdict (got ${outcome})`
    );
  }
});

test("account failures stay fatal regardless of code", () => {
  assert.equal(classifyMtnResult("--", "Disabled Key"), "fatal");
  assert.equal(classifyMtnResult("ok", "Quota Exceeded"), "fatal");
});

test("an unknown code falls back to reading the message", () => {
  assert.equal(classifyMtnResult("", "Accepted"), "valid");
  assert.equal(classifyMtnResult("weird", "No MX"), "invalid");
});

// These are the literal strings the live API returns. Note the casing:
// the published docs say "No Mx" / "Mx Error", the API actually sends
// "No MX" / "MX Error". Matching these literally (rather than
// case-insensitively) silently downgraded them to "transient", which
// retried and then escalated definitively-invalid rows to the paid
// provider. Keep both spellings pinned here.
test("classifies definitive results without escalating", () => {
  assert.equal(classifyMtnMessage("Accepted"), "valid");
  assert.equal(classifyMtnMessage("Rejected"), "invalid");

  for (const spelling of ["No MX", "No Mx", "no mx"]) {
    assert.equal(classifyMtnMessage(spelling), "invalid", `"${spelling}" must be invalid`);
  }
});

test("message-only 'Limited' is not asserted valid", () => {
  // Documented but never observed, so we don't know which code accompanies
  // it. Without the code, claiming deliverability we can't back would send
  // mail to an unverified address -- a bounce costs sender reputation,
  // escalating costs a credit. With a code present, the code decides.
  assert.notEqual(classifyMtnMessage("Limited"), "valid");
});

test("classifies catch-all as ambiguous", () => {
  assert.equal(classifyMtnMessage("Catch-All"), "ambiguous");
});

test("classifies retryable failures as transient", () => {
  for (const spelling of ["MX Error", "Mx Error"]) {
    assert.equal(classifyMtnMessage(spelling), "transient", `"${spelling}" must be transient`);
  }
  assert.equal(classifyMtnMessage("Timeout"), "transient");
  assert.equal(classifyMtnMessage("SPAM Block"), "transient");
});

test("classifies account-level failures as fatal, never escalating them", () => {
  // A broken key says nothing about the address. Escalating these would
  // dump an entire list into the paid provider.
  for (const message of [
    "Disabled Key",
    "Invalid Key",
    "Quota Exceeded",
    "Subscription Expired",
    "Unauthorized",
  ]) {
    assert.equal(classifyMtnMessage(message), "fatal", `"${message}" must be fatal`);
  }
});

test("falls back to transient for genuinely unknown messages", () => {
  assert.equal(classifyMtnMessage("Some Future Status"), "transient");
});
