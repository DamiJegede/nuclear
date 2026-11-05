import { useCallback, useEffect, useMemo, useState } from "react";
import { clearCache } from "./cache";
import { ApiError, createApi, signIn as realSignIn, signUp as realSignUp, verifyEmail as realVerifyEmail, confirmPasswordReset as realConfirmReset, type Account, type Api, type Employer, type Session } from "./api";
import { usePageTitle } from "./title";
import { Offers } from "./views/Offers";
import { Catalog } from "./views/Catalog";
import { StaffHome } from "./views/StaffHome";
import { Tips } from "./views/Tips";
import { Reports } from "./views/Reports";
import { Tables } from "./views/Tables";
import { Tabs } from "./views/Tabs";
import { EmailLink, emailLinkFromLocation } from "./views/EmailLink";
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

export type Page = "overview" | "transactions" | "orders" | "catalog" | "offers" | "terminals" | "orbs" | "staff" | "tips" | "tables" | "tabs" | "reports" | "refunds" | "profile";
/** Pages in the navigation, in order. Each page has its own address. */
export const NAV: { page: Page; label: string; path: string }[] = [
  { page: "overview", label: "Overview", path: "/" },
  { page: "transactions", label: "Transactions", path: "/transactions" },
  { page: "orders", label: "Orders", path: "/orders" },
  { page: "catalog", label: "Catalog", path: "/catalog" },
  { page: "offers", label: "Offers", path: "/offers" },
  { page: "terminals", label: "Terminals", path: "/terminals" },
  { page: "orbs", label: "Orbs", path: "/orbs" },
  { page: "staff", label: "Staff", path: "/staff" },
  { page: "tables", label: "Tables", path: "/tables" },
  { page: "tabs", label: "Tabs", path: "/tabs" },
  { page: "tips", label: "Tips", path: "/tips" },
  { page: "reports", label: "Reports", path: "/reports" },
  { page: "refunds", label: "Refunds", path: "/refunds" },
];
const NAV_ICONS: Record<string, string> = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  transactions: "M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4",
  orders: "M6 3h12v18l-3-2-3 2-3-2-3 2V3z M9 8h6M9 12h6",
  catalog: "M4 4h16v16H4z M4 10h16M10 10v10",
  offers: "M20 12l-8 8-9-9V3h8z M7.5 7.5h.01",
  terminals: "M4 4h16v12H4z M8 21h8M12 16v5",
  orbs: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  staff: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M18 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-4",
  tables: "M3 8h18v6H3zM6 14v7M18 14v7M6 3v5M18 3v5",
  tabs: "M3 5h18v14H3z M7 9h10M7 13h6",
  tips: "M12 3v18M17 7H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H6",
  reports: "M4 21V3M4 21h17M9 17v-5M14 17V8M19 17V4",
  refunds: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
};
const NAV_GROUPS: Record<string, string> = { overview: "Workspace", terminals: "Operations", tips: "Finances" };
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
  verifyEmail = realVerifyEmail,
  confirmPasswordReset = realConfirmReset,
}: {
  makeApi?: (token: string) => Api;
  signIn?: (email: string, password: string) => Promise<Session>;
  signUp?: (input: { name: string; email: string; password: string; phone?: string }) => Promise<Session>;
  verifyEmail?: (token: string) => Promise<unknown>;
  confirmPasswordReset?: (token: string, password: string) => Promise<unknown>;
}) {
  const [token, setToken] = useState<string | null>(readToken);
  // An emailed link (verify email, reset password) opens a page of its own, signed in or not.
  const [emailLink, setEmailLink] = useState(() => emailLinkFromLocation(window.location.pathname, window.location.search));
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
  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) clear("Your session ended. Sign in again.");
    else if (e instanceof ApiError && e.code === "account_not_approved") setAccount((a) => (a ? { ...a, status: (e.extra?.status as Account["status"]) ?? "pending" } : a));
  }, [clear]);

  const loadAccount = useCallback(async () => {
    if (!api) return;
    try { setAccount(await api.account()); } catch (e) { onError(e); }
  }, [api, onError]);
  useEffect(() => { if (api && !account) void loadAccount(); }, [api, account, loadAccount]);
  // A personal account can still sign in here when it belongs to a business's staff: it gets the staff view (its tips).
  const [employers, setEmployers] = useState<Employer[] | null>(null);
  useEffect(() => {
    if (!api || account?.type !== "C") return;
    let live = true;
    api.employers().then((e) => { if (live) setEmployers(e); }).catch((e) => { onError(e); if (live) setEmployers([]); });
    return () => { live = false; };
  }, [api, account, onError]);

  const signOut = useCallback(async () => { try { await api?.logout(); } catch { /* the token is dropped locally either way */ } clear(); }, [api, clear]);
  usePageTitle(undefined);

  if (emailLink) {
    return <EmailLink kind={emailLink.kind} token={emailLink.token} verifyEmail={verifyEmail} confirmPasswordReset={confirmPasswordReset} onDone={() => { window.history.replaceState(null, "", "/"); setEmailLink(null); }} />;
  }
  if (!token || !api) {
    return <Login signIn={signIn} signUp={signUp} notice={notice} onSignedIn={(s) => { clearCache(); writeToken(s.session_token); setNotice(null); setToken(s.session_token); }} />;
  }
  if (!account) return <div className="login"><p className="muted" role="status">Loading…</p></div>;
  if (account.type !== "B" && employers === null) return <div className="login"><p className="muted" role="status">Loading…</p></div>;
  if (account.type !== "B" && employers && employers.length > 0) return <StaffHome api={api} account={account} employers={employers} onError={onError} onSignOut={() => void signOut()} />;
  if (account.type !== "B") {
    return <div className="login"><div className="card login-card"><h1>This is a personal account</h1><p className="muted">The business portal is for business accounts and the people who work for them. Sign in with a business account, or ask your employer to add you as staff.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }
  if (account.status === "pending" || account.status === "declined") {
    return <ReviewStatus api={api} account={account} onChanged={() => void loadAccount()} onSignOut={() => void signOut()} onError={onError} />;
  }
  if (account.status !== "active") {
    return <div className="login"><div className="card login-card"><h1>Account {account.status}</h1><p className="muted">This business account can't be used right now. Contact Nuclear support.</p><button type="button" onClick={() => void signOut()}>Sign Out</button></div></div>;
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="sidebar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Business</span></div>
        <nav aria-label="Sections">
          {NAV.map((n) => (
            <div key={n.page} className="nav-item">
              {NAV_GROUPS[n.page] && <p className="nav-group">{NAV_GROUPS[n.page]}</p>}
              <a href={n.path} className={page === n.page ? "tab active" : "tab"} aria-current={page === n.page ? "page" : undefined} onClick={(e) => { e.preventDefault(); setPage(n.page); }}><svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={NAV_ICONS[n.page]} /></svg>{n.label}</a>
            </div>
          ))}
        </nav>
        <div className="who">
          <a href={PROFILE_PATH} className={page === "profile" ? "tab active" : "tab"} aria-current={page === "profile" ? "page" : undefined} title="Profile and security" aria-label={account.name} onClick={(e) => { e.preventDefault(); setPage("profile"); }}><span className="account-monogram" aria-hidden="true">{account.name.slice(0, 1)}</span><span className="account-copy"><strong>{account.name}</strong><small>Profile & security</small></span></a>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <div className="workspace-bar"><span>Nuclear Business <span aria-hidden="true">/</span> <strong>{page === "profile" ? "Profile" : NAV.find((n) => n.page === page)?.label}</strong></span><span className="workspace-name">{account.name}</span></div>
        {page === "overview" && <Overview api={api} account={account} onChanged={() => void loadAccount()} onError={onError} go={(p) => setPage(p as Page)} />}
        {page === "transactions" && <Transactions api={api} onError={onError} />}
        {page === "orders" && <Orders api={api} onError={onError} />}
        {page === "catalog" && <Catalog api={api} onError={onError} />}
        {page === "offers" && <Offers api={api} onError={onError} />}
        {page === "terminals" && <Terminals api={api} onError={onError} />}
        {page === "orbs" && <Orbs api={api} onError={onError} />}
        {page === "staff" && <Staff api={api} onError={onError} />}
        {page === "tips" && <Tips api={api} onError={onError} />}
        {page === "tables" && <Tables api={api} onError={onError} />}
        {page === "tabs" && <Tabs api={api} onError={onError} />}
        {page === "reports" && <Reports api={api} onError={onError} />}
        {page === "refunds" && <Refunds api={api} onError={onError} />}
        {page === "profile" && <Profile api={api} account={account} onChanged={() => void loadAccount()} onError={onError} />}
      </main>
    </div>
  );
}
