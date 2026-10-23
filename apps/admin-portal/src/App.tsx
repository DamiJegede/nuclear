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
import type { Page } from "./roles";
import { TagDetail } from "./views/TagDetail";
import { Merchants, Organizations, Users } from "./views/People";
import { ORGANIZATION_TABS, OrganizationDetail, type OrganizationTab } from "./views/OrganizationDetail";
import { USER_TABS, UserDetail, type UserTab } from "./views/UserDetail";
import { MERCHANT_TABS, MerchantDetail, type MerchantTab } from "./views/MerchantDetail";
import { Transactions } from "./views/Transactions";
import { Overview } from "./views/Overview";
import { Shop } from "./views/Shop";
import { AuditLog } from "./views/AuditLog";
import { Settlements } from "./views/Settlements";

const KEY = "nuclear.admin.session";

// The session token lives in sessionStorage: it survives a refresh but not closing the tab. It is a
// short-lived (8 hour) random token, never the Access Token.
function readToken(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

type View = "overview" | "merchants" | "merchant" | "organizations" | "organization" | "users" | "user" | "tags" | "tag" | "admins" | "transactions" | "settlements" | "shop" | "audit" | "security";
type Route = { view: View; id?: string; tab?: MerchantTab | UserTab | OrganizationTab };

// Each page has its own address, so the browser's back and forward buttons move between pages.
const PATHS: Record<Exclude<View, "tag" | "merchant" | "organization" | "user">, string> = { overview: "/", merchants: "/merchants", organizations: "/organizations", users: "/users", tags: "/tags", admins: "/admins", transactions: "/transactions", settlements: "/settlements", shop: "/shop", audit: "/audit", security: "/security" };
const pathOf = (r: Route): string =>
  r.view === "tag" ? `/tags/${r.id}`
  : r.view === "merchant" ? `/merchants/${r.id}`
  : r.view === "organization" ? `/organizations/${r.id}`
  : r.view === "user" ? `/users/${r.id}`
  : PATHS[r.view];
/** The address including the merchant tab (`?tab=terminals`); Details is the default and has no query. */
const urlOf = (r: Route): string => pathOf(r) + ((r.view === "merchant" || r.view === "user" || r.view === "organization") && r.tab && r.tab !== "details" ? `?tab=${r.tab}` : "");
const routeFromPath = (path: string, search = ""): Route => {
  const clean = path.replace(/\/+$/, "") || "/";
  const merchant = /^\/merchants\/([0-9a-fA-F-]{36})$/.exec(clean);
  const person = /^\/users\/([0-9a-fA-F-]{36})$/.exec(clean);
  const org = /^\/organizations\/([0-9a-fA-F-]{36})$/.exec(clean);
  if (org) {
    const tab = new URLSearchParams(search).get("tab");
    return { view: "organization", id: org[1]!, tab: ORGANIZATION_TABS.some((t) => t.value === tab) ? (tab as OrganizationTab) : "details" };
  }
  if (person) {
    const tab = new URLSearchParams(search).get("tab");
    return { view: "user", id: person[1]!, tab: USER_TABS.some((t) => t.value === tab) ? (tab as UserTab) : "details" };
  }
  if (merchant) {
    const tab = new URLSearchParams(search).get("tab");
    return { view: "merchant", id: merchant[1]!, tab: MERCHANT_TABS.some((t) => t.value === tab) ? (tab as MerchantTab) : "details" };
  }
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
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname, window.location.search));
  const view = route.view;

  const setView = useCallback((v: View, replace = false, id?: string, tab?: MerchantTab | UserTab | OrganizationTab) => {
    const r: Route = { view: v, ...(id ? { id } : {}), ...(v === "merchant" || v === "user" || v === "organization" ? { tab: tab ?? "details" } : {}) };
    const url = urlOf(r);
    if (window.location.pathname + window.location.search !== url) window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setRoute(r);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(() => (token ? makeApi(token) : null), [token, makeApi]);

  // Tab title per page. Sign-in, enrollment and the tag page set their own (undefined = leave it).
  const TITLES: Record<Exclude<View, "tag" | "merchant" | "organization" | "user" | "shop" | "audit">, string> = {
    overview: "Overview", merchants: "Merchants", organizations: "Organizations", users: "Users", tags: "Tags", admins: "Admins", transactions: "Transactions", settlements: "Settlements", security: "Security",
  };
  usePageTitle(token && me?.mfa_enabled && view !== "tag" && view !== "merchant" && view !== "organization" && view !== "user" && view !== "shop" && view !== "audit" ? TITLES[view] : undefined);

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

  // Each role sees only its own pages. Anything else in the address bar goes to the role's landing page.
  useEffect(() => {
    if (!me || !me.mfa_enabled) return;
    const ok = view === "security" || me.pages.includes(view === "tag" ? "tags" : view === "merchant" ? "merchants" : view === "organization" ? "organizations" : view === "user" ? "users" : view === "settlements" ? "transactions" : (view as Page));
    if (!ok) setView(me.landing, true);
  }, [me, view, setView]);

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
          setMe({ access_id: r.admin.access_id, name: r.admin.name, role: r.role, pages: r.pages, landing: r.landing, mfa_enabled: r.mfa_enabled });
          setView(r.landing, true);                       // each role lands on its own first page
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

  // Tags can be changed by Admin and Tags; Sales may look.
  const canWriteTags = me.role === "admin" || me.role === "tags";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Admin</span></div>
        <nav aria-label="Sections">
          {([["overview", "Overview"], ["merchants", "Merchants"], ["organizations", "Organizations"], ["users", "Users"], ["tags", "Tags"], ["admins", "Admins"], ["shop", "Shop"], ["transactions", "Transactions"], ["settlements", "Settlements"], ["audit", "Logs"]] as const).filter(([v]) => (v === "settlements" ? me.pages.includes("transactions") : me.pages.includes(v as never))).map(([v, label]) => (
            <a key={v} href={PATHS[v]} className={view === v || (v === "tags" && view === "tag") || (v === "merchants" && view === "merchant") || (v === "organizations" && view === "organization") || (v === "users" && view === "user") ? "tab active" : "tab"} aria-current={view === v ? "page" : undefined}
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
        {view === "overview" && me.pages.includes("overview") && <Overview api={api} onError={onError} />}
        {view === "tags" && me.pages.includes("tags") && <Tags api={api} onError={onError} canWrite={canWriteTags} open={(id) => setView("tag", false, id)} />}
        {view === "tag" && route.id && me.pages.includes("tags") && <TagDetail api={api} id={route.id} canWrite={canWriteTags} onBack={() => setView("tags")} onError={onError} />}
        {view === "security" && <Security api={api} onError={onError} />}
        {view === "admins" && me.pages.includes("admins") && <Admins api={api} me={me} onError={onError} />}
        {view === "merchants" && me.pages.includes("merchants") && <Merchants api={api} onError={onError} canEmail={me.role === "admin" || me.role === "merchants"} open={(mid) => setView("merchant", false, mid, "details")} />}
        {view === "merchant" && route.id && me.pages.includes("merchants") && (
          <MerchantDetail api={api} id={route.id} tab={(route.tab as MerchantTab) ?? "details"} canAct={me.role === "admin" || me.role === "merchants"} canAdmin={me.role === "admin"} openUser={me.pages.includes("users") ? (uid) => setView("user", false, uid, "details") : undefined} openMerchant={me.pages.includes("merchants") ? (mid) => setView("merchant", false, mid, "details") : undefined}
            onTab={(t) => setView("merchant", false, route.id, t)} onBack={() => setView("merchants")} onError={onError} />
        )}
        {view === "organizations" && me.pages.includes("organizations") && <Organizations api={api} onError={onError} open={(oid) => setView("organization", false, oid, "details")} />}
        {view === "organization" && route.id && me.pages.includes("organizations") && (
          <OrganizationDetail api={api} id={route.id} tab={(route.tab as OrganizationTab) ?? "details"} canAdmin={me.role === "admin"}
            onTab={(t) => setView("organization", false, route.id, t)} onBack={() => setView("organizations")} onError={onError} />
        )}
        {view === "users" && me.pages.includes("users") && <Users api={api} onError={onError} open={(uid) => setView("user", false, uid, "details")} />}
        {view === "user" && route.id && me.pages.includes("users") && (
          <UserDetail api={api} id={route.id} tab={(route.tab as UserTab) ?? "details"} canAct={me.role === "admin" || me.role === "support"} canAdmin={me.role === "admin"} openUser={me.pages.includes("users") ? (uid) => setView("user", false, uid, "details") : undefined} openMerchant={me.pages.includes("merchants") ? (mid) => setView("merchant", false, mid, "details") : undefined}
            onTab={(t) => setView("user", false, route.id, t)} onBack={() => setView("users")} onError={onError} />
        )}
        {view === "shop" && me.pages.includes("shop") && <Shop api={api} onError={onError} canWrite={me.role === "admin" || me.role === "sales"} />}
        {view === "audit" && me.pages.includes("audit") && <AuditLog api={api} onError={onError} />}
        {view === "settlements" && me.pages.includes("transactions") && <Settlements api={api} canAdmin={me.role === "admin"} openMerchant={me.pages.includes("merchants") ? (id) => setView("merchant", false, id, "details") : undefined} onError={onError} />}
        {view === "transactions" && me.pages.includes("transactions") && <Transactions api={api} onError={onError} openUser={me.pages.includes("users") ? (id) => setView("user", false, id, "details") : undefined} openMerchant={me.pages.includes("merchants") ? (id) => setView("merchant", false, id, "details") : undefined} />}
      </main>
    </div>
  );
}
