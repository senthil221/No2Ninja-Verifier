import { NextResponse } from "next/server";
import type { FinalStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildExportCsv } from "@/lib/csv";

// Named export sets, so a send list can be pulled without hand-filtering a
// spreadsheet. Results from both providers are merged into one file --
// which engine resolved a row is a column, not a separate export.
const PRESETS: Record<string, { statuses: FinalStatus[]; suffix: string }> = {
  all: { statuses: ["valid", "invalid", "risky", "unknown"], suffix: "all" },
  valid: { statuses: ["valid"], suffix: "valid_only" },
  // Catch-all domains accepted the address but confirm nothing. Sending to
  // them is a judgement call, so they are a deliberate opt-in rather than
  // being folded into "valid".
  sendable: { statuses: ["valid", "risky"], suffix: "valid_plus_risky" },
  bad: { statuses: ["invalid"], suffix: "invalid_only" },
};

export async function GET(req: Request, { params }: { params: { listId: string } }) {
  const list = await prisma.list.findUnique({ where: { id: params.listId } });
  if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });

  const requested = new URL(req.url).searchParams.get("filter") ?? "all";
  const preset = PRESETS[requested] ?? PRESETS.all!;

  const rows = await prisma.listRow.findMany({
    where:
      requested === "all"
        ? { listId: list.id }
        : { listId: list.id, finalStatus: { in: preset.statuses } },
    orderBy: { createdAt: "asc" },
  });

  const csv = buildExportCsv(
    list.columnHeaders,
    rows.map((r) => ({
      rawRow: r.rawRow as Record<string, unknown>,
      finalStatus: r.finalStatus ?? "unresolved",
      finalSource: r.finalSource ?? "",
      mtnMessage: r.mtnMessage,
      n2bStatus: r.n2bStatus,
    }))
  );

  const safeName = list.name.replace(/[^a-z0-9_-]+/gi, "_");
  const filename = `${safeName}_${preset.suffix}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
