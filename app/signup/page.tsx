import Link from "next/link";
import { redirect } from "next/navigation";
import { createUser, startSession, countUsers, getSessionUser, isAllowedDomain } from "@/lib/auth";
import { config } from "@/lib/config";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function register(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  // Checked here as well as in createUser: this is a POST endpoint in its
  // own right, so the form's own validation guarantees nothing.
  if (!isAllowedDomain(email)) redirect("/signup?error=domain");
  if (password !== confirm) redirect("/signup?error=match");
  if (password.length < 12) redirect("/signup?error=short");

  const existing = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true },
  });
  if (existing) redirect("/signup?error=taken");

  const user = await createUser(email, password);
  await startSession(user.id);
  redirect("/");
}

const ERRORS: Record<string, string> = {
  domain: `Use your ${config.allowedEmailDomains.join(" or ")} address.`,
  match: "The two passwords do not match.",
  short: "Use at least 12 characters.",
  taken: "An account already exists for that address. Sign in instead.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  // Before anyone exists, the first account is created through setup, which
  // also decides who the admin is.
  if ((await countUsers()) === 0) redirect("/setup");
  if (await getSessionUser()) redirect("/");

  return (
    <div className="auth-wrap">
      <form action={register} className="auth-card">
        <div className="brand-mark auth-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-sub">
          Limited to {config.allowedEmailDomains.map((d) => `@${d}`).join(" and ")} addresses.
        </p>

        {searchParams.error && (
          <div className="auth-error">{ERRORS[searchParams.error] ?? "Something went wrong."}</div>
        )}

        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <p className="meta">At least 12 characters. Save it in your password manager.</p>
        </div>
        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </div>

        <button type="submit" className="auth-submit">
          Create account
        </button>
        <p className="meta" style={{ textAlign: "center", marginTop: 12 }}>
          Already have one? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
