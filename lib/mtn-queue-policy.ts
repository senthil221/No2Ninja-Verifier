// Queue policy kept free of Redis/Prisma imports so its safety rules can be
// tested without opening production-like connections in the unit suite.

export function mtnJobId(listRowId: string): string {
  // BullMQ custom IDs deduplicate jobs while they are waiting/active. The
  // prefix also avoids its numeric-ID restriction, and deliberately contains
  // no colon because BullMQ reserves that separator.
  return `mtn-${listRowId}`;
}

export function shouldProcessMtnJob(
  listStatus: string | null | undefined,
  rowStage: string | null | undefined
): boolean {
  // A queued job is only useful while both the list and row still expect an
  // MTN answer. This makes historical duplicate jobs harmless: they are
  // discarded without consuming a provider request; scheduler reconciliation
  // drains them so they do not waste paced worker starts either.
  return listStatus === "running_mtn" && rowStage === "pending";
}
