import type { Env } from "../env";
import type { BankingClient, DirectoryAnswer, Network } from "./banks";

/**
 * Cross River Bank (docs/CROSS-RIVER.md). Cross River allowlists one static IP and Workers have none, so every call goes through the thin forwarder
 * on the banking server (`BANK_PROXY_URL`, Caddy; it holds no credentials or logic and refuses requests without `BANK_PROXY_KEY`): `/idp/*` reaches the
 * token server and `/sandbox/*` the API. This file holds the OAuth token and makes the calls; nothing else talks to the bank.
 */
const LOOKUP_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 20000;
const TOKEN_MARGIN_MS = 60_000;

/** The bank answered with an error. `codes` are the numeric codes of its `errors` list (for example 2013 "not a valid RTP participant"). */
export class CrbError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) { super(message); }
  /** A definitive "no" about this one request (validation, eligibility), as opposed to auth, rate limits or an outage that deserve a retry. */
  get definitive() { return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 408 && this.status !== 429; }
}

export type CrbClient = {
  call<T = unknown>(method: "GET" | "POST", path: string, opts?: { body?: unknown; idem?: string; timeoutMs?: number }): Promise<T>;
};

type Token = { value: string; expires: number };
const tokens = new Map<string, Token>();
const inflight = new Map<string, Promise<Token>>();

/** True when the proxy and the bank credentials are all set (payments also need `CR_ACCOUNT`). */
export const crbConfigured = (env: Env) => !!(env.BANK_PROXY_URL && env.BANK_PROXY_KEY && env.CR_CLIENT_ID && env.CR_CLIENT_SEC);

/** The client for this deployment, or null when the bank is not configured. Tests inject `CRB_FETCH`, a stand-in for the proxy. */
export function crbClient(env: Env): CrbClient | null {
  if (!crbConfigured(env)) return null;
  const base = env.BANK_PROXY_URL!.replace(/\/+$/, "");
  const f: typeof fetch = env.CRB_FETCH ?? ((input, init) => fetch(input, init));
  const proxyHeaders = { "x-nuclear-proxy-key": env.BANK_PROXY_KEY! };
  const cacheKey = `${base}|${env.CR_CLIENT_ID}`;

  // One token for everyone, refreshed one request at a time and never retried in a loop (repeated bad logins lock the bank account).
  async function token(force = false): Promise<Token> {
    const cached = tokens.get(cacheKey);
    if (!force && cached && cached.expires - TOKEN_MARGIN_MS > Date.now()) return cached;
    let p = inflight.get(cacheKey);
    if (!p) {
      p = (async () => {
        const res = await f(`${base}/idp/connect/token`, {
          method: "POST", signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: env.CR_CLIENT_ID!, client_secret: env.CR_CLIENT_SEC!, grant_type: "client_credentials", audience: "https://api.crbcos.com/" }),
        });
        if (!res.ok) throw new CrbError(res.status === 400 ? 401 : res.status, [], `bank token ${res.status}`);
        const j = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!j.access_token) throw new CrbError(502, [], "bank token missing");
        const t = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
        tokens.set(cacheKey, t);
        return t;
      })().finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, p);
    }
    return p;
  }

  async function send(method: string, path: string, opts: { body?: unknown; idem?: string; timeoutMs?: number } | undefined, t: Token) {
    return f(`${base}/sandbox${path}`, {
      method, signal: AbortSignal.timeout(opts?.timeoutMs ?? CALL_TIMEOUT_MS),
      headers: {
        ...proxyHeaders, authorization: `Bearer ${t.value}`,
        ...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts?.idem ? { "idempotency-key": opts.idem } : {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  return {
    async call<T>(method: "GET" | "POST", path: string, opts?: { body?: unknown; idem?: string; timeoutMs?: number }): Promise<T> {
      let res = await send(method, path, opts, await token());
      if (res.status === 401) res = await send(method, path, opts, await token(true));   // the token expired early: one fresh one, once
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { errors?: { code?: number; message?: string }[] } | null;
        const errs = j?.errors ?? [];
        throw new CrbError(res.status, errs.map((e) => Number(e.code)).filter((n) => Number.isFinite(n)), errs.map((e) => e.message).filter(Boolean).join("; ") || `bank ${res.status}`);
      }
      return (await res.json()) as T;
    },
  };
}

type DirectoryEntry = { routingNumber?: string; name?: string; institutionName?: string; receiveServices?: string[]; networkPlatform?: string };

/** The bank directory (`GET /rtp/v1/directory`) as a `BankingClient`: a bank is instant when it can receive a credit on RTP (CRDT) or FedNow (CTRO or CTSR). */
export function crbBankingClient(crb: CrbClient): BankingClient {
  return {
    async lookupBank(routingNumber): Promise<DirectoryAnswer> {
      const r = await crb.call<{ results?: DirectoryEntry[] }>("GET", `/rtp/v1/directory?filter.routingNumber=${encodeURIComponent(routingNumber)}`, { timeoutMs: LOOKUP_TIMEOUT_MS });
      const entries = (r.results ?? []).filter((e) => e.routingNumber === routingNumber);
      const networks: Network[] = [];
      for (const e of entries) {
        const s = e.receiveServices ?? [];
        if (e.networkPlatform === "TCH" && s.includes("CRDT") && !networks.includes("RTP")) networks.push("RTP");
        if (e.networkPlatform === "FedNow" && (s.includes("CTRO") || s.includes("CTSR")) && !networks.includes("FedNow")) networks.push("FedNow");
      }
      const first = entries.find((e) => e.institutionName) ?? entries[0];
      const name = (first?.institutionName ?? first?.name ?? "").trim();
      return { found: entries.length > 0, name: name ? name.slice(0, 120) : null, instant: networks.length > 0, networks };
    },
  };
}
