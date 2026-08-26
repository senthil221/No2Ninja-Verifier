import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import ListProgress from "./ListProgress";

export const dynamic = "force-dynamic";

export default async function ListPage({ params }: { params: { listId: string } }) {
  const list = await prisma.list.findUnique({
    where: { id: params.listId },
    include: { client: true },
  });
  if (!list) notFound();

  return (
    <>
      <Link href={`/clients/${list.clientId}`} className="meta">
        &larr; {list.client.name}
      </Link>
      <h1>{list.name}</h1>
      <p className="subtitle">
        {list.totalRows} rows &middot; source file {list.sourceFileName}
      </p>

      <div className="panel">
        <h2>Progress</h2>
        <ListProgress listId={list.id} />
      </div>
    </>
  );
}
