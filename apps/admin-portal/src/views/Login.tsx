import { useState, type FormEvent } from "react";
import { ApiError, isChallenge, type MfaChallenge, type SignedIn } from "../api";

type Props = {
  signIn: (accessId: string, accessToken: string) => Promise<SignedIn | MfaChallenge>;
  completeMfa: (mfaToken: string, code: string) => Promise<SignedIn>;
  onSignedIn: (r: SignedIn) => void;
  notice: string | null;
};

export function Login({ signIn, completeMfa, onSignedIn, notice }: Props) {
  const [accessId, setAccessId] = useState("");
  const [token, setToken] = useState("");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitToken(e: FormEvent) {
    e.preventDefault();
    if (!accessId.trim() || !token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await signIn(accessId.trim().toUpperCase(), token);
      if (isChallenge(r)) {
        setChallenge(r);
        setToken(""); // the Access Token is not needed again; do not keep it around
      } else {
        onSignedIn(r);
      }
    } catch (err) {
      // One message for every credential failure: it never says which half was wrong.
      if (err instanceof ApiError && err.status === 401) setError("Access ID or Access Token is incorrect.");
      else if (err instanceof ApiError && err.status === 0) setError("Can't reach the API. Check your connection.");
      else if (err instanceof ApiError && err.status === 400) setError("Enter your Access ID and Access Token.");
      else setError("Something went wrong. Try again.");
      setToken("");
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <div className="login">
        <CodeStep
          challenge={challenge}
          completeMfa={completeMfa}
          onSignedIn={onSignedIn}
          onBack={() => { setChallenge(null); setError(null); }}
        />
      </div>
    );
  }

  return (
    <div className="login">
      <form onSubmit={submitToken} className="card login-card" aria-labelledby="login-title">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
        <h1 id="login-title">Sign in</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        <label htmlFor="access-id">Access ID</label>
        <input
          id="access-id"
          className="upper"
          autoComplete="username"
          autoCapitalize="characters"
          spellCheck={false}
          value={accessId}
          onChange={(e) => setAccessId(e.target.value.toUpperCase())}
        />
        <label htmlFor="access-token">Access Token</label>
        <input
          id="access-token"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-describedby={error ? "login-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && <p id="login-error" className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !accessId.trim() || !token}>{busy ? "Signing in…" : "Continue"}</button>
        <p className="hint">Several wrong attempts in a row lock the account for 15 minutes. Ask an admin or the operator if you are locked out, have lost your Access Token or lost your authenticator.</p>
      </form>
    </div>
  );
}

function CodeStep({
  challenge,
  completeMfa,
  onSignedIn,
  onBack,
}: {
  challenge: MfaChallenge;
  completeMfa: Props["completeMfa"];
  onSignedIn: Props["onSignedIn"];
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await completeMfa(challenge.mfa_token, code.trim()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("That code didn't work, or your sign-in timed out. Check the code, or go back and start again.");
      } else if (err instanceof ApiError && err.status === 503) {
        setError("Two-step verification is unavailable right now. Tell the operator.");
      } else if (err instanceof ApiError && err.status === 0) {
        setError("Can't reach the API. Check your connection.");
      } else {
        setError("Something went wrong. Try again.");
      }
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card login-card" aria-labelledby="code-title">
      <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
      <h1 id="code-title">Two-step verification</h1>
      <p className="sub">
        {recovery
          ? "Enter one of your recovery codes. Each works only once."
          : "Open your authenticator app and enter the 6-digit code for Nuclear Admin."}
      </p>
      <label htmlFor="code">{recovery ? "Recovery code" : "Authentication code"}</label>
      <input
        id="code"
        key={recovery ? "r" : "c"}
        autoFocus
        autoComplete="one-time-code"
        inputMode={recovery ? "text" : "numeric"}
        spellCheck={false}
        maxLength={recovery ? 16 : 7}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-describedby={error ? "code-error" : undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && <p id="code-error" className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !code.trim()}>{busy ? "Verifying…" : "Sign in"}</button>
      <button type="button" className="link left" onClick={() => { setRecovery(!recovery); setCode(""); setError(null); }}>
        {recovery ? "Use my authenticator app instead" : "Use a recovery code instead"}
      </button>
      <button type="button" className="ghost" onClick={onBack}>Back</button>
    </form>
  );
}
