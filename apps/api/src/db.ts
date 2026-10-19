import postgres from "postgres";
import type { Env } from "./env";

// One short-lived client per request; Hyperdrive pools connections at the edge.
// prepare:false keeps statements compatible with Hyperdrive's pooled connections.
export function connect(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
    // Tests set globalThis.__sqlTrace to count the statements a request sends (each one is a network round trip in production).
    ...((globalThis as { __sqlTrace?: (q: string) => void }).__sqlTrace ? { debug: (_c: number, q: string) => (globalThis as { __sqlTrace?: (q: string) => void }).__sqlTrace!(q) } : {}),
    types: {
      // Return bigint (money) as string-safe bigint; never as a lossy JS number.
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: bigint | number | string) => v.toString(),
        parse: (v: string) => BigInt(v),
      },
    },
  });
}

export type Sql = ReturnType<typeof connect>;
