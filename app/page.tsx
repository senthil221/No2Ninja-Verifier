import { prisma } from "@/lib/prisma";
import { createClient } from "./actions";
import Link from "next/link";
import { requireUser } from "@/lib/require-user";

export const dynamic = "force-dynamic";

const ACTIVE_LABEL: Record<string, string> = {
  pending: "Awaiting start",
  running_mtn: "Ninja pass",
  running_n2b: "No2Bounce pass",
  failed: "Stopped",
};

export default async function HomePage() {
  await requireUser();
  const [clients, n2bSpend, cacheHits, totalRows, needsAttention] = await Promise.all([
    prisma.client.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lists: true } } },
    }),
    prisma.creditLedger.aggregate({ _sum: { amount: true }, where: { provider: "n2b" } }),
    prisma.listRow.count({ where: { finalSource: "cache" } }),
    prisma.listRow.count(),
    // Anything in flight or waiting on a person -- with several lists running
    // at once, this is the only place that shows them together.
    prisma.list.findMany({
      where: { status: { in: ["pending", "running_mtn", "running_n2b", "failed"] } },
      include: { client: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  return (
    <>
      <span className="eyebrow">Overview</span>
      <h1>Clients</h1>
      <p className="subtitle">
        Upload prospect lists per client. Each list runs Mail Tester Ninja first, then only what
        it could not answer goes to No2Bounce.
      </p>

      <div className="card">
        <div className="stat-row">
          <div className="stat">
            <span className="value num">{n2bSpend._sum.amount ?? 0}</span>
            <span className="label">N2B credits spent</span>
          </div>
          <div className="stat">
            <span className="value num">{cacheHits}</span>
            <span className="label">Resolved from cache</span>
          </div>
          <div className="stat">
            <span className="value num">{totalRows}</span>
            <span className="label">Rows processed</span>
          </div>
        </div>
      </div>

      {needsAttention.length > 0 && (
        <div className="card">
          <h2>In progress</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>List</th>
                <th>Client</th>
                <th>Stage</th>
              </tr>
            </thead>
            <tbody>
              {needsAttention.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/lists/${l.id}`} className="row-link">
                      {l.name}
                    </Link>
                  </td>
                  <td className="meta">{l.client.name}</td>
                  <td>
                    <span className={`pill pill-${l.status}`}>
                      <span className="pill-dot" />
                      {ACTIVE_LABEL[l.status] ?? l.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Add a client</h2>
        <form action={createClient} className="inline">
          <input type="text" name="name" placeholder="Client name" required />
          <button type="submit">Add client</button>
        </form>
      </div>

      <div className="card">
        <h2>All clients</h2>
        {clients.length === 0 ? (
          <p className="empty-state">No clients yet. Add one above to get started.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">Lists</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id}>
                  <td>
                    <Link href={`/clients/${client.id}`} className="row-link">
                      {client.name}
                    </Link>
                  </td>
                  <td className="num meta right">{client._count.lists}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
