export type VerificationAccountingInput = {
  liveMtnChecked: number;
  stageCounts: Record<string, number>;
  bySource: Record<string, number>;
};

export type VerificationAccounting = {
  checkedByMtn: number;
  reusedFromCacheOrDomain: number;
  resolvedByMtn: number;
  escalatedToN2b: number;
  resolvedByN2b: number;
  waitingForMtn: number;
};

// A provider source answers "who established the final result?", not "who
// checked this row?". Keep both concepts explicit so an inconclusive MTN
// response that proceeds to N2B never disappears from the progress maths.
export function buildVerificationAccounting({
  liveMtnChecked,
  stageCounts,
  bySource,
}: VerificationAccountingInput): VerificationAccounting {
  const resolvedByMtn = bySource.mtn ?? 0;

  return {
    checkedByMtn: liveMtnChecked,
    reusedFromCacheOrDomain: bySource.cache ?? 0,
    resolvedByMtn,
    escalatedToN2b: Math.max(0, liveMtnChecked - resolvedByMtn),
    resolvedByN2b: bySource.n2b ?? 0,
    waitingForMtn: stageCounts.pending ?? 0,
  };
}

export type VerificationPhase = "preflight" | "mtn" | "n2b" | "done";

export function verificationPhase(
  status: string,
  accounting: Pick<VerificationAccounting, "waitingForMtn" | "escalatedToN2b">
): VerificationPhase {
  if (status === "pending") return "preflight";
  if (status === "completed") return "done";
  if (status === "running_n2b") return "n2b";
  if (
    (status === "failed" || status === "stopped") &&
    accounting.waitingForMtn === 0 &&
    accounting.escalatedToN2b > 0
  ) {
    return "n2b";
  }
  return "mtn";
}
