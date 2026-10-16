import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type AdminMe, type Api, type MfaSetup } from "../api";

/** Groups of four, easier to read and type: "ABCD EFGH …". */
export const groupSecret = (s: string): string => s.replace(/(.{4})/g, "$1 ").trim();

/** A QR code as an <img>, built from the otpauth URI. An SVG in an <img> cannot run scripts. */
export function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: "svg", margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((svg) => { if (alive) setSrc("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [value]);
  return src ? <img className="qr" src={src} width={220} height={220} alt="QR code to scan with your authenticator app" /> : <div className="qr placeholder" aria-hidden />;
}

/** The ten single-use codes, shown once. The person must confirm they have saved them. */
export function RecoveryCodes({ codes, onDone, label = "Continue" }: { codes: string[]; onDone: () => void; label?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([`Nuclear Admin recovery codes\nEach works once.\n\n${text}\n`], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url; a.download = "nuclear-admin-recovery-codes.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* download unavailable; copying still works */ }
  }

  return (
    <div>
      <h2 className="section">Recovery codes</h2>
      <p className="sub">
        If you lose your phone, each of these signs you in once. They are shown <strong>only now</strong>. Store them
        somewhere safe, apart from your Access Token.
      </p>
      <ul className="codes" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="row">
        <button type="button" className="ghost" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="ghost" onClick={download}>Download</button>
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
      <button type="button" disabled={!saved} onClick={onDone}>{label}</button>
    </div>
  );
}

const MESSAGES: Record<string, string> = {
  invalid_code: "That code is not right. Check your authenticator app and try the new code.",
  mfa_unavailable: "Two-step verification is unavailable right now. Tell the operator.",
  already_enrolled: "Two-step verification is already set up for this account.",
};

/** Mandatory enrollment: scan or type the key, prove it with a code, then keep the recovery codes. */
export function MfaEnroll({
  api, me, onDone, onSignOut, onError,
}: {
  api: Api; me: AdminMe; onDone: () => void; onSignOut: () => void; onError: (e: unknown) => void;
}) {
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.mfaSetup()
      .then((s) => { if (alive) setSetup(s); })
      .catch((e) => { onError(e); if (alive) setError(e instanceof ApiError && MESSAGES[e.code] ? MESSAGES[e.code]! : "Couldn't start setup. Reload and try again."); });
    return () => { alive = false; };
  }, [api, onError]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes(await api.mfaEnable(code.trim()));
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError ? MESSAGES[err.code] ?? "Couldn't verify the code. Try again." : "Couldn't verify the code. Try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card login-card wide">
        <div className="brand big"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
        <h1>Set up two-step verification</h1>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={onDone} />
        ) : (
          <>
            <p className="sub">{me.name}, you need an authenticator app (Google Authenticator, 1Password, Authy, or similar) to continue.</p>
            <ol className="steps">
              <li>Scan this QR code with the app{" "}
                <span className="muted">or enter the key by hand.</span></li>
            </ol>
            {setup ? (
              <>
                <Qr value={setup.otpauth_uri} />
                <p className="hint">Can't scan? Enter this key in your app (time-based, 6 digits):</p>
                <p className="secret" aria-label="Setup key"><code>{groupSecret(setup.secret)}</code></p>
              </>
            ) : !error ? <p className="muted" role="status">Preparing…</p> : null}
            <form onSubmit={submit}>
              <label htmlFor="enroll-code">Then enter the 6-digit code it shows</label>
              <input id="enroll-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} disabled={!setup} />
              {error && <p className="error" role="alert">{error}</p>}
              <button type="submit" disabled={busy || !setup || !code.trim()}>{busy ? "Checking…" : "Turn on two-step verification"}</button>
            </form>
            <button type="button" className="ghost" onClick={onSignOut}>Sign out</button>
          </>
        )}
      </div>
    </div>
  );
}

/** The Security tab: status, and new recovery codes (which need a current code). */
export function Security({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes(await api.newRecoveryCodes(code.trim()));
      setCode("");
    } catch (err) {
      onError(err);
      setError(err instanceof ApiError && err.status === 401 ? "That code is not right." : "Couldn't make new codes. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="head"><h1>Security</h1></div>
      <div className="card form">
        <h2>Two-step verification</h2>
        <p className="ok" role="status">On. Signing in needs your Access Token and a code from your authenticator app.</p>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} label="Done" />
        ) : (
          <form onSubmit={submit}>
            <h2>New recovery codes</h2>
            <p className="hint">Making new codes cancels all the old ones. Enter a current code from your authenticator app to confirm it's you.</p>
            <label htmlFor="regen-code">Authentication code</label>
            <input id="regen-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Make new recovery codes"}</button>
          </form>
        )}
      </div>
    </section>
  );
}
