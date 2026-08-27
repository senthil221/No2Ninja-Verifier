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
  const file = formData.get("file") as File | null;
  const name = String(formData.get("name") ?? "").trim();
  if (!file || file.size === 0) throw new Error("A CSV file is required");

  const fileContents = await file.text();
  const list = await ingestList({
    clientId,
    name: name || file.name,
    sourceFileName: file.name,
    fileContents,
  });

  revalidatePath(`/clients/${clientId}`);
  redirect(`/lists/${list.id}`);
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
