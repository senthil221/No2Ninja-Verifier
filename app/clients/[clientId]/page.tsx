import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { uploadList } from "@/app/actions";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  running_mtn: "Running — MTN pass",
  running_n2b: "Running — N2B pass",
  needs_approval: "Needs approval",
  completed: "Completed",
  failed: "Failed",
};

export default async function ClientPage({ params }: { params: { clientId: string } }) {
  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    include: { lists: { orderBy: { createdAt: "desc" } } },
  });
  if (!client) notFound();

  const uploadForClient = uploadList.bind(null, client.id);

  return (
    <>
      <h1>{client.name}</h1>
      <p className="subtitle">Prospect lists for this client.</p>

      <div className="panel">
        <h2>Upload a list</h2>
        <form action={uploadForClient}>
          <div className="field">
            <input type="text" name="name" placeholder="List name (optional)" />
          </div>
          <div className="field">
            <input type="file" name="file" accept=".csv" required />
          </div>
          <button type="submit">Upload &amp; start verification</button>
        </form>
      </div>

      <div className="panel">
        <h2>Lists</h2>
        {client.lists.length === 0 ? (
          <p className="meta">No lists uploaded yet.</p>
        ) : (
          <ul className="row-list">
            {client.lists.map((list) => (
              <li key={list.id}>
                <Link href={`/lists/${list.id}`}>{list.name}</Link>
                <span className={`badge badge-${list.status}`} style={{ marginLeft: 10 }}>
                  {STATUS_LABEL[list.status] ?? list.status}
                </span>
                <div className="meta">
                  {list.totalRows} rows &middot; uploaded{" "}
                  {list.createdAt.toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
