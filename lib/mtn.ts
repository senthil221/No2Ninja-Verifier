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

const MESSAGE_OUTCOME: Record<string, MtnOutcome> = {
  Accepted: "valid",
  Limited: "valid",
  Rejected: "invalid",
  "No Mx": "invalid",
  "Catch-All": "ambiguous",
  "Mx Error": "transient",
  Timeout: "transient",
  "SPAM Block": "transient",
  "Disabled Key": "fatal",
};

export function classifyMtnMessage(message: string): MtnOutcome {
  const known = MESSAGE_OUTCOME[message];
  if (known) return known;

  // Undocumented account-level failures ("Invalid Key", "Quota Exceeded",
  // "Expired Subscription", ...) must be treated as fatal, not retried and
  // escalated -- erring toward "stop and tell someone" is far cheaper than
  // erring toward "send the whole list to the paid provider".
  if (/\b(key|quota|subscription|credit|expired|suspend|disabled|unauthor)/i.test(message)) {
    return "fatal";
  }
  return "transient";
}

export class MtnClient {
  async verify(email: string): Promise<MtnResult> {
    const url = new URL(config.mtn.baseUrl);
    url.searchParams.set("email", email);
    url.searchParams.set("key", config.mtn.apiKey);

    const res = await fetch(url.toString(), { method: "GET" });
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
