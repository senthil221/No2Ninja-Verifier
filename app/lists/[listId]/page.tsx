import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import ListProgress from "./ListProgress";
import DeleteListButton from "./DeleteListButton";

export const dynamic = "force-dynamic";

export default async function ListPage({ params }: { params: { listId: string } }) {
  const list = await prisma.list.findUnique({
    where: { id: params.listId },
    include: { client: true },
  });
  if (!list) notFound();

  return (
    <>
      <Link href={`/clients/${list.clientId}`} className="back-link">
        &larr; {list.client.name}
      </Link>
      <span className="eyebrow">List</span>
      <h1>{list.name}</h1>
      <p className="subtitle">
        <span className="num">{list.totalRows}</span> rows &middot; {list.sourceFileName}
      </p>

      <div className="card">
        <h2>Progress</h2>
        <ListProgress listId={list.id} />
      </div>

      <div className="card">
        <h2>Manage</h2>
        <div className="card-actions">
          <a href={`/api/lists/${list.id}/export`}>
            <button className="btn-quiet">Export CSV</button>
          </a>
          <DeleteListButton
            listId={list.id}
            listName={list.name}
            totalRows={list.totalRows}
          />
        </div>
      </div>
    </>
  );
}
