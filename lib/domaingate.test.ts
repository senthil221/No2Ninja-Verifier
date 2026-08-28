import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedDomain, domainOfEmail } from "./auth";
import { config } from "./config";

const allowed = config.allowedEmailDomains[0]!;

test("accepts addresses at an allowed domain", () => {
  assert.equal(isAllowedDomain(`someone@${allowed}`), true);
  // Case and surrounding whitespace must not be a way around the gate.
  assert.equal(isAllowedDomain(`  SomeOne@${allowed.toUpperCase()}  `), true);
});

test("rejects every other domain", () => {
  for (const email of ["a@gmail.com", "a@example.com", "a@notb2bdrive.net"]) {
    assert.equal(isAllowedDomain(email), false, `${email} should be rejected`);
  }
});

test("rejects addresses that only look like the allowed domain", () => {
  // Substring matching would let all of these through, which is how domain
  // allow-lists usually fail.
  for (const email of [
    `a@evil-${allowed}`,
    `a@${allowed}.evil.com`,
    `a@sub.${allowed}.co`,
    `a@${allowed}x`,
  ]) {
    assert.equal(isAllowedDomain(email), false, `${email} must not pass as ${allowed}`);
  }
});

test("rejects malformed addresses rather than throwing", () => {
  for (const email of ["", "no-at-sign", "@", "a@", "@domain.com"]) {
    assert.equal(isAllowedDomain(email), false, `"${email}" should be rejected`);
  }
});

test("an empty allow-list denies rather than permits everything", () => {
  // A blank or missing setting must not silently open sign-up to the world.
  const saved = config.allowedEmailDomains;
  try {
    (config as { allowedEmailDomains: string[] }).allowedEmailDomains = [];
    assert.equal(isAllowedDomain(`someone@${allowed}`), false);
  } finally {
    (config as { allowedEmailDomains: string[] }).allowedEmailDomains = saved;
  }
});

test("extracts the domain from an address", () => {
  assert.equal(domainOfEmail("Person@Example.COM"), "example.com");
  assert.equal(domainOfEmail("no-at-sign"), "");
});
