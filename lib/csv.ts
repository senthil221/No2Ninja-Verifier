import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface ParsedRow {
  rawEmail: string;
  normalizedEmail: string;
  // The full original row (every column from the uploaded file, including
  // the email column) so it survives the pipeline and comes back on export.
  rawRow: Record<string, string>;
}

export interface ParsedCsv {
  headers: string[];
  rows: ParsedRow[];
}

// Parses a CSV, auto-detects the email column by header name (falls back to
// the first column), normalizes + dedupes within the file. Every other
// column is preserved verbatim per row for later export.
export function parseEmailCsv(fileContents: string): ParsedCsv {
  const records = parse(fileContents, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = Object.keys(records[0]!);
  const emailHeader =
    headers.find((h) => h.toLowerCase() === "email") ??
    headers.find((h) => h.toLowerCase().includes("email")) ??
    headers[0]!;

  const seen = new Set<string>();
  const rows: ParsedRow[] = [];

  for (const record of records) {
    const rawEmail = (record[emailHeader] ?? "").trim();
    if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) continue;

    const normalizedEmail = normalizeEmail(rawEmail);
    if (seen.has(normalizedEmail)) continue;
    seen.add(normalizedEmail);

    rows.push({ rawEmail, normalizedEmail, rawRow: record });
  }

  return { headers, rows };
}

export interface ExportRow {
  rawRow: Record<string, unknown>;
  finalStatus: string;
  finalSource: string;
  mtnMessage: string | null;
  n2bStatus: string | null;
}

// Re-emits every original column (in the order the user uploaded them) plus
// the verification columns appended at the end.
export function buildExportCsv(originalHeaders: string[], rows: ExportRow[]): string {
  const columns = [
    ...originalHeaders.map((h) => ({ key: h, header: h })),
    { key: "final_status", header: "final_status" },
    { key: "resolved_by", header: "resolved_by" },
    { key: "mtn_message", header: "mtn_message" },
    { key: "n2b_status", header: "n2b_status" },
  ];

  const records = rows.map((r) => ({
    ...r.rawRow,
    final_status: r.finalStatus,
    resolved_by: r.finalSource,
    mtn_message: r.mtnMessage,
    n2b_status: r.n2bStatus,
  }));

  return stringify(records, { header: true, columns });
}
