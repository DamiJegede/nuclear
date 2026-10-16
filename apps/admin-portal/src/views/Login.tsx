import { useState, type FormEvent } from "react";
import { ApiError, type Api } from "../api";

export function Login({
  makeApi,
  onSignedIn,
  notice,
}: {
  makeApi: (token: string) => Api;
  onSignedIn: (token: string) => void;
  notice: string | null;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await makeApi(token).stats(); // the cheapest authenticated call proves the token works
      onSignedIn(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("That token was not accepted.");
      else if (err instanceof ApiError && err.status === 404) setError("Admin access is not enabled on this API.");
      else if (err instanceof ApiError && err.status === 0) setError("Can't reach the API. Check your connection and the API address.");
      else setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card login-card" aria-labelledby="login-title">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
        <h1 id="login-title">Operator sign-in</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        <label htmlFor="token">Operator token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={error ? "login-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && <p id="login-error" className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !value.trim()}>{busy ? "Checking…" : "Sign in"}</button>
        <p className="hint">The token is kept for this browser tab only and is cleared when you close it.</p>
      </form>
    </div>
  );
}
