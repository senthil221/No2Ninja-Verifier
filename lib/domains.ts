import { prisma } from "./prisma";
import { config } from "./config";

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

// Established facts about a domain's mail server. Anything not established
// is left null rather than defaulted, so "we haven't checked" is never
// mistaken for "no".
export interface DomainFacts {
  isCatchAll: boolean | null;
  hasNoMx: boolean | null;
  catchAllConfirmed: boolean;
}

function isFresh(updatedAt: Date): boolean {
  const cutoff = new Date(Date.now() - config.domainCacheTtlDays * 24 * 60 * 60 * 1000);
  return updatedAt >= cutoff;
}

export async function loadDomainFacts(domains: string[]): Promise<Map<string, DomainFacts>> {
  const out = new Map<string, DomainFacts>();
  if (!config.domainCacheEnabled || domains.length === 0) return out;

  const rows = await prisma.domainCache.findMany({
    where: { domain: { in: Array.from(new Set(domains)) } },
  });

  for (const row of rows) {
    if (!isFresh(row.updatedAt)) continue;
    out.set(row.domain, {
      isCatchAll: row.isCatchAll,
      hasNoMx: row.hasNoMx,
      // Only NeverBounce's own catch-all flag is treated as settled. Acting
      // on Mail Tester Ninja's hint alone would mean skipping paid checks on
      // the strength of the cheaper provider's guess.
      catchAllConfirmed: row.isCatchAll === true && row.catchAllSource === "n2b",
    });
  }
  return out;
}

export async function recordDomainFact(
  domain: string,
  fact: { isCatchAll?: boolean; hasNoMx?: boolean; source?: "mtn" | "n2b" }
) {
  if (!config.domainCacheEnabled || !domain) return;

  const data: Record<string, unknown> = {};
  if (fact.hasNoMx !== undefined) data.hasNoMx = fact.hasNoMx;
  if (fact.isCatchAll !== undefined) {
    data.isCatchAll = fact.isCatchAll;
    if (fact.source) data.catchAllSource = fact.source;
  }
  if (Object.keys(data).length === 0) return;

  await prisma.domainCache.upsert({
    where: { domain },
    create: { domain, ...data, observations: 1 },
    update: { ...data, observations: { increment: 1 } },
  });
}

// A domain-level answer for an address, or null if the domain tells us
// nothing conclusive.
export function verdictFromDomain(
  facts: DomainFacts | undefined
): { status: "invalid" | "risky"; reason: string } | null {
  if (!facts) return null;

  // No mail exchanger means the domain cannot receive mail at all, so every
  // address at it is undeliverable regardless of the mailbox.
  if (facts.hasNoMx === true) {
    return { status: "invalid", reason: "Domain has no MX record" };
  }

  // A confirmed catch-all accepts everything, so the paid pass can only
  // report accept-all again -- paying per address to hear the same answer.
  if (facts.catchAllConfirmed) {
    return { status: "risky", reason: "Domain confirmed catch-all" };
  }

  return null;
}
