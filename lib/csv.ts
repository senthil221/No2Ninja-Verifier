import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface ParsedRow {
  rawEmail: string;
  normalizedEmail: string;
}

// Parses a CSV, auto-detects the email column by header name (falls back to
// the first column), normalizes + dedupes within the file.
export function parseEmailCsv(fileContents: string): ParsedRow[] {
  const records = parse(fileContents, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (records.length === 0) return [];

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

    rows.push({ rawEmail, normalizedEmail });
  }

  return rows;
}

export interface ExportRow {
  email: string;
  finalStatus: string;
  finalSource: string;
  mtnMessage: string | null;
  n2bStatus: string | null;
}

export function buildExportCsv(rows: ExportRow[]): string {
  return stringify(rows, {
    header: true,
    columns: [
      { key: "email", header: "email" },
      { key: "finalStatus", header: "final_status" },
      { key: "finalSource", header: "resolved_by" },
      { key: "mtnMessage", header: "mtn_message" },
      { key: "n2bStatus", header: "n2b_status" },
    ],
  });
}
