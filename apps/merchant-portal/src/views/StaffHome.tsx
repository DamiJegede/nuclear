import { useState } from "react";
import type { Account, Api, Employer } from "../api";
import { Tips } from "./Tips";

/**
 * What a person who works for a business sees when they sign in to the portal with their own Nuclear account: their tips, for a period. Staff with the
 * write role see everyone's. Nothing else of the business is reachable from here (the API refuses it).
 */
export function StaffHome({ api, account, employers, onError, onSignOut }: { api: Api; account: Account; employers: Employer[]; onError: (e: unknown) => void; onSignOut: () => void }) {
  const [business, setBusiness] = useState(employers[0]!.business_id);
  const current = employers.find((e) => e.business_id === business) ?? employers[0]!;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden>◎</span> Nuclear <span className="muted">Staff</span></div>
        <nav aria-label="Business">
          {employers.length > 1 ? (
            <label className="period-field"><span className="sr-only">Business</span>
              <select value={business} onChange={(e) => setBusiness(e.target.value)}>{employers.map((e) => <option key={e.business_id} value={e.business_id}>{e.name}</option>)}</select>
            </label>
          ) : <span className="tab active">{current.name}</span>}
        </nav>
        <div className="who"><span className="muted">{account.name}</span><button className="ghost" onClick={onSignOut}>Sign out</button></div>
      </header>
      <main><Tips key={business} api={api} onError={onError} business={business} heading={current.role === "write" ? "Tips" : "My Tips"} /></main>
    </div>
  );
}
