import { test } from "node:test";
import assert from "node:assert/strict";
import { domainOf, verdictFromDomain, type DomainFacts } from "./domains";
import { parseResultCsv } from "./n2b";

const facts = (over: Partial<DomainFacts> = {}): DomainFacts => ({
  isCatchAll: null,
  hasNoMx: null,
  catchAllConfirmed: false,
  ...over,
});

test("extracts the domain, including from plus-addressed mailboxes", () => {
  assert.equal(domainOf("a@example.com"), "example.com");
  assert.equal(domainOf("a+tag@Example.COM"), "example.com");
  assert.equal(domainOf("odd@name@example.co.uk"), "example.co.uk");
});

test("a domain with no MX answers for every address at it", () => {
  const v = verdictFromDomain(facts({ hasNoMx: true }));
  assert.equal(v?.status, "invalid");
});

test("a confirmed catch-all resolves as risky rather than being charged", () => {
  const v = verdictFromDomain(facts({ isCatchAll: true, catchAllConfirmed: true }));
  assert.equal(v?.status, "risky");
});

test("an unconfirmed catch-all is not acted on", () => {
  // Mail Tester Ninja's catch-all hint alone must not skip the paid check --
  // acting on it would mean trusting the cheap provider to decide what the
  // expensive one would have said.
  assert.equal(verdictFromDomain(facts({ isCatchAll: true, catchAllConfirmed: false })), null);
});

test("nothing known means nothing claimed", () => {
  assert.equal(verdictFromDomain(undefined), null);
  assert.equal(verdictFromDomain(facts()), null);
  // Explicitly not catch-all and has MX: still needs a per-address answer.
  assert.equal(verdictFromDomain(facts({ isCatchAll: false, hasNoMx: false })), null);
});

test("reads the catch-all flag out of a real report", () => {
  // This flag is what makes one paid check answer for a whole domain.
  const rows = parseResultCsv(`"email","finalScore","finalScoreValue","catchall"
"a@plain.com","0","UnDeliverable",false
"b@accepts-all.com","99","Deliverable/AcceptAll",true`);

  assert.equal(rows[0]!.catchAll, false);
  assert.equal(rows[1]!.catchAll, true);
});

test("a report without the flag yields null, not false", () => {
  // Absent must not be read as "not catch-all", which would wrongly mark
  // domains as needing per-address checks forever.
  const rows = parseResultCsv(`email,finalScoreValue
a@plain.com,Deliverable`);
  assert.equal(rows[0]!.catchAll, null);
});
