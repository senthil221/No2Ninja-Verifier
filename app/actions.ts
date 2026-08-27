"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  ingestList,
  approveN2bSubmission,
  retryList,
  deleteList,
  finishWithoutN2b,
  startVerification,
} from "@/lib/pipeline";

export async function createClient(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Client name is required");

  await prisma.client.create({ data: { name } });
  revalidatePath("/");
}

export async function uploadList(clientId: string, formData: FormData) {
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const name = String(formData.get("name") ?? "").trim();
  if (files.length === 0) throw new Error("At least one CSV file is required");

  // Each file becomes its own list so they can be reviewed and exported
  // independently. They all draw on the same rate-limited queue, so
  // uploading several at once is safe -- they interleave rather than
  // competing.
  const created: string[] = [];
  for (const file of files) {
    const list = await ingestList({
      clientId,
      // A custom name only makes sense for a single file; with several,
      // the filename is the only thing that tells them apart.
      name: files.length === 1 && name ? name : file.name,
      sourceFileName: file.name,
      fileContents: await file.text(),
    });
    created.push(list.id);
  }

  revalidatePath(`/clients/${clientId}`);
  // One file: go straight to it. Several: the client page shows them all.
  if (created.length === 1) redirect(`/lists/${created[0]}`);
  redirect(`/clients/${clientId}`);
}

export async function approveList(listId: string) {
  await approveN2bSubmission(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function beginVerification(listId: string) {
  await startVerification(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function finishListWithoutN2b(listId: string) {
  await finishWithoutN2b(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function retryFailedList(listId: string) {
  await retryList(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function removeList(listId: string) {
  const list = await prisma.list.findUnique({
    where: { id: listId },
    select: { clientId: true },
  });
  if (!list) return;

  await deleteList(listId);
  revalidatePath(`/clients/${list.clientId}`);
  redirect(`/clients/${list.clientId}`);
}
