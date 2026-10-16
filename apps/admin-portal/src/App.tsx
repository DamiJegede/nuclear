import { useCallback, useMemo, useState } from "react";
import { ApiError, createApi, type Api } from "./api";
import { Login } from "./views/Login";
import { Models } from "./views/Models";
import { Overview } from "./views/Overview";

const KEY = "nuclear.admin.token";

// The operator token lives in sessionStorage: it survives a refresh but not closing the tab.
function readToken(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

type View = "overview" | "models";

export function App({ makeApi = createApi }: { makeApi?: (token: string) => Api }) {
  const [token, setToken] = useState<string | null>(readToken);
  const [view, setView] = useState<View>("overview");
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(() => (token ? makeApi(token) : null), [token, makeApi]);

  const signOut = useCallback((why?: string) => {
    writeToken(null);
    setToken(null);
    setNotice(why ?? null);
  }, []);

  // Any 401 from a view means the token was revoked or rotated: back to the sign-in screen.
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) signOut("Your session ended. Sign in again.");
  }, [signOut]);

  if (!token || !api) {
    return (
      <Login
        makeApi={makeApi}
        notice={notice}
        onSignedIn={(t) => { writeToken(t); setNotice(null); setToken(t); }}
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
        </nav>
        <button className="ghost" onClick={() => signOut()}>Sign out</button>
      </header>
      <main>
        {view === "overview" ? <Overview api={api} onError={onError} /> : <Models api={api} onError={onError} />}
      </main>
    </div>
  );
}
