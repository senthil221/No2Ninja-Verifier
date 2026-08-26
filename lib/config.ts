function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  mtn: {
    apiKey: process.env.MTN_API_KEY ?? "",
    baseUrl: process.env.MTN_BASE_URL ?? "https://happy.mailtester.ninja/ninja",
    rateLimitMax: int("MTN_RATE_LIMIT_MAX", 57),
    rateLimitWindowMs: int("MTN_RATE_LIMIT_WINDOW_MS", 10_000),
    maxRetries: int("MTN_MAX_RETRIES", 3),
  },

  n2b: {
    apiToken: process.env.N2B_API_TOKEN ?? "",
    baseUrl: process.env.N2B_BASE_URL ?? "https://connect.no2bounce.com/v2/n2b_validate_bulk",
    pollIntervalMs: int("N2B_POLL_INTERVAL_MS", 15_000),
    singleListCreditCap: int("N2B_SINGLE_LIST_CREDIT_CAP", 5000),
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
