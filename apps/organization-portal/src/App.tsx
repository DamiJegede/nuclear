import { useCallback, useEffect, useMemo, useState } from "react";
import { clearCache } from "./cache";
import { ApiError, createApi, signIn as realSignIn, signUp as realSignUp, type Account, type Api, type Session } from "./api";
import { usePageTitle } from "./title";
import { Credits } from "./views/Credits";
import { Employees } from "./views/Employees";
import { Login } from "./views/Login";
import { Overview } from "./views/Overview";
import { Profile } from "./views/Profile";

const KEY = "nuclear.organization.session";
// The session token lives in sessionStorage: it survives a refresh but not closing the tab.
const readToken = (): string | null => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const writeToken = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export type Page = "overview" | "employees" | "credits" | "profile";
/** Pages in the navigation, in order. Each page has its own address. */
export const NAV: { page: Page; label: string; path: string }[] = [
  { page: "overview", label: "Overview", path: "/" },
  { page: "employees", label: "Employees", path: "/employees" },
  { page: "credits", label: "Credits", path: "/credits" },
];
const PROFILE_PATH = "/profile";
const pageFromPath = (path: string): Page => {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === PROFILE_PATH) return "profile";
  return NAV.find((n) => n.path === clean)?.page ?? "overview";
};
const pathOf = (p: Page) => (p === "profile" ? PROFILE_PATH : NAV.find((n) => n.page === p)!.path);

export function App({
  makeApi = createApi,
  signIn = realSignIn,
  signUp = realSignUp,
}: {
  makeApi?: (token: string) => Api;
  signIn?: (email: string, password: string) => Promise<Session>;
  signUp?: (input: { name: string; email: string; password: string; phone?: string }) => Promise<Session>;
}) {
  const [token, setToken] = useState<string | null>(readToken);
  const [account, setAccount] = useState<Account | null>(null);
  const [page, setPageState] = useState<Page>(() => pageFromPath(window.location.pathname));
  const [notice, setNotice] = useState<string | null>(null);
  const api = useMemo(() => (token ? makeApi(token) : null), [token, makeApi]);

  const setPage = useCallback((p: Page, replace = false) => {
    const url = pathOf(p);
    if (window.location.pathname !== url) window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setPageState(p);
  }, []);
  useEffect(() => {
    const onPop = () => setPageState(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const clear = useCallback((why?: string) => { clearCache(); writeToken(null); setToken(null); setAccount(null); setPage("overview", true); setNotice(why ?? null); }, [setPage]);
  const onError = useCallback((e: unknown) => { if (e instanceof ApiError && e.status === 401) clear("Your session ended. Sign in again."); }, [clear]);

  const loadAccount = useCallback(async () => {
    if (!api) return;
    try { setAccount(await api.account()); } catch (e) { onError(e); }
  }, [api, onError]);
  useEffect(() => { if (api && !account) void loadAccount(); }, [api, account, loadAccount]);

  const signOut = useCallback(async () => { try { await api?.logout(); } catch { /* the token is dropped locally either way */ } clear(); }, [api, clear]);
  usePageTitle(undefined);

  if (!token || !api) {
    return <Login signIn={signIn} signUp={signUp} notice={notice} onSignedIn={(s) => { clearCache(); writeToken(s.session_token); setNotice(null); setToken(s.session_token); }} />;
  }
  if (!account) return <div className="login"><p className="muted" role="status">Loading…</p></div>;
  if (account.type !== "O") {
    return <div className="login"><div className="card login-card"><h1>This isn't an organization account</h1><p className="muted">The organization portal is for employers. Sign in with an organization account.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }
  if (account.status !== "active") {
    return <div className="login"><div className="card login-card"><h1>Account {account.status}</h1><p className="muted">This organization account can't be used right now. Contact Nuclear support.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Organization</span></div>
        <nav aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.page} href={n.path} className={page === n.page ? "tab active" : "tab"} aria-current={page === n.page ? "page" : undefined} onClick={(e) => { e.preventDefault(); setPage(n.page); }}>{n.label}</a>
          ))}
        </nav>
        <div className="who">
          <a href={PROFILE_PATH} className={page === "profile" ? "tab active" : "tab"} aria-current={page === "profile" ? "page" : undefined} title="Profile" onClick={(e) => { e.preventDefault(); setPage("profile"); }}>{account.name}</a>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {page === "overview" && <Overview api={api} account={account} onError={onError} go={(p) => setPage(p as Page)} />}
        {page === "employees" && <Employees api={api} onError={onError} />}
        {page === "credits" && <Credits api={api} onError={onError} />}
        {page === "profile" && <Profile api={api} account={account} onChanged={() => void loadAccount()} />}
      </main>
    </div>
  );
}
