import { useState, type FormEvent } from "react";
import { ApiError, type AdminMe, type Api } from "../api";
import { ACCESS_TOKEN_LENGTH, copyText, credentialsText, downloadText, generateAccessToken } from "../token";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Your current Access Token is not right.",
  access_token_too_short: `The new Access Token must be at least ${ACCESS_TOKEN_LENGTH} characters.`,
  access_token_too_long: "The new Access Token is too long (128 characters at most).",
  access_token_unchanged: "The new Access Token must be different from the current one.",
  access_token_contains_access_id: "The new Access Token must not contain your Access ID.",
};

export function ChangeAccessToken({
  api,
  me,
  forced = false,
  onDone,
  onSignOut,
  onError,
}: {
  api: Api;
  me: AdminMe;
  /** First sign-in with an issued token (or after a reset): nothing else is available yet. */
  forced?: boolean;
  onDone: () => void;
  onSignOut?: () => void;
  onError: (e: unknown) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [generated, setGenerated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function generate() {
    const t = generateAccessToken();
    setNext(t); setGenerated(true); setSaved(false); setNote(null);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!next) return setError("Press Generate to create your new Access Token.");
    if (next.length < ACCESS_TOKEN_LENGTH) return setError(MESSAGES.access_token_too_short!);
    if (next === current) return setError(MESSAGES.access_token_unchanged!);
    if (next.toUpperCase().includes(me.access_id)) return setError(MESSAGES.access_token_contains_access_id!);

    setBusy(true);
    try {
      await api.changeAccessToken(current, next);
      setCurrent(""); setNext(""); setGenerated(false);
      if (forced) onDone();
      else setDone(true);
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError ? MESSAGES[err.code] ?? "Couldn't change the Access Token. Try again." : "Couldn't change the Access Token. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className={forced ? "card login-card wide" : "card form"} aria-labelledby="tok-title">
      {forced && <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>}
      <h1 id="tok-title">{forced ? "Replace your Access Token" : "Change Access Token"}</h1>
      <label htmlFor="cur">{forced ? "Temporary Access Token" : "Current Access Token"}</label>
      <input id="cur" type="password" autoComplete="current-password" spellCheck={false} value={current} onChange={(e) => setCurrent(e.target.value)} />

      <label htmlFor="new">New Access Token</label>
      <input id="new" className="token-field" type="text" readOnly spellCheck={false} autoComplete="off" value={next} placeholder="Not generated yet" />
      {!generated && <p id="tok-rules" className="hint">Press Generate for a strong random one, then save it in your password manager.</p>}
      {!generated && <button type="button" className="ghost block" onClick={generate}>Generate</button>}

      {generated && (
        <div className="creds">
          <div className="row">
            <button type="button" className="ghost" onClick={() => setNote(downloadText(`nuclear-admin-${me.access_id}.txt`, credentialsText(me.name, me.access_id, next, window.location.origin)) ? "Downloaded. Keep the file private." : "Couldn't download. Copy it instead.")}>Download</button>
            <button type="button" className="ghost" onClick={async () => setNote((await copyText(next)) ? "Copied." : "Couldn't copy; select it and copy by hand.")}>Copy</button>
            {note && <span className="muted note" role="status">{note}</span>}
          </div>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved this Access Token</label>
          <button type="submit" className="block" disabled={busy || !current || !saved}>{busy ? "Saving…" : "Change Access Token"}</button>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">Access Token changed. Your other sessions were signed out.</p>}
    </form>
  );

  return forced ? <div className="login"><div className="login-stack">{form}{onSignOut && <p className="below"><button type="button" className="link" onClick={onSignOut}>Sign out</button></p>}</div></div> : <section><div className="head"><h2 className="section">Account</h2></div>{form}</section>;
}
