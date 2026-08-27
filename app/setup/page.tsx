import { redirect } from "next/navigation";
import { createUser, startSession, countUsers } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function createAdmin(formData: FormData) {
  "use server";

  // Re-check inside the action: without this, the page guard could be
  // bypassed by posting straight to it, letting anyone add an account
  // after setup is done.
  if ((await countUsers()) > 0) redirect("/login");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!email) redirect("/setup?error=email");
  if (password !== confirm) redirect("/setup?error=match");
  if (password.length < 12) redirect("/setup?error=short");

  const user = await createUser(email, password);
  await startSession(user.id);
  redirect("/");
}

const ERRORS: Record<string, string> = {
  email: "Enter an email address.",
  match: "The two passwords don't match.",
  short: "Use at least 12 characters.",
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  // Setup is a one-time door. Once an account exists it closes for good.
  if ((await countUsers()) > 0) redirect("/login");

  return (
    <div className="auth-wrap">
      <form action={createAdmin} className="auth-card">
        <div className="brand-mark auth-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-sub">
          First run — this sets the only account. Choose a password here; it is hashed before it
          is stored and is never recoverable, so save it in your password manager.
        </p>

        {searchParams.error && (
          <div className="auth-error">{ERRORS[searchParams.error] ?? "Something went wrong."}</div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
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
          <p className="meta">At least 12 characters.</p>
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
          Create account &amp; sign in
        </button>
      </form>
    </div>
  );
}
