export const ACTIVE_VERIFICATION_STATUSES = ["running_mtn", "running_n2b"] as const;

// PostgreSQL's advisory-lock function returns `void`, which Prisma cannot
// deserialize. Keep the supported scalar cast explicit and regression-tested.
// The lock id remains a bound parameter, not interpolated SQL.
export const VERIFICATION_SCHEDULER_LOCK_SQL =
  'SELECT pg_advisory_xact_lock($1)::text AS "lockResult"';

export function isActiveVerificationStatus(status: string): boolean {
  return (ACTIVE_VERIFICATION_STATUSES as readonly string[]).includes(status);
}

export function shouldPollListStatus(status: string, hasAutoRetry: boolean): boolean {
  if (status === "completed") return false;
  if (status === "failed") return hasAutoRetry;
  return status !== "pending" && status !== "stopped";
}
