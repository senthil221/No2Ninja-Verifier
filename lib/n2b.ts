import { config } from "./config";

export interface N2bSubmitResponse {
  trackingId: string;
}

export type N2bPollResult =
  | { state: "in_progress"; totalEmails: number; completedEmails: number }
  | { state: "complete_inline"; rows: N2bRowResult[] }
  | { state: "complete_signed_url"; signedUrl: string }
  | { state: "failed"; error: string };

export interface N2bRowResult {
  email: string;
  // Normalized to the pipeline's own vocabulary — see mapN2bStatus below.
  status: "valid" | "invalid" | "risky" | "unknown";
  rawStatus: string;
}

function authHeaders() {
  return {
    apitoken: config.n2b.apiToken,
    "Content-Type": "application/json",
  };
}

export class N2bClient {
  async submitBulk(emails: string[], hashkey?: string): Promise<N2bSubmitResponse> {
    const res = await fetch(config.n2b.baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        emailList: emails,
        ...(hashkey ? { hashkey } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`N2B submit failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data: { trackingId: number | string } };
    return { trackingId: String(json.data.trackingId) };
  }

  async poll(trackingId: string): Promise<N2bPollResult> {
    const url = new URL(config.n2b.baseUrl);
    url.searchParams.set("trackingId", trackingId);

    const res = await fetch(url.toString(), { method: "GET", headers: authHeaders() });
    if (!res.ok) {
      return { state: "failed", error: `N2B poll failed: ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as { data: Record<string, unknown> };
    const data = json.data;

    if (typeof data.signedUrl === "string") {
      return { state: "complete_signed_url", signedUrl: data.signedUrl };
    }

    // NOTE: the public docs page does not show the exact shape of a
    // completed *small* (<=20K) list response. This defensively probes the
    // most likely field names. VERIFY against a real test batch and adjust
    // here if the actual key differs — this is the one integration point
    // built without a confirmed example response.
    const inlineRows =
      (data.results as unknown[]) ?? (data.emails as unknown[]) ?? (data.list as unknown[]);
    if (Array.isArray(inlineRows)) {
      return { state: "complete_inline", rows: inlineRows.map(parseInlineRow) };
    }

    if (
      typeof data.totalEmails === "number" &&
      typeof data.completedEmails === "number" &&
      data.completedEmails < data.totalEmails
    ) {
      return {
        state: "in_progress",
        totalEmails: data.totalEmails,
        completedEmails: data.completedEmails,
      };
    }

    return { state: "failed", error: "Unrecognized N2B poll response shape" };
  }

  // Downloads and parses the CSV behind a signedUrl (used for result sets >20K).
  // Column names are not documented publicly; this probes common header
  // variants. VERIFY against a real large-batch export.
  async fetchSignedUrlResults(signedUrl: string): Promise<N2bRowResult[]> {
    const res = await fetch(signedUrl);
    if (!res.ok) {
      throw new Error(`Failed to download N2B result file: ${res.status}`);
    }
    const text = await res.text();
    const [headerLine, ...lines] = text.trim().split(/\r?\n/);
    const headers = (headerLine ?? "").split(",").map((h) => h.trim().toLowerCase());
    const emailIdx = headers.findIndex((h) => h.includes("email"));
    const statusIdx = headers.findIndex(
      (h) => h.includes("status") || h.includes("result") || h.includes("deliverab")
    );

    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const cols = line.split(",");
        const email = (cols[emailIdx] ?? "").trim().replace(/^"|"$/g, "");
        const rawStatus = (cols[statusIdx] ?? "").trim().replace(/^"|"$/g, "");
        return { email, status: mapN2bStatus(rawStatus), rawStatus };
      });
  }
}

function parseInlineRow(row: unknown): N2bRowResult {
  const r = row as Record<string, unknown>;
  const email = String(r.email ?? r.address ?? "");
  const rawStatus = String(r.status ?? r.result ?? r.deliverability ?? r.verdict ?? "unknown");
  return { email, status: mapN2bStatus(rawStatus), rawStatus };
}

function mapN2bStatus(rawStatus: string): N2bRowResult["status"] {
  const s = rawStatus.toLowerCase();
  if (s.includes("deliver") || s === "valid" || s === "ok") return "valid";
  if (s.includes("invalid") || s.includes("bounce")) return "invalid";
  if (s.includes("catch") || s.includes("spam") || s.includes("risky")) return "risky";
  return "unknown";
}

export const n2bClient = new N2bClient();
