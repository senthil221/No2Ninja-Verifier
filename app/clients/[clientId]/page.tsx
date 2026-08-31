import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { uploadList } from "@/app/actions";
import { requireUser } from "@/lib/require-user";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending: "Ready to start",
  queued: "Queued",
  running_mtn: "Running Ninja pass",
  running_n2b: "Running No2Bounce",
  completed: "Completed",
  failed: "Failed",
};

export default async function ClientPage({ params }: { params: { clientId: string } }) {
  await requireUser();
  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    include: { lists: { orderBy: { createdAt: "desc" } } },
  });
  if (!client) notFound();

  const uploadForClient = uploadList.bind(null, client.id);

  return (
    <>
      <Link href="/" className="back-link">
        &larr; All clients
      </Link>
      <span className="eyebrow">Client</span>
      <h1>{client.name}</h1>
      <p className="subtitle">Prospect lists for this client.</p>

      <div className="card">
        <h2>Upload a list</h2>
        <form action={uploadForClient}>
          <div className="field">
            <label htmlFor="file">CSV files</label>
            <input type="file" id="file" name="file" accept=".csv" multiple required />
            <p className="meta">
              Select several at once. Each becomes its own list; after you approve them, they run
              one by one at the full safe provider rate.
            </p>
          </div>
          <div className="field">
            <label htmlFor="name">List name</label>
            <input
              type="text"
              id="name"
              name="name"
              placeholder="Optional, ignored for multiple files"
            />
          </div>
          <button type="submit">Upload</button>
        </form>
      </div>

      <div className="card">
        <h2>Lists</h2>
        {client.lists.length === 0 ? (
          <p className="empty-state">No lists uploaded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th className="right">Rows</th>
                <th>Uploaded</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {client.lists.map((list) => (
                <tr key={list.id}>
                  <td>
                    <Link href={`/lists/${list.id}`} className="row-link">
                      {list.name}
                    </Link>
                  </td>
                  <td>
                    <span className={`pill pill-${list.status}`}>
                      <span className="pill-dot" />
                      {STATUS_LABEL[list.status] ?? list.status}
                    </span>
                  </td>
                  <td className="num meta right">{list.totalRows}</td>
                  <td className="meta">{list.createdAt.toLocaleDateString()}</td>
                  <td>
                    <div className="table-actions">
                      <a className="link-action" href={`/api/lists/${list.id}/export`}>
                        Export
                      </a>
                      <Link className="link-action" href={`/lists/${list.id}`}>
                        Manage
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
