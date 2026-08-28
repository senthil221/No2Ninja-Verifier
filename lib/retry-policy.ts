import { config } from "./config";

// Whether a failure is worth retrying on its own, or needs a person.
//
// The two shapes of error this project actually produces:
//   - Node's fetch (undici) surfaces a network-level failure -- DNS,
//     connection refused, timeout -- as a bare "fetch failed" with no HTTP
//     status at all. That is exactly the class a retry fixes.
//   - Our own errors (see lib/n2b.ts describeError) embed the provider's
//     HTTP status as "(HTTP nnn)". 5xx and 429 are the provider's own
//     transient trouble; any other 4xx means the request itself was wrong
//     -- a rejected batch shape, a bad key -- and retrying only sends the
//     same bad request again.
//
// Takes a string rather than an Error because by the time some failures
// reach here (a poll() response that returns rather than throws) the
// original Error object no longer exists, only its message.
export function isRetryableFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");

  if (/fetch failed/i.test(message)) return true;

  const httpStatus = message.match(/\(HTTP (\d{3})\)/);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    return status >= 500 || status === 429;
  }

  // Unrecognised shape: default to not retryable. Auto-retrying something
  // we cannot classify risks quietly looping on a real bug instead of
  // surfacing it.
  return false;
}

// Exponential backoff from the configured base, capped so a long outage
// still gets checked periodically rather than the delay growing without
// bound. attempt is 1-based.
export function autoRetryDelayMs(attempt: number): number {
  const raw = config.autoRetry.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, config.autoRetry.maxDelayMs);
}
