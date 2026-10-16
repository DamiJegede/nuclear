import { TOOLS, ToolError, type Api } from "./tools";

/**
 * Nuclear MCP server: a stateless Worker that lets an AI agent use its own Nuclear wallet. It speaks MCP
 * over Streamable HTTP (POST, JSON responses) and holds nothing: the agent's wallet key arrives as a
 * bearer token and is passed straight through to the Nuclear API, which enforces every limit.
 */
export interface Env {
  /** Service binding to the nuclear-api Worker. */
  API?: Fetcher;
  /** Fallback base URL when there is no binding (local runs). */
  API_URL?: string;
}

const SERVER = { name: "nuclear", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const KEY = /^nk_agent_[A-Za-z0-9_-]{20,128}$/;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });

function makeApi(env: Env, key: string): Api {
  return async (method, path, body, idempotencyKey) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = env.API
      ? await env.API.fetch(new Request(`https://api.internal${path}`, init))
      : await fetch(`${(env.API_URL ?? "").replace(/\/$/, "")}${path}`, init);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  };
}

async function handle(msg: Rpc, env: Env, key: string): Promise<unknown | null> {
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          "You act for one Nuclear wallet. Amounts are integer cents. Call get_wallet first to see your balance, which is a hard spending limit set by your owner.",
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${String(msg.params?.name)}`);
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
      try {
        const out = await tool.run(args, makeApi(env, key));
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }], isError: false });
      } catch (e) {
        const detail = e instanceof ToolError ? e.detail : { error: "internal_error" };
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(detail) }], isError: true });
      }
    }
    default:
      if (isNotification || msg.method?.startsWith("notifications/")) return null;   // e.g. notifications/initialized
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/mcp" && url.pathname !== "/") return Response.json({ error: "not_found" }, { status: 404 });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

    const auth = req.headers.get("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!KEY.test(key)) {
      return Response.json(rpcError(null, -32001, "Send your wallet key as a bearer token: Authorization: Bearer nk_agent_..."), {
        status: 401, headers: { "www-authenticate": 'Bearer realm="nuclear-mcp"' },
      });
    }

    let body: unknown;
    try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 }); }

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.length > 20) return Response.json(rpcError(null, -32600, "Invalid request"), { status: 400 });
    const out: unknown[] = [];
    for (const m of messages as Rpc[]) {
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(rpcError((m as Rpc | null)?.id, -32600, "Invalid request")); continue; }
      const r = await handle(m, env, key);
      if (r !== null) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202 });      // only notifications
    return Response.json(Array.isArray(body) ? out : out[0], { headers: { "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<Env>;
