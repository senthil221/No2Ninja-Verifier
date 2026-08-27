import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redisConnection } from "@/lib/queue";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Unauthenticated on purpose so an uptime monitor can reach it, and
// therefore deliberately free of anything worth reading: dependency
// reachability and configuration presence, never counts, names or data.
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }

  try {
    await redisConnection.ping();
    checks.queue = "ok";
  } catch {
    checks.queue = "fail";
  }

  // Presence only. A misconfigured deploy is a far more common failure than
  // a revoked key, and checking properly would mean calling a paid provider
  // on every health poll.
  checks.mtnKey = config.mtn.apiKey ? "ok" : "fail";
  checks.n2bToken = config.n2b.apiToken ? "ok" : "fail";

  const healthy = Object.values(checks).every((c) => c === "ok");

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
