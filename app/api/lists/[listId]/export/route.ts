import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildExportCsv } from "@/lib/csv";

export async function GET(_req: Request, { params }: { params: { listId: string } }) {
  const list = await prisma.list.findUnique({ where: { id: params.listId } });
  if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await prisma.listRow.findMany({
    where: { listId: list.id },
    orderBy: { createdAt: "asc" },
  });

  const csv = buildExportCsv(
    rows.map((r) => ({
      email: r.rawEmail,
      finalStatus: r.finalStatus ?? "unresolved",
      finalSource: r.finalSource ?? "",
      mtnMessage: r.mtnMessage,
      n2bStatus: r.n2bStatus,
    }))
  );

  const filename = `${list.name.replace(/[^a-z0-9_-]+/gi, "_")}_verified.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
