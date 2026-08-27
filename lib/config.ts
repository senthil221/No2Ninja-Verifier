function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

// Dashboards hand these out wrapped in decoration -- MailTester Ninja's docs
// explicitly say to use the subscription key "without curly braces", and a
// copy-paste easily carries surrounding whitespace or quotes. A key that is
// correct-but-wrapped fails auth in a way that looks like a bad key, so
// normalize it here rather than making every deploy debug it.
function credential(name: string): string {
  return (process.env[name] ?? "").trim().replace(/^["'{]+|["'}]+$/g, "").trim();
}

// `new URL()` accepts any scheme, so a typo like "htt1ps://" parses fine and
// only surfaces later as an opaque "fetch failed" on every single row. Check
// the scheme up front so a bad URL is a startup error naming the variable,
// not a per-row mystery.
function endpoint(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "") || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `${name} must start with https:// (got ${JSON.stringify(parsed.protocol)} in ${JSON.stringify(raw)})`
    );
  }
  return raw;
}

export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  mtn: {
    apiKey: credential("MTN_API_KEY"),
    baseUrl: endpoint("MTN_BASE_URL", "https://happy.mailtester.ninja/ninja"),
    rateLimitMax: int("MTN_RATE_LIMIT_MAX", 57),
    rateLimitWindowMs: int("MTN_RATE_LIMIT_WINDOW_MS", 10_000),
    maxRetries: int("MTN_MAX_RETRIES", 3),
    // How many checks are in flight at once. This does not raise the request
    // rate -- the limiter above is the ceiling and still applies -- it only
    // stops a slow SMTP probe from stalling the queue behind it. Calls are
    // latency-bound (often ~1s, occasionally 7s), so at concurrency 1 the
    // pipeline ran at roughly a tenth of the plan's allowance.
    // Needs to be at least ceiling x mean-latency to keep the limit saturated.
    concurrency: int("MTN_CONCURRENCY", 12),
  },

  n2b: {
    apiToken: credential("N2B_API_TOKEN"),
    baseUrl: endpoint("N2B_BASE_URL", "https://connect.no2bounce.com/v2/n2b_validate_bulk"),
    pollIntervalMs: int("N2B_POLL_INTERVAL_MS", 15_000),
    singleListCreditCap: int("N2B_SINGLE_LIST_CREDIT_CAP", 5000),
    // Every list pauses after the cheap pass so a human sees what it found
    // and what the paid pass would cost before any credits are spent. Set
    // N2B_REQUIRE_APPROVAL=false to auto-continue under the credit cap.
    requireApproval: process.env.N2B_REQUIRE_APPROVAL !== "false",
  },

  catchAllHandling: (process.env.CATCH_ALL_HANDLING === "accept" ? "accept" : "n2b") as
    | "accept"
    | "n2b",

  // What the cheap pass hands on to the paid pass.
  //   all_except_valid - anything MTN did not confirm deliverable gets a
  //                      second opinion. Costs more, but MTN's "Rejected"
  //                      can be a false negative (servers that refuse
  //                      verification probes), and a wrongly discarded
  //                      prospect costs more than a credit.
  //   unresolved       - only rows MTN could not answer (catch-all, blocked)
  //                      escalate; its invalid verdicts are trusted as final.
  mtnEscalationPolicy: (process.env.MTN_ESCALATION_POLICY === "unresolved"
    ? "unresolved"
    : "all_except_valid") as "all_except_valid" | "unresolved",

  emailCacheTtlDays: int("EMAIL_CACHE_TTL_DAYS", 90),

  // Reuse of domain-level facts (no-MX, confirmed catch-all). Shorter TTL
  // than the address cache because a domain's mail configuration can change
  // in a way an individual mailbox result cannot.
  domainCacheEnabled: process.env.DOMAIN_CACHE_ENABLED !== "false",
  domainCacheTtlDays: int("DOMAIN_CACHE_TTL_DAYS", 45),

  // Where pipeline events are posted. A webhook rather than email/Slack
  // directly, so routing (who gets told, and how) stays a workflow concern
  // rather than something baked into this app.
  alertWebhookUrl: (process.env.ALERT_WEBHOOK_URL ?? "").trim(),
  // Used to build clickable links in alerts.
  publicUrl: (process.env.PUBLIC_URL ?? "").trim(),
};

export function assertProviderKeysConfigured() {
  required("MTN_API_KEY");
  required("N2B_API_TOKEN");
}
