import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { SESSION_COOKIE } from "./session-cookie";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

export { SESSION_COOKIE };
const SESSION_DAYS = 14;
const KEY_LENGTH = 64;

// scrypt rather than a bare hash: it is deliberately slow and memory-hard,
// so a stolen database does not hand over the passwords with it. Node ships
// it, which avoids a native dependency that has to compile on every deploy.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;

  // Constant-time: a length-independent comparison would leak how much of
  // the hash matched.
  return timingSafeEqual(derived, expected);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function countUsers(): Promise<number> {
  return prisma.user.count();
}

export async function createUser(email: string, password: string) {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  return prisma.user.create({
    data: { email: normalizeEmail(email), passwordHash: await hashPassword(password) },
  });
}

// Returns the user on success, null otherwise. Deliberately does not
// distinguish "no such account" from "wrong password" to its caller, so the
// login form cannot be used to discover which addresses exist.
export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });

  if (!user) {
    // Spend comparable time on a miss so response timing doesn't reveal
    // whether the address is registered.
    await hashPassword(password);
    return null;
  }

  if (!(await verifyPassword(password, user.passwordHash))) return null;

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return user;
}

export async function startSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({ data: { token, userId, expiresAt } });

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
  }
  cookies().delete(SESSION_COOKIE);
}

// Resolves the signed-in user, or null. Expired sessions are removed on
// sight so the table doesn't accumulate dead rows.
export async function getSessionUser() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.deleteMany({ where: { token } });
    return null;
  }

  return session.user;
}
