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
    // How many checks may be in flight at once. Starts are paced (see
    // requestIntervalMs), so this only decides how much provider/SMTP latency
    // can be absorbed -- it does not create bursts. MTN probes can take tens
    // of seconds; eight slots left most of the safe 57/10s allowance idle.
    concurrency: int("MTN_CONCURRENCY", 128),
    // A remote mail server must not hold a worker slot forever. This is long
    // enough for a real SMTP probe, while still guaranteeing eventual retry.
    requestTimeoutMs: int("MTN_REQUEST_TIMEOUT_MS", 90_000),
    // Multiplier on the plan's own interval. A window-based limit permits
    // the whole allowance to fire at once, which reads as a burst and earns
    // a 429 even while the per-window total is legal; pacing every request
    // evenly, slightly slower than the stated rate, does not.
    rateSafetyFactor: Number(process.env.MTN_RATE_SAFETY ?? "1.15"),
  },

  n2b: {
    apiToken: credential("N2B_API_TOKEN"),
    baseUrl: endpoint("N2B_BASE_URL", "https://connect.no2bounce.com/v2/n2b_validate_bulk"),
    pollIntervalMs: int("N2B_POLL_INTERVAL_MS", 15_000),
  },

  catchAllHandling: (process.env.CATCH_ALL_HANDLING === "accept" ? "accept" : "n2b") as
    | "accept"
    | "n2b",

  // Reuse is priced differently per provider, so the two are set separately.
  //
  // Mail Tester Ninja is flat-rate, so caching its verdicts saves nothing --
  // it only trades a free call for the risk of acting on a stale one. People
  // change roles and mailboxes are closed; a months-old "Accepted" becomes a
  // bounce, and bounces cost sender reputation. Default 0 (re-verify always).
  mtnCacheTtlDays: int("MTN_CACHE_TTL_DAYS", 0),
  // No2Bounce costs a credit per address, so its verdicts are worth
  // reusing. Its catch-all finding is a domain property and rarely changes.
  n2bCacheTtlDays: int("N2B_CACHE_TTL_DAYS", 90),

  // Reuse of domain-level facts (no-MX, confirmed catch-all). Shorter TTL
  // than the address cache because a domain's mail configuration can change
  // in a way an individual mailbox result cannot.
  domainCacheEnabled: process.env.DOMAIN_CACHE_ENABLED !== "false",
  domainCacheTtlDays: int("DOMAIN_CACHE_TTL_DAYS", 45),

  // Only these email domains may hold an account. Comma-separated.
  //
  // Note this is a gate on the address someone types, not proof they own it:
  // without an email confirmation step, anyone who reaches the sign-up page
  // can claim any address at an allowed domain. It keeps the wrong domain
  // out; it does not verify the person.
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? "b2bdrive.net")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),

  // Self-healing for failures that look transient (network blips, a
  // provider 5xx/429) -- see lib/retry-policy.ts for what qualifies. A list
  // stopped by one of these retries itself on a backoff schedule instead of
  // waiting for someone to notice and click Retry. Failures that are not
  // retryable (a bad key, a malformed request) always go straight to a
  // person: retrying those just delays finding out, since the same input
  // produces the same failure.
  autoRetry: {
    enabled: process.env.LIST_AUTO_RETRY_ENABLED !== "false",
    maxAttempts: int("LIST_AUTO_RETRY_MAX_ATTEMPTS", 8),
    baseDelayMs: int("LIST_AUTO_RETRY_BASE_DELAY_MS", 60_000),
    maxDelayMs: int("LIST_AUTO_RETRY_MAX_DELAY_MS", 30 * 60_000),
  },

  // Where pipeline events are posted. A webhook rather than email/Slack
  // directly, so routing (who gets told, and how) stays a workflow concern
  // rather than something baked into this app.
  alertWebhookUrl: (process.env.ALERT_WEBHOOK_URL ?? "").trim(),
  // Used to build clickable links in alerts.
  publicUrl: (process.env.PUBLIC_URL ?? "").trim(),
};

// Minimum gap between request starts, derived from the plan limit rather
// than hardcoded, so changing the plan changes the pacing.
// 57 per 10s -> 175ms apart -> x1.15 safety -> ~202ms, about 4.9/sec.
export function mtnRequestIntervalMs(): number {
  const base = config.mtn.rateLimitWindowMs / Math.max(1, config.mtn.rateLimitMax);
  return Math.ceil(base * config.mtn.rateSafetyFactor);
}

export function assertProviderKeysConfigured() {
  required("MTN_API_KEY");
  required("N2B_API_TOKEN");
}
