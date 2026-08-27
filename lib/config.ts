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

  emailCacheTtlDays: int("EMAIL_CACHE_TTL_DAYS", 90),
};

export function assertProviderKeysConfigured() {
  required("MTN_API_KEY");
  required("N2B_API_TOKEN");
}
