/**
 * Today's running estimate of the scheme (display metrics only). Counters are added per program day (America/New_York) and kept in RAM; the
 * Durable Object that owns them (statsCounter.ts) saves one small JSON blob every few seconds so an eviction or deploy loses seconds, not
 * the day. Nothing here is money: the exact numbers come from the nightly snapshot (snapshots.ts), which replaces these every midnight.
 *
 * The object speaks a tiny HTTP-style protocol so the same logic runs in the Durable Object and in tests:
 *   POST /add    {day, deltas: {key: number}}      adds to the day's counters
 *   POST /read   {days: [day, ...]}                -> {days: {day: {key: number}}}
 *   POST /prune  {before: day}                     drops days older than `before`
 *   POST /drop   {day}                             drops one day (used to clean up load probes)
 */
export type Deltas = Record<string, number>;
export type Days = Record<string, Deltas>;

export class Counters {
  days: Days = {};
  dirty = false;

  add(day: string, deltas: Deltas) {
    const d = (this.days[day] ??= {});
    for (const [k, v] of Object.entries(deltas)) if (Number.isFinite(v) && v !== 0) d[k] = (d[k] ?? 0) + v;
    this.dirty = true;
  }

  read(days: string[]): Days {
    return Object.fromEntries(days.map((d) => [d, { ...(this.days[d] ?? {}) }]));
  }

  drop(day: string) {
    if (delete this.days[day]) this.dirty = true;
  }

  prune(before: string) {
    for (const d of Object.keys(this.days)) if (d < before) { delete this.days[d]; this.dirty = true; }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as { day?: string; deltas?: Deltas; days?: string[]; before?: string };
    if (url.pathname === "/drop" && typeof body.day === "string") { this.drop(body.day); return Response.json({ ok: true }); }
    if (url.pathname === "/add" && typeof body.day === "string" && body.deltas) { this.add(body.day, body.deltas); return Response.json({ ok: true }); }
    if (url.pathname === "/read" && Array.isArray(body.days)) return Response.json({ days: this.read(body.days.slice(0, 40)) });
    if (url.pathname === "/prune" && typeof body.before === "string") { this.prune(body.before); return Response.json({ ok: true }); }
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
}
