import { redirect } from "next/navigation";
import { authenticate, startSession, countUsers, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  const user = await authenticate(email, password);
  if (!user) {
    // One message for every failure: saying which part was wrong would let
    // the form be used to find out which addresses have accounts.
    redirect(`/login?error=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  await startSession(user.id);
  redirect(next.startsWith("/") ? next : "/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  // No accounts yet: send the first visitor to create one rather than
  // showing a login form nobody can pass.
  if ((await countUsers()) === 0) redirect("/setup");
  if (await getSessionUser()) redirect("/");

  return (
    <div className="auth-wrap">
      <form action={signIn} className="auth-card">
        <div className="brand-mark auth-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 className="auth-title">Waterfall Verifier</h1>
        <p className="auth-sub">Sign in to continue.</p>

        {searchParams.error && (
          <div className="auth-error">Incorrect email or password.</div>
        )}

        <input type="hidden" name="next" value={searchParams.next ?? "/"} />

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <button type="submit" className="auth-submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
