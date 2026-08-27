import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserForApi } from "@/lib/require-user";

export async function GET(_req: Request, { params }: { params: { listId: string } }) {
  const { response } = await requireUserForApi();
  if (response) return response;

  const list = await prisma.list.findUnique({ where: { id: params.listId } });
  if (!list) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [
    stageGroups,
    statusGroups,
    sourceGroups,
    n2bBatches,
    creditSpend,
    parkedReasons,
    fullBreakdown,
  ] = await Promise.all([
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
      // Why each still-unresolved row would need the paid pass -- shown at
      // the review step so the spend decision is made on specifics, not on
      // a bare count.
      prisma.listRow.groupBy({
        by: ["mtnMessage"],
        where: { listId: list.id, stage: "needs_n2b" },
        _count: true,
      }),
      // Every row accounted for: what the cheap pass said, and where that
      // leaves it. This is the full picture, not just the escalations.
      prisma.listRow.groupBy({
        by: ["mtnMessage", "stage", "finalStatus"],
        where: { listId: list.id },
        _count: true,
      }),
    ]);

  function toCountMap<T extends { _count: number }>(groups: T[], keyOf: (g: T) => string | null) {
    return Object.fromEntries(groups.map((g) => [keyOf(g) ?? "unknown", g._count]));
  }

  const stageCounts = toCountMap(stageGroups, (g) => g.stage);
  const byFinalStatus = toCountMap(statusGroups, (g) => g.finalStatus);
  const bySource = toCountMap(sourceGroups, (g) => g.finalSource);
  const resolved = Object.values(byFinalStatus).reduce((a: number, b) => a + (b as number), 0);
  const pendingN2b = stageCounts.needs_n2b ?? 0;

  return NextResponse.json({
    status: list.status,
    lastError: list.lastError,
    totalRows: list.totalRows,
    // Pre-flight accounting: what was in the file vs what will be verified.
    preflight: {
      sourceRowCount: list.sourceRowCount,
      skippedInvalid: list.skippedInvalid,
      skippedDupes: list.skippedDupes,
      knownFromCache: stageCounts.cache_hit ?? 0,
      toVerify: stageCounts.pending ?? 0,
    },
    resolved,
    stageCounts,
    byFinalStatus,
    bySource,
    n2bCreditsSpent: creditSpend._sum.amount ?? 0,
    // The review step's decision data: what the paid pass would cost, and
    // the reason behind each row it would cover.
    pendingN2b,
    pendingN2bReasons: parkedReasons
      .map((g) => ({ reason: g.mtnMessage ?? "No response", count: g._count }))
      .sort((a, b) => b.count - a.count),
    // Full accounting: one line per distinct MTN reply, what it means, and
    // whether it is settled or headed for the paid pass.
    breakdown: fullBreakdown
      .map((g) => ({
        mtnMessage: g.mtnMessage ?? (g.stage === "cache_hit" ? "Known from cache" : "Not checked"),
        stage: g.stage,
        finalStatus: g.finalStatus,
        count: g._count,
        escalates: g.stage === "needs_n2b",
      }))
      .sort((a, b) => Number(a.escalates) - Number(b.escalates) || b.count - a.count),
    n2bBatches: n2bBatches.map((b) => ({
      id: b.id,
      status: b.status,
      emailCount: b.emailCount,
      submittedAt: b.submittedAt,
      completedAt: b.completedAt,
    })),
  });
}
