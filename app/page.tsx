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
      <h1>Clients</h1>
      <p className="subtitle">
        Upload prospect lists per client. Each list runs Mail Tester Ninja first, then only the
        undeliverable remainder goes to NeverBounce.
      </p>

      <div className="panel stat-grid">
        <div className="stat">
          <div className="value">{n2bSpend._sum.amount ?? 0}</div>
          <div className="label">N2B credits spent</div>
        </div>
        <div className="stat">
          <div className="value">{cacheHits}</div>
          <div className="label">Resolved from cache</div>
        </div>
        <div className="stat">
          <div className="value">{totalRows}</div>
          <div className="label">Rows processed total</div>
        </div>
      </div>

      <div className="panel">
        <h2>Add a client</h2>
        <form action={createClient} className="inline">
          <input type="text" name="name" placeholder="Client name" required />
          <button type="submit">Add client</button>
        </form>
      </div>

      <div className="panel">
        <h2>All clients</h2>
        {clients.length === 0 ? (
          <p className="meta">No clients yet — add one above to get started.</p>
        ) : (
          <ul className="row-list">
            {clients.map((client) => (
              <li key={client.id}>
                <Link href={`/clients/${client.id}`}>{client.name}</Link>
                <div className="meta">{client._count.lists} list(s)</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
