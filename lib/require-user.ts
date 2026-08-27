import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getSessionUser } from "./auth";

// The real gate. Middleware only sees whether a cookie exists; this verifies
// it against the database, so a forged or revoked cookie gets no further
// than here. Every page that renders client data calls it.
export async function requireUser() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

// API-route equivalent: returns a 401 response instead of redirecting, so a
// fetch gets a status it can act on rather than a login page.
export async function requireUserForApi() {
  const user = await getSessionUser();
  if (!user) {
    return { user: null, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { user, response: null };
}
