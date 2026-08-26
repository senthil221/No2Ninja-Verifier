import { prisma } from "@/lib/prisma";
import { createClient } from "./actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [clients, n2bSpend, cacheHits, totalRows] = await Promise.all([
    prisma.client.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lists: true } } },
    }),
    prisma.creditLedger.aggregate({ _sum: { amount: true }, where: { provider: "n2b" } }),
    prisma.listRow.count({ where: { finalSource: "cache" } }),
    prisma.listRow.count(),
  ]);

  return (
    <>
      <span className="eyebrow">Overview</span>
      <h1>Clients</h1>
      <p className="subtitle">
        Upload prospect lists per client. Each list runs Mail Tester Ninja first, then only the
        undeliverable remainder goes to NeverBounce.
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
          <p className="empty-state">No clients yet — add one above to get started.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Lists</th>
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
                  <td className="num meta">{client._count.lists}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
