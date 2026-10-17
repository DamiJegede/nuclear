import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApi, signIn as realSignIn, signUp as realSignUp, type Account, type Api, type Session } from "./api";
import { usePageTitle } from "./title";
import { Catalog } from "./views/Catalog";
import { Login } from "./views/Login";
import { Orders } from "./views/Orders";
import { Transactions } from "./views/Transactions";
import { Orbs } from "./views/Orbs";
import { Overview } from "./views/Overview";
import { Profile } from "./views/Profile";
import { Refunds } from "./views/Refunds";
import { ReviewStatus } from "./views/ReviewStatus";
import { Staff } from "./views/Staff";
import { Terminals } from "./views/Terminals";

const KEY = "nuclear.merchant.session";
// The session token lives in sessionStorage: it survives a refresh but not closing the tab.
const readToken = (): string | null => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const writeToken = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export type Page = "overview" | "transactions" | "orders" | "catalog" | "terminals" | "orbs" | "staff" | "refunds" | "profile";
/** Pages in the navigation, in order. Each page has its own address. */
export const NAV: { page: Page; label: string; path: string }[] = [
  { page: "overview", label: "Overview", path: "/" },
  { page: "transactions", label: "Transactions", path: "/transactions" },
  { page: "orders", label: "Orders", path: "/orders" },
  { page: "catalog", label: "Catalog", path: "/catalog" },
  { page: "terminals", label: "Terminals", path: "/terminals" },
  { page: "orbs", label: "Orbs", path: "/orbs" },
  { page: "staff", label: "Staff", path: "/staff" },
  { page: "refunds", label: "Refunds", path: "/refunds" },
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

  const clear = useCallback((why?: string) => { writeToken(null); setToken(null); setAccount(null); setPage("overview", true); setNotice(why ?? null); }, [setPage]);
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) clear("Your session ended. Sign in again.");
    else if (e instanceof ApiError && e.code === "account_not_approved") setAccount((a) => (a ? { ...a, status: (e.extra?.status as Account["status"]) ?? "pending" } : a));
  }, [clear]);

  const loadAccount = useCallback(async () => {
    if (!api) return;
    try { setAccount(await api.account()); } catch (e) { onError(e); }
  }, [api, onError]);
  useEffect(() => { if (api && !account) void loadAccount(); }, [api, account, loadAccount]);

  const signOut = useCallback(async () => { try { await api?.logout(); } catch { /* the token is dropped locally either way */ } clear(); }, [api, clear]);
  usePageTitle(undefined);

  if (!token || !api) {
    return <Login signIn={signIn} signUp={signUp} notice={notice} onSignedIn={(s) => { writeToken(s.session_token); setNotice(null); setToken(s.session_token); }} />;
  }
  if (!account) return <div className="login"><p className="muted" role="status">Loading…</p></div>;
  if (account.type !== "B") {
    return <div className="login"><div className="card login-card"><h1>This is a personal account</h1><p className="muted">The business portal is for business accounts. Sign in with a business account.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }
  if (account.status === "pending" || account.status === "declined") {
    return <ReviewStatus api={api} account={account} onChanged={() => void loadAccount()} onSignOut={() => void signOut()} onError={onError} />;
  }
  if (account.status !== "active") {
    return <div className="login"><div className="card login-card"><h1>Account {account.status}</h1><p className="muted">This business account can't be used right now. Contact Nuclear support.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Business</span></div>
        <nav aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.page} href={n.path} className={page === n.page ? "tab active" : "tab"} aria-current={page === n.page ? "page" : undefined} onClick={(e) => { e.preventDefault(); setPage(n.page); }}>{n.label}</a>
          ))}
        </nav>
        <div className="who">
          <a href={PROFILE_PATH} className={page === "profile" ? "tab active" : "tab"} aria-current={page === "profile" ? "page" : undefined} title="Profile and security" onClick={(e) => { e.preventDefault(); setPage("profile"); }}>{account.name}</a>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main>
        {page === "overview" && <Overview api={api} account={account} onChanged={() => void loadAccount()} onError={onError} go={(p) => setPage(p as Page)} />}
        {page === "transactions" && <Transactions api={api} onError={onError} />}
        {page === "orders" && <Orders api={api} onError={onError} />}
        {page === "catalog" && <Catalog api={api} onError={onError} />}
        {page === "terminals" && <Terminals api={api} onError={onError} />}
        {page === "orbs" && <Orbs api={api} onError={onError} />}
        {page === "staff" && <Staff api={api} onError={onError} />}
        {page === "refunds" && <Refunds api={api} onError={onError} />}
        {page === "profile" && <Profile api={api} account={account} onChanged={() => void loadAccount()} onError={onError} />}
      </main>
    </div>
  );
}
