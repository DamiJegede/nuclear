import { useCallback, useState } from "react";
import { API_URL, type Api, type ApiKeyStatus } from "../api";
import { usePageTitle } from "../title";
import { useList, when } from "../useList";
import { CopyButton } from "./CopyButton";
import { Modal } from "./Modal";
import { RefreshButton } from "./RefreshButton";
import { SecretPanel } from "./Secret";

const BASE = `${API_URL.replace(/\/$/, "")}/v1/benefits-api`;

const SNIP_EMPLOYEES = `curl -X POST ${BASE}/employees \\
  -H "Authorization: Bearer $NUCLEAR_KEY" -H "Content-Type: application/json" \\
  -d '{"employees":[
        {"employee_id":"E001","name":"Jane Doe","email":"jane@example.com"},
        {"employee_id":"E002","name":"John Smith","email":"john@example.com"}]}'`;
const SNIP_CREDITS = `curl -X POST ${BASE}/credits \\
  -H "Authorization: Bearer $NUCLEAR_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: payroll-2026-10-31" \\
  -d '{"credits":[
        {"employee_id":"E001","amount":5000},
        {"employee_id":"E003","name":"New Hire","email":"new@example.com","amount":2500}]}'`;
const SNIP_GET = `curl -X POST ${BASE}/employees/get \\
  -H "Authorization: Bearer $NUCLEAR_KEY" -H "Content-Type: application/json" \\
  -d '{"employee_ids":["E001","E404"]}'`;
const SNIP_GET_RESPONSE = `{ "employees": [
  { "employee_id": "E001", "found": true, "name": "Jane Doe", "email": "jane@example.com",
    "status": "active", "claimed": true, "held": 0, "created_at": "…", "updated_at": "…" },
  { "employee_id": "E404", "found": false }
] }`;
const SNIP_BALANCE = `curl ${BASE}/balance -H "Authorization: Bearer $NUCLEAR_KEY"`;
const SNIP_BALANCE_RESPONSE = `{ "currency": "USD", "balance": 991500, "held_for_unclaimed": 6000, "employees": 3 }`;
const SNIP_REMOVE = `curl -X POST ${BASE}/employees/remove \\
  -H "Authorization: Bearer $NUCLEAR_KEY" -H "Content-Type: application/json" \\
  -d '{"employee_ids":["E002"]}'`;
const SNIP_CREDITS_RESPONSE = `{
  "batch": { "id": "…", "count": 2, "total": 7500, "sent": 5000, "held": 2500, "created_at": "…" },
  "credits": [
    { "employee_id": "E001", "amount": 5000, "credited_as": "benefits_wallet", "transaction_id": "…" },
    { "employee_id": "E003", "amount": 2500, "credited_as": "held_until_claimed", "transaction_id": "…" }
  ],
  "emails": { "sent": 1, "failed": 0, "not_configured": 0 }
}`;

function Snippet({ text }: { text: string }) {
  return (
    <div className="snippet">
      <pre><code>{text}</code></pre>
      <CopyButton className="ghost small" value={text} />
    </div>
  );
}

/** The Benefits API: the organization's key (shown once) and how to use it. */
export function ApiPage({ api, onError }: { api: Api; onError: (e: unknown) => void }) {
  usePageTitle("API");
  const { data, failed, retry, setData } = useList<{ key: ApiKeyStatus | null }>(useCallback(async () => ({ key: await api.apiKey() }), [api]), onError, "apikey");
  const [confirm, setConfirm] = useState<"generate" | "revoke" | null>(null);
  const [issued, setIssued] = useState<{ token: string; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = data?.key ?? null;

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await api.generateApiKey();
      setData({ key: r.key });
      setIssued({ token: r.token, hint: r.key.hint });
      setConfirm(null);
    } catch (e) { onError(e); setError("Couldn't generate a key. Try again."); }
    finally { setBusy(false); }
  }
  async function revoke() {
    setBusy(true); setError(null);
    try { await api.revokeApiKey(); setData({ key: null }); setConfirm(null); }
    catch (e) { onError(e); setError("Couldn't revoke the key. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="head"><h1>API</h1><div className="head-actions"><RefreshButton onClick={retry} /></div></div>

      <div className="card">
        <h2>API Key</h2>
        <p className="intro">Use the Benefits API to grant benefits to your employees directly from your payroll, HR or rewards systems. Create and remove employees, credit a whole batch in one call, look people up by employee ID and check your wallet balance, all with one key.</p>
        {failed && !data ? <p className="error" role="alert">Couldn't load your key. <button className="link" onClick={retry}>Try Again</button></p>
          : !data ? <p className="muted" role="status">Loading…</p>
          : key ? (
            <>
              <dl className="facts">
                <div className="fact"><dt>Key</dt><dd><code>nk_org_••••••••{key.hint}</code></dd></div>
                <div className="fact"><dt>Created</dt><dd>{when(key.created_at)}</dd></div>
                <div className="fact"><dt>Last used</dt><dd>{key.last_used_at ? when(key.last_used_at) : "Never"}</dd></div>
              </dl>
              <div className="row key-actions">
                <button type="button" onClick={() => { setError(null); setConfirm("generate"); }}>Rotate Key</button>
                <button type="button" className="ghost" onClick={() => { setError(null); setConfirm("revoke"); }}>Revoke Key</button>
              </div>
            </>
          ) : (
            <>
              <p className="dim">No key yet.</p>
              <div className="row key-actions"><button type="button" onClick={() => { setError(null); setConfirm("generate"); }}>Generate API Key</button></div>
            </>
          )}
        <p className="hint">The key lets your systems create, remove and credit employees. It is shown once, when you generate it; keep it secret and never put it in a browser or an app.</p>
      </div>

      <h2 className="section">Documentation</h2>
      <div className="docs-grid">
        <div className="docs-col">
          <div className="card docs">
            <h2>Basics</h2>
            <p>Base URL <code>{BASE}</code></p>
            <p>Send your key as <code>Authorization: Bearer nk_org_…</code>. Bodies are JSON. Amounts are whole <strong>cents</strong> (<code>5000</code> is $50.00).</p>
            <p>Every call that changes or reads employees takes an <strong>array</strong>, so one employee or a whole batch is the same call (up to 2,000). Calls that change things are <strong>all or nothing</strong>: if one entry is wrong, nothing happens.</p>
            <p>Up to 120 requests a minute per key.</p>
          </div>
          <div className="card docs">
            <h2>Errors</h2>
            <p>Errors are JSON like <code>{"{ \"error\": \"insufficient_balance\", \"required\": 7500, \"available\": 2000 }"}</code>.</p>
            <ul className="err-list">
              <li><code>401 unauthorized</code> missing, wrong or revoked key</li>
              <li><code>400 invalid_request</code> bad body (<code>issues</code> says why)</li>
              <li><code>400 idempotency_key_required</code></li>
              <li><code>422 duplicate_employee_id</code></li>
              <li><code>422 employee_details_required</code> these <code>employee_ids</code> need a name and email</li>
              <li><code>422 insufficient_balance</code> with <code>required</code> and <code>available</code></li>
              <li><code>422 recipient_unavailable</code></li>
              <li><code>409 idempotency_mismatch</code> same key, different credits</li>
              <li><code>409 has_held_balance</code> a credit is still waiting to be claimed</li>
              <li><code>404 employee_not_found</code></li>
              <li><code>429 rate_limited</code> try again after <code>retry_after</code> seconds</li>
            </ul>
          </div>
        </div>

        <div className="docs-col">
          <div className="card docs" aria-label="Create or update employees">
            <h2><span className="verb">POST</span> /employees</h2>
            <p>Creates employees, or updates the name and email of ones that exist (<code>employee_id</code> never changes; letters and numbers only). Nothing is credited and nobody is emailed. A removed employee becomes active again.</p>
            <Snippet text={SNIP_EMPLOYEES} />
            <p>Answer: <code>{"{ \"employees\": [ { \"employee_id\": \"E001\", \"result\": \"created\" | \"updated\" | \"reactivated\" } ] }"}</code></p>
          </div>

          <div className="card docs" aria-label="Get employees">
            <h2><span className="verb">POST</span> /employees/get</h2>
            <p>Looks employees up by <code>employee_id</code>: an array in, an array back in the same order. An unknown id comes back as <code>found: false</code>. <code>claimed</code> says whether the person has joined Nuclear; <code>held</code> is the credit (in cents) still waiting for them to claim it.</p>
            <Snippet text={SNIP_GET} />
            <Snippet text={SNIP_GET_RESPONSE} />
          </div>

          <div className="card docs" aria-label="Credit benefits">
            <h2><span className="verb">POST</span> /credits</h2>
            <p>Credits each employee. <code>name</code> and <code>email</code> are only needed for someone you haven't created or credited before. Send an <code>Idempotency-Key</code> header: repeating the same call with the same key returns the first result and credits nothing twice. Your balance must cover the whole call. Employees who have joined Nuclear get the money in their Benefits wallet; everyone else is emailed a link to claim it, and it is held for them until they do (it never expires).</p>
            <Snippet text={SNIP_CREDITS} />
            <Snippet text={SNIP_CREDITS_RESPONSE} />
          </div>

          <div className="card docs" aria-label="Remove employees">
            <h2><span className="verb">POST</span> /employees/remove</h2>
            <p>Hides employees. Refused for an unknown <code>employee_id</code> (404) and for anyone who still has a credit held waiting to be claimed (409, they must claim first). Removing someone twice is fine.</p>
            <Snippet text={SNIP_REMOVE} />
            <p>Answer: <code>{"{ \"employees\": [ { \"employee_id\": \"E002\", \"result\": \"removed\" | \"already_removed\" } ] }"}</code></p>
          </div>

          <div className="card docs" aria-label="Get balance">
            <h2><span className="verb get">GET</span> /balance</h2>
            <p>Your wallet: <code>balance</code> is what is available to credit (cents), <code>held_for_unclaimed</code> is money already set aside for employees who haven't claimed yet, and <code>employees</code> counts your active employees.</p>
            <Snippet text={SNIP_BALANCE} />
            <Snippet text={SNIP_BALANCE_RESPONSE} />
          </div>
        </div>
      </div>

      {confirm === "generate" && (
        <Modal title={key ? "Rotate API Key" : "Generate API Key"} onClose={() => setConfirm(null)} locked={busy}>
          <p>{key ? "A new key replaces the current one, which stops working immediately. Update your systems with the new key." : "Generate your API key? It will be shown once."}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void generate()}>{busy ? "Generating…" : key ? "Confirm Rotate" : "Generate Key"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {confirm === "revoke" && (
        <Modal title="Revoke API Key" onClose={() => setConfirm(null)} locked={busy}>
          <p>Revoke the key ending {key?.hint}? Your systems stop working until you generate a new one.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={() => void revoke()}>{busy ? "Revoking…" : "Confirm Revoke"}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {issued && (
        <Modal title="Your API Key" onClose={() => undefined} locked>
          <SecretPanel title="API Key" value={issued.token} filename="nuclear-benefits-api-key.txt"
            text={`Nuclear Benefits API\nBase URL: ${BASE}\nKey: ${issued.token}\n\nKeep this file private. The key cannot be shown again; rotate it if it is lost or leaked.\n`}
            onDone={() => setIssued(null)} />
        </Modal>
      )}
    </section>
  );
}
