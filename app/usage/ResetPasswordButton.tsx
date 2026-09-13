"use client";

import { useState } from "react";
import { requestPasswordReset } from "@/app/actions";

// The generated link is only ever returned once, right here -- it isn't
// stored anywhere retrievable, so if it's lost the only recovery is
// generating a new one (which quietly retires this one).
export default function ResetPasswordButton({ userId, email }: { userId: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const raw = await requestPasswordReset(userId);
      // PUBLIC_URL isn't set, so the action returned a bare path -- pasted
      // as-is, it goes nowhere for whoever receives it. Filling in this
      // browser's own origin is the closest thing to a real URL available.
      setLink(/^https?:\/\//i.test(raw) ? raw : window.location.origin + raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a link");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by the browser; the link is still
      // selectable text underneath, so this is not a dead end.
    }
  }

  if (link) {
    return (
      <div className="reset-reveal">
        <code className="reset-link">{link}</code>
        <div className="reset-reveal-actions">
          <button type="button" className="btn-quiet" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn-quiet" onClick={() => setLink(null)}>
            Done
          </button>
        </div>
        <p className="meta">
          Send this to {email} yourself. It expires in an hour, works once, and generating
          another retires it.
        </p>
      </div>
    );
  }

  return (
    <>
      <button type="button" className="btn-quiet" disabled={busy} onClick={generate}>
        {busy ? "Generating…" : "Reset password"}
      </button>
      {error && <p className="meta reset-error">{error}</p>}
    </>
  );
}
