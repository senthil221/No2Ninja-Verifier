import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMtnMessage } from "./mtn";

// These are the literal strings the live API returns. Note the casing:
// the published docs say "No Mx" / "Mx Error", the API actually sends
// "No MX" / "MX Error". Matching these literally (rather than
// case-insensitively) silently downgraded them to "transient", which
// retried and then escalated definitively-invalid rows to the paid
// provider. Keep both spellings pinned here.
test("classifies definitive results without escalating", () => {
  assert.equal(classifyMtnMessage("Accepted"), "valid");
  assert.equal(classifyMtnMessage("Limited"), "valid");
  assert.equal(classifyMtnMessage("Rejected"), "invalid");

  for (const spelling of ["No MX", "No Mx", "no mx"]) {
    assert.equal(classifyMtnMessage(spelling), "invalid", `"${spelling}" must be invalid`);
  }
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
