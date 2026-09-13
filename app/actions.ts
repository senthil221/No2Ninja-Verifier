"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  ingestList,
  retryList,
  deleteList,
  finishWithoutN2b,
  startVerification,
  stopList,
} from "@/lib/pipeline";
import { getSessionUser, createPasswordResetToken } from "@/lib/auth";
import { config } from "@/lib/config";

// Server actions are POST endpoints in their own right -- a page guard does
// not cover them, so each one asserts the session itself.
async function assertSignedIn() {
  const user = await getSessionUser();
  if (!user) throw new Error("Not signed in");
  return user;
}

async function assertAdmin() {
  const user = await assertSignedIn();
  if (user.role !== "admin") throw new Error("Admin only");
  return user;
}

export async function createClient(formData: FormData) {
  await assertSignedIn();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Client name is required");

  await prisma.client.create({ data: { name } });
  revalidatePath("/");
}

export async function uploadList(clientId: string, formData: FormData) {
  await assertSignedIn();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const name = String(formData.get("name") ?? "").trim();
  if (files.length === 0) throw new Error("At least one CSV file is required");

  // Each file becomes its own list so they can be reviewed and exported
  // independently. Approved lists run FIFO, one complete pipeline at a time.
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

export async function beginVerification(listId: string) {
  // Starting the run is what authorises the credits it may go on to spend,
  // so it is recorded against whoever clicked it.
  const user = await assertSignedIn();
  await startVerification(listId, user.id);
  revalidatePath(`/lists/${listId}`);
}

export async function finishListWithoutN2b(listId: string) {
  await assertSignedIn();
  await finishWithoutN2b(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function stopVerification(listId: string) {
  await assertSignedIn();
  await stopList(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function retryFailedList(listId: string) {
  await assertSignedIn();
  await retryList(listId);
  revalidatePath(`/lists/${listId}`);
}

export async function removeList(listId: string) {
  await assertSignedIn();
  const list = await prisma.list.findUnique({
    where: { id: listId },
    select: { clientId: true },
  });
  if (!list) return;

  await deleteList(listId);
  revalidatePath(`/clients/${list.clientId}`);
  redirect(`/clients/${list.clientId}`);
}

// Generates a one-time reset link and returns it to the caller directly --
// unlike the other actions here, there is no page to redirect back to that
// could show it, so it comes straight back to the admin's browser to copy.
// Admin-only: this is the one action in the app that reaches into another
// person's account.
export async function requestPasswordReset(userId: string): Promise<string> {
  const admin = await assertAdmin();
  const token = await createPasswordResetToken(userId, admin.id);
  const base = config.publicUrl || "";
  return `${base.replace(/\/$/, "")}/reset-password/${token}`;
}
