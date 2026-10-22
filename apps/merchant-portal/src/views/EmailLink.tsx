import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { usePageTitle } from "../title";

export type EmailLinkKind = "verify" | "reset";
/** The email links open these addresses: /verify-email?token=... and /reset-password?token=... */
export const emailLinkFromLocation = (path: string, search: string): { kind: EmailLinkKind; token: string } | null => {
  const clean = path.replace(/\/+$/, "");
  const kind = clean === "/verify-email" ? "verify" : clean === "/reset-password" ? "reset" : null;
  const token = new URLSearchParams(search).get("token");
  return kind && token ? { kind, token } : null;
};

type Props = {
  kind: EmailLinkKind;
  token: string;
  verifyEmail: (token: string) => Promise<unknown>;
  confirmPasswordReset: (token: string, password: string) => Promise<unknown>;
  /** Leave the page: back to the portal's front door. */
  onDone: () => void;
};

/** The page an emailed link opens: confirms the email address, or lets the person choose a new password. */
export function EmailLink({ kind, token, verifyEmail, confirmPasswordReset, onDone }: Props) {
  usePageTitle(kind === "verify" ? "Verify Email" : "Reset Password");
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Business</span></div>
        {kind === "verify" ? <Verify token={token} verifyEmail={verifyEmail} onDone={onDone} /> : <Reset token={token} confirm={confirmPasswordReset} onDone={onDone} />}
      </div>
    </div>
  );
}

function Verify({ token, verifyEmail, onDone }: { token: string; verifyEmail: Props["verifyEmail"]; onDone: () => void }) {
  const [state, setState] = useState<"working" | "ok" | "bad">("working");
  useEffect(() => {
    let live = true;
    verifyEmail(token).then(() => live && setState("ok"), () => live && setState("bad"));
    return () => { live = false; };
  }, [token, verifyEmail]);
  return (
    <>
      <h1>{state === "ok" ? "Email verified" : state === "bad" ? "This link can't be used" : "Verifying your email…"}</h1>
      {state === "ok" && <p className="muted">Thanks. Your email address is confirmed.</p>}
      {state === "bad" && <p className="muted">The link is invalid, already used, or has expired. Sign in and ask for a new verification email from your profile.</p>}
      {state !== "working" && <button type="button" onClick={onDone}>Continue</button>}
    </>
  );
}

function Reset({ token, confirm, onDone }: { token: string; confirm: Props["confirmPasswordReset"]; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) return setError("Use a password of at least 10 characters.");
    if (password !== again) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      await confirm(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_token") setError("This link is invalid, already used, or has expired. Ask for a new one from the sign-in page.");
      else if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a few minutes and try again.");
      else if (err instanceof ApiError && err.status === 0) setError("Can't reach the API. Check your connection.");
      else setError("Something went wrong. Try again.");
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <>
        <h1>Password changed</h1>
        <p className="muted">You were signed out everywhere. Sign in with your new password.</p>
        <button type="button" onClick={onDone}>Sign In</button>
      </>
    );
  }
  return (
    <form onSubmit={submit} aria-labelledby="reset-title">
      <h1 id="reset-title">Choose a new password</h1>
      <label htmlFor="new-password">New Password</label>
      <input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor="new-password-again">Repeat Password</label>
      <input id="new-password-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Please wait…" : "Change Password"}</button>
    </form>
  );
}
