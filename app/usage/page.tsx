import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/require-user";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const viewer = await requireUser();
  const isAdmin = viewer.role === "admin";

  // Members see only their own spend. Enforced in the query rather than by
  // hiding rows in the markup, so the data never reaches the page at all.
  const scope = isAdmin ? {} : { userId: viewer.id };

  const [byUser, users, recent, total, unattributed] = await Promise.all([
    prisma.creditLedger.groupBy({
      by: ["userId"],
      where: { provider: "n2b", ...scope },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.user.findMany({ select: { id: true, email: true, role: true, lastLoginAt: true } }),
    prisma.creditLedger.findMany({
      where: { provider: "n2b", ...scope },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.creditLedger.aggregate({ _sum: { amount: true }, where: { provider: "n2b", ...scope } }),
    // Spend recorded before attribution existed, or by a since-removed user.
    prisma.creditLedger.aggregate({
      _sum: { amount: true },
      where: { provider: "n2b", userId: null },
    }),
  ]);

  const emailFor = new Map(users.map((u) => [u.id, u.email]));
  const rows = byUser
    .map((r) => ({
      email: r.userId ? (emailFor.get(r.userId) ?? "removed user") : "before attribution",
      credits: r._sum.amount ?? 0,
      batches: r._count,
    }))
    .sort((a, b) => b.credits - a.credits);

  return (
    <>
      <span className="eyebrow">{isAdmin ? "All users" : "Your usage"}</span>
      <h1>Credit usage</h1>
      <p className="subtitle">
        NeverBounce is the only paid step. Spend is recorded against whoever approved it at the
        review gate.
      </p>

      <div className="card">
        <div className="stat-row">
          <div className="stat">
            <span className="value num">{total._sum.amount ?? 0}</span>
            <span className="label">{isAdmin ? "Credits spent" : "Your credits"}</span>
          </div>
          <div className="stat">
            <span className="value num">{recent.length}</span>
            <span className="label">Recent batches</span>
          </div>
          {isAdmin && (
            <div className="stat">
              <span className="value num">{users.length}</span>
              <span className="label">Accounts</span>
            </div>
          )}
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <h2>By user</h2>
          {rows.length === 0 ? (
            <p className="empty-state">No credits spent yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="right">Batches</th>
                  <th className="right">Credits</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.email}>
                    <td>{r.email}</td>
                    <td className="num meta right">{r.batches}</td>
                    <td className="num right">{r.credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(unattributed._sum.amount ?? 0) > 0 && (
            <p className="meta">
              {unattributed._sum.amount} credits were spent before per-user attribution was
              added, so they are listed without an owner.
            </p>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="card">
          <h2>Accounts</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th className="right">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <span className={`pill pill-res-${u.role === "admin" ? "valid" : "unknown"}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="meta right">
                    {u.lastLoginAt ? u.lastLoginAt.toLocaleDateString() : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Recent spend</h2>
        {recent.length === 0 ? (
          <p className="empty-state">Nothing spent yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>List</th>
                {isAdmin && <th>Approved by</th>}
                <th className="right">Credits</th>
                <th className="right">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>{e.listName || "(deleted list)"}</td>
                  {isAdmin && (
                    <td className="meta">
                      {e.userId ? (emailFor.get(e.userId) ?? "removed user") : "unattributed"}
                    </td>
                  )}
                  <td className="num right">{e.amount}</td>
                  <td className="meta right">{e.createdAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
