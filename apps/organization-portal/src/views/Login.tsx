import { useState, type FormEvent } from "react";
import { ApiError, type Session } from "../api";
import { usePageTitle } from "../title";

type Props = {
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (input: { name: string; email: string; password: string; phone?: string }) => Promise<Session>;
  onSignedIn: (s: Session) => void;
  notice: string | null;
};

/** Sign in with email and password, or create an organization account. */
export function Login({ signIn, signUp, onSignedIn, notice }: Props) {
  const [mode, setMode] = useState<"in" | "up">("in");
  usePageTitle(mode === "in" ? "Sign In" : "Create Account");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError("Enter your email and password.");
    if (mode === "up") {
      if (!name.trim()) return setError("Enter your organization's name.");
      if (password.length < 10) return setError("Use a password of at least 10 characters.");
    }
    setBusy(true);
    try {
      const s = mode === "in"
        ? await signIn(email.trim().toLowerCase(), password)
        : await signUp({ name: name.trim(), email: email.trim().toLowerCase(), password });
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
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Organization</span></div>
        <h1 id="login-title" className="sr-only">{mode === "in" ? "Sign in" : "Create an organization account"}</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        {mode === "up" && (
          <>
            <label htmlFor="org-name">Organization Name</label>
            <input id="org-name" autoComplete="organization" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "in" ? "Sign In" : "Create Account"}</button>
        <p className="hint">
          {mode === "in"
            ? <>New here? <button type="button" className="link" onClick={() => { setMode("up"); setError(null); }}>Create an organization account</button></>
            : <>Already have an account? <button type="button" className="link" onClick={() => { setMode("in"); setError(null); }}>Back to sign in</button></>}
        </p>
      </form>
    </div>
  );
}
