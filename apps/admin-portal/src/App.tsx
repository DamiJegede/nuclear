import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, completeMfa as realCompleteMfa, createApi, signIn as realSignIn,
  type AdminMe, type Api, type MfaChallenge, type SignedIn,
} from "./api";
import { Admins } from "./views/Admins";
import { Login } from "./views/Login";
import { MfaEnroll, Security } from "./views/Mfa";
import { Tags } from "./views/Tags";
import { usePageTitle } from "./title";
import { TagDetail } from "./views/TagDetail";
import { Merchants, Users } from "./views/People";
import { Transactions } from "./views/Transactions";
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

type View = "overview" | "merchants" | "users" | "tags" | "tag" | "admins" | "transactions" | "security";
type Route = { view: View; id?: string };

// Each page has its own address, so the browser's back and forward buttons move between pages.
const PATHS: Record<Exclude<View, "tag">, string> = { overview: "/", merchants: "/merchants", users: "/users", tags: "/tags", admins: "/admins", transactions: "/transactions", security: "/security" };
const pathOf = (r: Route): string => (r.view === "tag" ? `/tags/${r.id}` : PATHS[r.view]);
const routeFromPath = (path: string): Route => {
  const clean = path.replace(/\/+$/, "") || "/";
  const tag = /^\/tags\/([0-9a-fA-F-]{36})$/.exec(clean);
  if (tag) return { view: "tag", id: tag[1]! };
  return { view: ((Object.keys(PATHS) as (keyof typeof PATHS)[]).find((v) => PATHS[v] === clean) ?? "overview") };
};

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
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const view = route.view;

  const setView = useCallback((v: View, replace = false, id?: string) => {
    const r: Route = { view: v, ...(id ? { id } : {}) };
    const path = pathOf(r);
    if (window.location.pathname !== path) window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setRoute(r);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(() => (token ? makeApi(token) : null), [token, makeApi]);

  // Tab title per page. Sign-in, enrollment and the tag page set their own (undefined = leave it).
  const TITLES: Record<Exclude<View, "tag">, string> = {
    overview: "Overview", merchants: "Merchants", users: "Users", tags: "Tags", admins: "Admins", transactions: "Transactions", security: "Security",
  };
  usePageTitle(token && me?.mfa_enabled && view !== "tag" ? TITLES[view] : undefined);

  const clear = useCallback((why?: string) => {
    writeToken(null);
    setToken(null);
    setMe(null);
    setView("overview", true);
    setNotice(why ?? null);
  }, [setView]);

  // A 401 "unauthorized" means the session ended (expired, signed out elsewhere, account disabled).
  // Other 401s are not about the session: other 401s (e.g. invalid_credentials) must not sign the person out.
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthorized") clear("Your session ended. Sign in again.");
    else if (e instanceof ApiError && e.status === 403 && e.code === "mfa_setup_required") {
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
          setMe({ access_id: r.admin.access_id, name: r.admin.name, mfa_enabled: r.mfa_enabled });
          setToken(r.session_token);
        }}
      />
    );
  }

  if (!me) {
    return <div className="login"><p className="muted" role="status">Loading…</p></div>;
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
          {([["overview", "Overview"], ["merchants", "Merchants"], ["users", "Users"], ["tags", "Tags"], ["admins", "Admins"], ["transactions", "Transactions"]] as const).map(([v, label]) => (
            <a key={v} href={PATHS[v]} className={view === v || (v === "tags" && view === "tag") ? "tab active" : "tab"} aria-current={view === v ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); setView(v); }}>{label}</a>
          ))}
        </nav>
        <div className="who">
          <a href={PATHS.security} className={view === "security" ? "tab active" : "tab"} aria-current={view === "security" ? "page" : undefined} title={`${me.access_id}: two-step verification`}
            onClick={(e) => { e.preventDefault(); setView("security"); }}>{me.name}</a>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {view === "overview" && <Overview api={api} onError={onError} />}
        {view === "tags" && <Tags api={api} onError={onError} open={(id) => setView("tag", false, id)} />}
        {view === "tag" && route.id && <TagDetail api={api} id={route.id} onBack={() => setView("tags")} onError={onError} />}
        {view === "security" && <Security api={api} onError={onError} />}
        {view === "admins" && <Admins api={api} onError={onError} />}
        {view === "merchants" && <Merchants api={api} onError={onError} />}
        {view === "users" && <Users api={api} onError={onError} />}
        {view === "transactions" && <Transactions api={api} onError={onError} />}
      </main>
    </div>
  );
}
