import { useState, type FormEvent } from "react";
import { ApiError, requestPasswordReset as realRequestReset, type Session } from "../api";
import { usePageTitle } from "../title";

type Props = {
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (input: { name: string; email: string; password: string; phone?: string }) => Promise<Session>;
  onSignedIn: (s: Session) => void;
  notice: string | null;
  requestPasswordReset?: (email: string) => Promise<unknown>;
};

/** Sign in with email and password, or create a business account (it starts pending until it is approved). */
export function Login({ signIn, signUp, onSignedIn, notice, requestPasswordReset = realRequestReset }: Props) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [sent, setSent] = useState(false);
  usePageTitle(mode === "in" ? "Sign In" : mode === "up" ? "Create Account" : "Forgot Password");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "forgot") {
      if (!email.trim()) return setError("Enter your email.");
      setBusy(true);
      try { await requestPasswordReset(email.trim().toLowerCase()); setSent(true); }
      catch (err) { setError(err instanceof ApiError && err.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Something went wrong. Try again."); }
      finally { setBusy(false); }
      return;
    }
    if (!email.trim() || !password) return setError("Enter your email and password.");
    if (mode === "up") {
      if (!name.trim()) return setError("Enter your business name.");
      if (password.length < 10) return setError("Use a password of at least 10 characters.");
    }
    setBusy(true);
    try {
      const s = mode === "in"
        ? await signIn(email.trim().toLowerCase(), password)
        : await signUp({ name: name.trim(), email: email.trim().toLowerCase(), password, ...(phone.trim() ? { phone: phone.trim() } : {}) });
      onSignedIn(s);
    } catch (err) {
      setPassword("");
      if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a few minutes and try again.");
      else if (err instanceof ApiError && err.status === 401) setError("Email or password is incorrect.");
      else if (err instanceof ApiError && err.code === "email_taken") setError("That email already has an account. Sign in instead.");
      else if (err instanceof ApiError && err.status === 400) setError("Check your details and try again.");
      else if (err instanceof ApiError && err.status === 0) setError("Can't reach the API. Check your connection.");
      else setError("Something went wrong. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card login-card" aria-labelledby="login-title">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Business</span></div>
        <h1 id="login-title" className="sr-only">{mode === "forgot" ? "Forgot password" : mode === "in" ? "Sign in" : "Create a business account"}</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        {mode === "up" && (
          <>
            <label htmlFor="biz-name">Business Name</label>
            <input id="biz-name" autoComplete="organization" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode === "up" && (
          <>
            <label htmlFor="phone">Phone (optional)</label>
            <input id="phone" type="tel" autoComplete="tel" maxLength={32} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </>
        )}
        {mode !== "forgot" && (
          <>
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}
        {mode === "forgot" && sent && <p className="notice" role="status">If an account exists for that email, we sent a link to reset the password. It works for one hour.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {!(mode === "forgot" && sent) && <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "in" ? "Sign In" : mode === "up" ? "Create Account" : "Send Reset Link"}</button>}
        {mode === "in" && <p className="hint"><button type="button" className="link" onClick={() => { setMode("forgot"); setError(null); setSent(false); }}>Forgot password?</button></p>}
        <p className="hint">
          {mode === "forgot"
            ? <button type="button" className="link" onClick={() => { setMode("in"); setError(null); setSent(false); }}>Back to sign in</button>
            : mode === "in"
            ? <>New here? <button type="button" className="link" onClick={() => { setMode("up"); setError(null); }}>Create a business account</button></>
            : <>New accounts are reviewed before they can take payments. <button type="button" className="link" onClick={() => { setMode("in"); setError(null); }}>Back to sign in</button></>}
        </p>
      </form>
    </div>
  );
}
