import { redirect } from "next/navigation";
import { findPasswordResetToken, resetPassword, startSession, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_MESSAGE: Record<"used" | "expired" | "not_found", string> = {
  used: "This reset link has already been used. Ask an admin for a new one.",
  expired: "This reset link has expired. Ask an admin for a new one.",
  not_found: "This reset link isn't valid. Check you copied the whole address.",
};

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { error?: string };
}) {
  if (await getSessionUser()) redirect("/");

  const record = await findPasswordResetToken(params.token);
  const status = record?.status ?? "not_found";

  async function submit(formData: FormData) {
    "use server";

    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (password !== confirm) redirect(`/reset-password/${params.token}?error=match`);
    if (password.length < 12) redirect(`/reset-password/${params.token}?error=short`);

    let user;
    try {
      user = await resetPassword(params.token, password);
    } catch {
      // The link could have been used or could have expired in the moments
      // between this page loading and the form being submitted -- rare, but
      // the error has to route back through the same page, not throw.
      redirect(`/reset-password/${params.token}?error=invalid`);
    }

    await startSession(user.id);
    redirect("/");
  }

  const ERRORS: Record<string, string> = {
    match: "The two passwords do not match.",
    short: "Use at least 12 characters.",
    invalid: "This link stopped being valid just now. Ask an admin for a new one.",
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand-mark auth-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        {status !== "valid" ? (
          <>
            <h1 className="auth-title">Link not valid</h1>
            <p className="auth-sub">{STATUS_MESSAGE[status]}</p>
          </>
        ) : (
          <form action={submit}>
            <h1 className="auth-title">Choose a new password</h1>
            <p className="auth-sub">
              For {record!.user.email}. Signing you in with it will also end every session
              currently signed in on this account.
            </p>

            {searchParams.error && (
              <div className="auth-error">
                {ERRORS[searchParams.error] ?? "Something went wrong."}
              </div>
            )}

            <div className="field">
              <label htmlFor="password">New password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                autoFocus
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
              Set new password &amp; sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
