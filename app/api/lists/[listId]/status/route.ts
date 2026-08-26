import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { listId: string } }) {
  const list = await prisma.list.findUnique({ where: { id: params.listId } });
  if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [stageGroups, statusGroups, sourceGroups, n2bBatches, creditSpend] = await Promise.all([
    prisma.listRow.groupBy({ by: ["stage"], where: { listId: list.id }, _count: true }),
    prisma.listRow.groupBy({
      by: ["finalStatus"],
      where: { listId: list.id, finalStatus: { not: null } },
      _count: true,
    }),
    prisma.listRow.groupBy({
      by: ["finalSource"],
      where: { listId: list.id, finalSource: { not: null } },
      _count: true,
    }),
    prisma.n2bBatch.findMany({ where: { listId: list.id }, orderBy: { submittedAt: "desc" } }),
    prisma.creditLedger.aggregate({
      _sum: { amount: true },
      where: { listId: list.id, provider: "n2b" },
    }),
  ]);

  function toCountMap<T extends { _count: number }>(groups: T[], keyOf: (g: T) => string | null) {
    return Object.fromEntries(groups.map((g) => [keyOf(g) ?? "unknown", g._count]));
  }

  const stageCounts = toCountMap(stageGroups, (g) => g.stage);
  const byFinalStatus = toCountMap(statusGroups, (g) => g.finalStatus);
  const bySource = toCountMap(sourceGroups, (g) => g.finalSource);
  const resolved = Object.values(byFinalStatus).reduce((a: number, b) => a + (b as number), 0);

  return NextResponse.json({
    status: list.status,
    lastError: list.lastError,
    totalRows: list.totalRows,
    resolved,
    stageCounts,
    byFinalStatus,
    bySource,
    n2bCreditsSpent: creditSpend._sum.amount ?? 0,
    n2bBatches: n2bBatches.map((b) => ({
      id: b.id,
      status: b.status,
      emailCount: b.emailCount,
      submittedAt: b.submittedAt,
      completedAt: b.completedAt,
    })),
  });
}
