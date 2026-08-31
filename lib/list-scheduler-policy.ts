export const ACTIVE_VERIFICATION_STATUSES = ["running_mtn", "running_n2b"] as const;

export function isActiveVerificationStatus(status: string): boolean {
  return (ACTIVE_VERIFICATION_STATUSES as readonly string[]).includes(status);
}

export function shouldPollListStatus(status: string, hasAutoRetry: boolean): boolean {
  if (status === "completed") return false;
  if (status === "failed") return hasAutoRetry;
  return status !== "pending" && status !== "stopped";
}
