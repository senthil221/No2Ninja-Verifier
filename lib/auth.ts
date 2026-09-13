import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { config } from "./config";
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

export function domainOfEmail(email: string): string {
  return normalizeEmail(email).split("@")[1] ?? "";
}

export function isAllowedDomain(email: string): boolean {
  const domains = config.allowedEmailDomains;
  // An empty allow-list means unrestricted, which would be a silent
  // widening of access -- refuse rather than let a blank setting open it up.
  if (domains.length === 0) return false;
  return domains.includes(domainOfEmail(email));
}

export async function createUser(email: string, password: string) {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  if (!isAllowedDomain(email)) {
    throw new Error(`Accounts are limited to ${config.allowedEmailDomains.join(", ")} addresses`);
  }

  // Whoever sets the system up is the admin; everyone after is a member.
  // Nobody can promote themselves by signing up later.
  const isFirst = (await prisma.user.count()) === 0;

  return prisma.user.create({
    data: {
      email: normalizeEmail(email),
      passwordHash: await hashPassword(password),
      role: isFirst ? "admin" : "member",
    },
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

// ---------- Password reset ----------
//
// There is no self-service, emailed reset in this app -- an admin generates
// a link and hands it to the locked-out user directly. What lives in the
// database is only the hash of the token, exactly as with a password
// itself: a leaked row must not be replayable into a working link.

const RESET_TOKEN_HOURS = 1;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Returns the raw token. This is the only moment it exists outside the
// admin's clipboard -- it is never stored, and can't be recovered once this
// call returns, so the caller must show it immediately.
export async function createPasswordResetToken(userId: string, createdById: string) {
  const token = randomBytes(32).toString("hex");

  // An old, unused link left lying around is a second way in for whoever
  // finds it. Generating a fresh one retires every prior link for this
  // user, so at most one is ever live.
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: {
      userId,
      createdById,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000),
    },
  });

  return token;
}

// Looks up a token without consuming it, so the reset page can show a
// sensible error (expired vs. already used vs. never existed) before the
// user has typed a new password.
export async function findPasswordResetToken(token: string) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: true },
  });
  if (!record) return null;
  if (record.usedAt) return { ...record, status: "used" as const };
  if (record.expiresAt < new Date()) return { ...record, status: "expired" as const };
  return { ...record, status: "valid" as const };
}

// Consumes the token and sets the new password. Every existing session for
// the user is revoked in the same transaction -- a reset is precisely the
// moment a session might be in the hands of someone who shouldn't have it,
// so the old ones must not survive it.
export async function resetPassword(token: string, newPassword: string) {
  if (newPassword.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }

  const record = await findPasswordResetToken(token);
  if (!record || record.status !== "valid") {
    throw new Error("This reset link is no longer valid. Ask an admin for a new one.");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: record.userId } }),
  ]);

  return record.user;
}
