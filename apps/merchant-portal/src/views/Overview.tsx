import { useCallback } from "react";
import type { Account, Api, Balance, Refund, Terminal } from "../api";
import { int, money } from "../format";
import { usePageTitle } from "../title";
import { useList } from "../useList";

type Snapshot = { balance: Balance; refunds: Refund[]; terminals: Terminal[] };

/** The business at a glance: balance, terminals, and refunds waiting for approval. */
export function Overview({ api, account, onError, go }: { api: Api; account: Account; onError: (e: unknown) => void; go: (page: string) => void }) {
  usePageTitle("Overview");
  const load = useCallback(async (): Promise<Snapshot> => {
    const [balance, refunds, terminals] = await Promise.all([api.balance(), api.refunds("pending"), api.terminals()]);
    return { balance, refunds, terminals };
  }, [api]);
  const { data, failed, retry } = useList<Snapshot>(load, onError);

  if (!data) return <section><h1>Overview</h1>{failed ? <p className="error" role="alert">Couldn't load the numbers. <button className="link" onClick={retry}>Try Again</button></p> : <p className="muted" role="status">Loading…</p>}</section>;
  const { balance, refunds, terminals } = data;
  const pendingTotal = refunds.reduce((s, r) => s + r.amount, 0);
  const paired = terminals.filter((t) => t.orb).length;
  return (
    <section>
      <div className="head"><h1>Overview</h1><button type="button" className="ghost" onClick={retry}>Refresh</button></div>
      {refunds.length > 0 && (
        <div className="banner bad" role="status">
          {int(refunds.length)} refund{refunds.length === 1 ? "" : "s"} ({money(pendingTotal)}) waiting for your approval. <button type="button" className="link" onClick={() => go("refunds")}>Review Refunds</button>
        </div>
      )}
      <div className="grid">
        <article className="card" aria-label="Balance"><h2>Balance</h2><p className="big">{money(balance.balance)}</p><p className="sub">{balance.balance_pending > 0 ? `${money(balance.balance_pending)} pending` : "Nothing pending"}{balance.balance < 0 ? " · negative: refunds exceed payments" : ""}</p></article>
        <article className="card" aria-label="Terminals"><h2>Terminals</h2><p className="big">{int(terminals.length)}</p><p className="sub">{int(paired)} with an Orb paired</p></article>
        <article className="card" aria-label="Awaiting approval"><h2>Awaiting Approval</h2><p className="big">{int(refunds.length)}</p><p className="sub">{money(pendingTotal)} in pending refunds</p></article>
        <article className="card" aria-label="Business"><h2>Business</h2><p className="big small">{account.name}</p><p className="sub">{account.handle ? `@${account.handle}` : "No handle yet"}</p></article>
      </div>
    </section>
  );
}
