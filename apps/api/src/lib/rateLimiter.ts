import { Windows, type Rule } from "./throttle";

/**
 * The Durable Object behind the rate limits. It keeps fixed windows in memory (the pure `Windows` logic) and writes each changed window to its
 * key-value storage, so a limit survives an eviction or a deploy. Written without extending `DurableObject` so it stays testable outside the
 * Workers runtime. A key is always routed to the same shard, so one object owns a key's window.
 */
type State = { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean>; list<T>(): Promise<Map<string, T>> } };
type Op = ({ op: "hit" | "peek" } & Rule & { key: string }) | { op: "reset"; key: string } | { op: "sweep" };

export class RateLimiter {
  private w = new Windows();
  private loaded = new Set<string>();
  constructor(private state: State, _env: unknown) {}

  private async load(key: string) {
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    const saved = await this.state.storage.get<{ count: number; start: number }>(key);
    if (saved) this.w.set(key, saved);
  }

  async fetch(req: Request): Promise<Response> {
    const b = (await req.json()) as Op;
    if (b.op === "sweep") {
      const all = await this.state.storage.list<{ count: number; start: number }>();
      let swept = 0;
      for (const [k, v] of all) if (v.start < Date.now() - 86_400_000) { await this.state.storage.delete(k); this.w.reset(k); this.loaded.delete(k); swept++; }
      return Response.json({ swept });
    }
    await this.load(b.key);
    if (b.op === "reset") { this.w.reset(b.key); await this.state.storage.delete(b.key); return Response.json({ ok: true }); }
    if (b.op === "peek") return Response.json(this.w.peek(b.key, b));
    const out = this.w.hit(b.key, b);
    await this.state.storage.put(b.key, this.w.get(b.key));
    return Response.json(out);
  }
}
