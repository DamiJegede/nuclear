import { Counters, type Days } from "./counters";

/**
 * The Durable Object behind today's running estimate. Counters live in RAM (class Counters); `ctx.storage.put` saves them as one JSON value
 * at most every FLUSH_MS while they change (an alarm), and the constructor loads them back after an eviction or a deploy. It uses only the
 * key-value storage API, no SQL. Written without extending `DurableObject` so the logic stays testable outside the Workers runtime.
 */
const FLUSH_MS = 5_000;
const KEY = "days";

type State = { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; setAlarm(t: number): Promise<void>; getAlarm(): Promise<number | null> }; blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> };

export class StatsCounter {
  private counters = new Counters();
  constructor(private state: State, _env: unknown) {
    // Load what the previous life of this object saved before the first request is served.
    void state.blockConcurrencyWhile(async () => { this.counters.days = (await state.storage.get<Days>(KEY)) ?? {}; });
  }

  async fetch(req: Request): Promise<Response> {
    const res = await this.counters.handle(req);
    if (this.counters.dirty && (await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + FLUSH_MS);
    return res;
  }

  async alarm() {
    if (!this.counters.dirty) return;
    this.counters.dirty = false;
    await this.state.storage.put(KEY, this.counters.days);
  }
}
