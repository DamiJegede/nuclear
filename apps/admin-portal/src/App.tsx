import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, completeMfa as realCompleteMfa, createApi, signIn as realSignIn,
  type AdminMe, type Api, type MfaChallenge, type SignedIn,
} from "./api";
import { Admins } from "./views/Admins";
import { ChangeAccessToken } from "./views/ChangeAccessToken";
import { Login } from "./views/Login";
import { MfaEnroll, Security } from "./views/Mfa";
import { Models } from "./views/Models";
import { Overview } from "./views/Overview";

const KEY = "nuclear.admin.session";

// The session token lives in sessionStorage: it survives a refresh but not closing the tab. It is a
// short-lived (8 hour) random token, never the Access Token.
function readToken(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

type View = "overview" | "models" | "admins" | "token" | "security";

export function App({
  makeApi = createApi,
  signIn = realSignIn,
  completeMfa = realCompleteMfa,
}: {
  makeApi?: (token: string) => Api;
  signIn?: (accessId: string, accessToken: string) => Promise<SignedIn | MfaChallenge>;
  completeMfa?: (mfaToken: string, code: string) => Promise<SignedIn>;
}) {
  const [token, setToken] = useState<string | null>(readToken);
  const [me, setMe] = useState<AdminMe | null>(null);
  const [view, setView] = useState<View>("overview");
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(() => (token ? makeApi(token) : null), [token, makeApi]);

  const clear = useCallback((why?: string) => {
    writeToken(null);
    setToken(null);
    setMe(null);
    setView("overview");
    setNotice(why ?? null);
  }, []);

  // A 401 "unauthorized" means the session ended (expired, signed out elsewhere, account disabled).
  // Other 401s are not about the session: a wrong current Access Token on the change-token form is
  // reported as invalid_credentials and must not sign the person out.
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthorized") clear("Your session ended. Sign in again.");
    else if (e instanceof ApiError && e.status === 403 && e.code === "access_token_change_required") {
      setMe((m) => (m ? { ...m, must_change_access_token: true } : m));
    } else if (e instanceof ApiError && e.status === 403 && e.code === "mfa_setup_required") {
      setMe((m) => (m ? { ...m, mfa_enabled: false } : m));
    }
  }, [clear]);

  // After a refresh we have a token but not who it belongs to.
  useEffect(() => {
    if (!api || me) return;
    let alive = true;
    api.me().then((m) => { if (alive) setMe(m); }).catch((e) => { if (alive) onError(e); });
    return () => { alive = false; };
  }, [api, me, onError]);

  const signOut = useCallback(async () => {
    try { await api?.logout(); } catch { /* the token is dropped locally either way */ }
    clear();
  }, [api, clear]);

  if (!token || !api) {
    return (
      <Login
        signIn={signIn}
        completeMfa={completeMfa}
        notice={notice}
        onSignedIn={(r) => {
          writeToken(r.session_token);
          setNotice(null);
          setMe({ access_id: r.admin.access_id, name: r.admin.name, must_change_access_token: r.must_change_access_token, mfa_enabled: r.mfa_enabled });
          setToken(r.session_token);
        }}
      />
    );
  }

  if (!me) {
    return <div className="login"><p className="muted" role="status">Loading…</p></div>;
  }

  if (me.must_change_access_token) {
    return (
      <ChangeAccessToken
        api={api}
        me={me}
        forced
        onDone={() => setMe({ ...me, must_change_access_token: false })}
        onSignOut={signOut}
        onError={onError}
      />
    );
  }

  if (!me.mfa_enabled) {
    return (
      <MfaEnroll
        api={api}
        me={me}
        onDone={() => setMe({ ...me, mfa_enabled: true })}
        onSignOut={() => void signOut()}
        onError={onError}
      />
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
        <nav aria-label="Sections">
          <button className={view === "overview" ? "tab active" : "tab"} aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}>Overview</button>
          <button className={view === "models" ? "tab active" : "tab"} aria-current={view === "models" ? "page" : undefined} onClick={() => setView("models")}>Tag models</button>
          <button className={view === "admins" ? "tab active" : "tab"} aria-current={view === "admins" ? "page" : undefined} onClick={() => setView("admins")}>Admins</button>
        </nav>
        <div className="who">
          <span className="muted" title={me.access_id}>{me.name}</span>
          <button className={view === "token" ? "tab active" : "tab"} onClick={() => setView("token")}>Access Token</button>
          <button className={view === "security" ? "tab active" : "tab"} onClick={() => setView("security")}>Security</button>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {view === "overview" && <Overview api={api} onError={onError} />}
        {view === "models" && <Models api={api} onError={onError} />}
        {view === "security" && <Security api={api} onError={onError} />}
        {view === "admins" && <Admins api={api} onError={onError} />}
        {view === "token" && (
          <ChangeAccessToken api={api} me={me} onDone={() => setView("overview")} onError={onError} />
        )}
      </main>
    </div>
  );
}
