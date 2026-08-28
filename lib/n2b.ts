import { config } from "./config";

export interface N2bSubmitResponse {
  trackingId: string;
}

export type N2bPollResult =
  | { state: "in_progress"; totalEmails: number; completedEmails: number; percent: number }
  | { state: "complete"; rows: N2bRowResult[]; creditsDebited: number }
  | { state: "failed"; error: string };

export interface N2bRowResult {
  email: string;
  // Normalized to the pipeline's own vocabulary -- see mapN2bStatus below.
  status: "valid" | "invalid" | "risky" | "unknown";
  rawStatus: string;
  // The report's own catch-all flag. This is a fact about the domain, not
  // the address, which is what makes it reusable across every other address
  // at that domain.
  catchAll: boolean | null;
}

function authHeaders() {
  return {
    apitoken: config.n2b.apiToken,
    "Content-Type": "application/json",
  };
}

// Surfaces the API's own message instead of a bare status code. Its errors
// are specific and actionable ("hashkey is not allowed") and were previously
// being thrown away, which turned a one-line fix into a long hunt.
async function describeError(res: Response, prefix: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) detail = `: ${body.message}`;
  } catch {
    /* non-JSON body -- the status line is all we have */
  }
  return `${prefix} (HTTP ${res.status})${detail}`;
}

export class N2bClient {
  // NOTE: the documented `hashkey` de-duplication parameter is rejected by
  // the live API ("hashkey is not allowed"), so it is deliberately not sent.
  async submitBulk(emails: string[]): Promise<N2bSubmitResponse> {
    const res = await fetch(config.n2b.baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ emailList: emails }),
    });
    if (!res.ok) {
      throw new Error(await describeError(res, "No2Bounce rejected the batch"));
    }
    const json = (await res.json()) as { data?: { trackingId?: number | string } };
    const trackingId = json.data?.trackingId;
    if (trackingId === undefined || trackingId === null) {
      throw new Error("No2Bounce accepted the batch but returned no trackingId");
    }
    return { trackingId: String(trackingId) };
  }

  // The poll response is shaped differently from the submit response: submit
  // wraps its payload in `data`, poll returns the fields at the top level.
  async poll(trackingId: string): Promise<N2bPollResult> {
    const url = new URL(config.n2b.baseUrl);
    url.searchParams.set("trackingId", trackingId);

    const res = await fetch(url.toString(), { method: "GET", headers: authHeaders() });
    if (!res.ok) {
      // An unknown trackingId reports itself as an invalid API key, so say
      // so rather than sending someone off to regenerate a working token.
      const detail = await describeError(res, "No2Bounce poll failed");
      return {
        state: "failed",
        error: `${detail} (note: this endpoint reports an unknown trackingId as an invalid key)`,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const overall = String(data.overallStatus ?? "");
    const totalEmails = Number(data.totalRecord ?? 0);
    const downloadFile = (data.result as { downloadFile?: unknown } | undefined)?.downloadFile;

    if (overall.toLowerCase() === "pending" || !downloadFile) {
      const percent = Number(data.percent ?? 0);
      return {
        state: "in_progress",
        totalEmails,
        completedEmails: Math.round((percent / 100) * totalEmails),
        percent,
      };
    }

    const rows = await this.fetchResultFile(String(downloadFile));
    return { state: "complete", rows, creditsDebited: Number(data.creditDebited ?? 0) };
  }

  // Downloads and parses the per-address results. Column names are not
  // documented, so match on substrings rather than exact headers.
  async fetchResultFile(fileUrl: string): Promise<N2bRowResult[]> {
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Failed to download No2Bounce results: HTTP ${res.status}`);
    }
    const text = await res.text();

    // The file may be JSON or CSV depending on batch size; handle both.
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : (parsed.results ?? parsed.data ?? []);
      return (list as unknown[]).map(parseJsonRow);
    }

    return parseResultCsv(trimmed);
  }
}

// The live report is:
//   "email","finalScore","finalScoreValue","catchall"
// with finalScoreValue carrying the verdict ("Deliverable/AcceptAll" etc).
// Exported so the real observed format stays pinned by tests.
export function parseResultCsv(text: string): N2bRowResult[] {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = (headerLine ?? "").split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());

  const emailIdx = headers.findIndex((h) => h === "email") >= 0
    ? headers.findIndex((h) => h === "email")
    : headers.findIndex((h) => h.includes("email"));

  // "finalScoreValue" contains none of the words a naive match would look
  // for, so name it explicitly before falling back to heuristics.
  const statusIdx = (() => {
    const exact = headers.indexOf("finalscorevalue");
    if (exact >= 0) return exact;
    return headers.findIndex(
      (h) =>
        (h.includes("score") && h.includes("value")) ||
        h.includes("status") ||
        h.includes("result") ||
        h.includes("deliverab")
    );
  })();

  const catchAllIdx = headers.findIndex((h) => h.includes("catchall") || h.includes("catch_all"));

  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = splitCsvLine(line);
      const email = (cols[emailIdx] ?? "").trim();
      const rawStatus = (cols[statusIdx] ?? "").trim();
      const catchAllRaw = catchAllIdx >= 0 ? (cols[catchAllIdx] ?? "").trim().toLowerCase() : "";
      const catchAll =
        catchAllRaw === "true" ? true : catchAllRaw === "false" ? false : null;
      return { email, status: mapN2bStatus(rawStatus), rawStatus, catchAll };
    });
}

function splitCsvLine(line: string): string[] {
  return line
    .split(",")
    .map((c) => c.trim().replace(/^"|"$/g, ""));
}

function parseJsonRow(row: unknown): N2bRowResult {
  const r = row as Record<string, unknown>;
  const email = String(r.email ?? r.address ?? r.Email ?? "");
  const rawStatus = String(
    r.status ?? r.result ?? r.deliverability ?? r.Status ?? r.verdict ?? "unknown"
  );
  const rawCatchAll = r.catchall ?? r.catchAll ?? r.catch_all;
  return {
    email,
    status: mapN2bStatus(rawStatus),
    rawStatus,
    catchAll: typeof rawCatchAll === "boolean" ? rawCatchAll : null,
  };
}

// Maps No2Bounce's vocabulary onto ours.
//
// The report answers with one of: Deliverable, CatchAll/AcceptAll, Invalid,
// Bounce or Spam -- on its own or combined, as in "Deliverable/AcceptAll".
// Exactly one of those becomes "valid": a plain Deliverable, which is the
// provider confirming the mailbox itself. Everything else is held back.
//
// The order below is the whole point, and each step is load-bearing:
//
//   1. Invalid / Bounce / UnDeliverable are conclusive whatever is combined
//      with them. Also first because "UnDeliverable" literally contains
//      "deliverable" -- checking valid earlier would call it deliverable.
//   2. Accept-all and spam are disqualifiers, not verdicts on the mailbox.
//      An accept-all Deliverable is the domain saying yes to every address,
//      and a spam trap is deliverable in the literal sense and ruinous to
//      send to. Both arrive combined with "Deliverable", so they have to be
//      ruled out before it is honoured.
//   3. Only then is a bare Deliverable read as valid.
function mapN2bStatus(rawStatus: string): N2bRowResult["status"] {
  const s = rawStatus.toLowerCase().trim();
  if (!s) return "unknown";

  if (s.includes("undeliverable") || s.includes("invalid") || s.includes("bounce")) {
    return "invalid";
  }

  if (
    s.includes("acceptall") ||
    s.includes("accept all") ||
    s.includes("catch") ||
    s.includes("spam") ||
    s.includes("risky")
  ) {
    return "risky";
  }

  if (s.includes("deliverable") || s === "valid" || s === "ok") return "valid";

  // A verdict we do not recognise is never guessed into the send list.
  if (s.includes("unknown")) return "risky";
  return "unknown";
}

export const n2bClient = new N2bClient();
