import { config } from "./config";

export type MtnCode = "ok" | "ko" | "mb";

export interface MtnResult {
  email: string;
  code: MtnCode;
  message: string;
  raw: unknown;
}

// How a raw MTN response maps onto the pipeline's decision tree.
//   - final/valid    -> row is done, mark valid
//   - final/invalid  -> row is done, mark invalid, no retry
//   - transient      -> retry on MTN before giving up
//   - ambiguous      -> catch-all; behavior controlled by CATCH_ALL_HANDLING
//   - fatal          -> our account/key is broken, not this address. Stop the
//                       whole list. Never escalate these to N2B: a bad key
//                       would otherwise dump every row of a 20k list into the
//                       expensive provider and silently burn 20k credits.
export type MtnOutcome = "valid" | "invalid" | "transient" | "ambiguous" | "fatal";

// Keyed on the normalized message (see normalize below). The docs and the
// live API disagree on casing -- docs say "No Mx"/"Mx Error", the API
// actually sends "No MX"/"MX Error" -- so never match these literally.
// Getting this wrong is expensive: an unmatched message falls through to
// "transient", which retries and then escalates a row that MTN had already
// answered definitively, paying the expensive provider for nothing.
const MESSAGE_OUTCOME: Record<string, MtnOutcome> = {
  accepted: "valid",
  // Deliberately not "valid": we have never observed which code accompanies
  // "Limited", and asserting deliverability we cannot back sends mail to an
  // unverified address. A bounce costs sender reputation; escalating costs
  // one credit. When the code is present it decides this anyway.
  limited: "transient",
  rejected: "invalid",
  "no mx": "invalid",
  "catch-all": "ambiguous",
  "mx error": "transient",
  timeout: "transient",
  "spam block": "transient",
  "disabled key": "fatal",
};

function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

// MTN states the contract on `code`: ok = valid, ko = invalid, mb =
// unverifiable. Prefer it over the message string so a message we have never
// seen is still categorised by the provider's own verdict rather than by our
// guess at what the wording means. `message` then refines the unverifiable
// case, which is the only one where the right next step varies.
export function classifyMtnResult(code: string, message: string): MtnOutcome {
  // An account-level failure is not a statement about the address at all.
  if (isAccountFailure(message)) return "fatal";

  switch (normalize(code)) {
    case "ok":
      return "valid";
    case "ko":
      return "invalid";
    case "mb":
      // Catch-all is answerable by a better provider; the rest (Timeout, MX
      // Error, SPAM Block) are worth retrying on the cheap pass first.
      return normalize(message) === "catch-all" ? "ambiguous" : "transient";
    default:
      // Unrecognised code -- fall back to reading the message.
      return classifyMtnMessage(message);
  }
}

function isAccountFailure(message: string): boolean {
  return /\b(key|quota|subscription|credit|expired|suspend|disabled|unauthor)/i.test(message);
}

// Message-only classification, for rows recorded before the code was stored
// and as the fallback above.
export function classifyMtnMessage(message: string): MtnOutcome {
  const known = MESSAGE_OUTCOME[normalize(message)];
  if (known) return known;

  // Undocumented account-level failures ("Invalid Key", "Quota Exceeded",
  // "Expired Subscription", ...) must be treated as fatal, not retried and
  // escalated -- erring toward "stop and tell someone" is far cheaper than
  // erring toward "send the whole list to the paid provider".
  if (isAccountFailure(message)) return "fatal";
  return "transient";
}

// Being told to slow down is not a failure of the address, the key, or the
// network -- it is a scheduling problem, and must be handled by backing off
// rather than by giving up on the row (or worse, the list).
export class MtnRateLimitedError extends Error {
  constructor(public retryAfterMs: number) {
    super(`MTN rate limited (429), backing off ${retryAfterMs}ms`);
    this.name = "MtnRateLimitedError";
  }
}

export class MtnClient {
  async verify(email: string): Promise<MtnResult> {
    const url = new URL(config.mtn.baseUrl);
    url.searchParams.set("email", email);
    url.searchParams.set("key", config.mtn.apiKey);

    const res = await fetch(url.toString(), { method: "GET" });

    if (res.status === 429) {
      // Honour Retry-After when offered; otherwise wait out a full window,
      // which is long enough for any burst allowance to refill.
      const header = res.headers.get("retry-after");
      const fromHeader = header ? Number(header) * 1000 : NaN;
      const waitMs = Number.isFinite(fromHeader)
        ? Math.max(fromHeader, 1000)
        : config.mtn.rateLimitWindowMs;
      throw new MtnRateLimitedError(waitMs);
    }

    if (!res.ok) {
      throw new Error(`MTN request failed: ${res.status} ${res.statusText}`);
    }
    const raw = (await res.json()) as { email: string; code: MtnCode; message: string };
    return {
      email: raw.email ?? email,
      code: raw.code,
      message: raw.message,
      raw,
    };
  }
}

export const mtnClient = new MtnClient();
