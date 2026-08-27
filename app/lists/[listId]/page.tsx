import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import ListProgress from "./ListProgress";
import DeleteListButton from "./DeleteListButton";
import { requireUser } from "@/lib/require-user";

export const dynamic = "force-dynamic";

export default async function ListPage({ params }: { params: { listId: string } }) {
  await requireUser();
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
        <ListProgress listId={list.id} />
      </div>

      <div className="card">
        <h2>Manage</h2>
        <DeleteListButton listId={list.id} listName={list.name} totalRows={list.totalRows} />
      </div>
    </>
  );
}
