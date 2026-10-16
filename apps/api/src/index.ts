import { Hono } from "hono";
import type { AppContext, Env } from "./env";
import { connect } from "./db";
import { easternHour, resetDailyCounters } from "./lib/ledger";
import { withDb } from "./session";
import { account } from "./routes/account";
import { admin } from "./routes/admin";
import { activity } from "./routes/activity";
import { auth } from "./routes/auth";
import { devices } from "./routes/devices";
import { handles } from "./routes/handles";
import { checkouts, terminalCheckouts } from "./routes/checkouts";
import { payments, terminalPayments } from "./routes/payments";
import { refunds, terminalRefunds } from "./routes/refunds";
import { shop } from "./routes/shop";
import { staff } from "./routes/staff";
import { tags } from "./routes/tags";
import { orbs, terminalSelf, terminals } from "./routes/terminals";
import { transfers } from "./routes/transfers";
import { wallets } from "./routes/wallets";

const app = new Hono<AppContext>();

app.use("*", async (c, next) => {
  await next();
  // Responses may carry session tokens or financial data: never cache.
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

app.get("/health", (c) => c.json({ ok: true }));

app.use("/health/db", withDb);
app.get("/health/db", async (c) => {
  const [row] = await c.get("sql")<{ now: Date }[]>`select now()`;
  return c.json({ ok: true, now: row?.now });
});

const v1 = new Hono<AppContext>();
v1.use("*", withDb);
v1.route("/admin", admin);
v1.route("/auth", auth);
v1.route("/devices", devices);
v1.route("/handles", handles);
v1.route("/wallets", wallets);
v1.route("/payments", payments);
v1.route("/terminals", terminals);
v1.route("/terminal/payments", terminalPayments);
v1.route("/terminal/checkouts", terminalCheckouts);
v1.route("/checkouts", checkouts);
v1.route("/terminal/refunds", terminalRefunds);
v1.route("/staff", staff);
v1.route("/shop", shop);
v1.route("/refunds", refunds);
v1.route("/tags", tags);
v1.route("/terminal", terminalSelf);
v1.route("/orbs", orbs);
v1.route("/transfers", transfers);
v1.route("/activity", activity);
v1.route("/", account); // /balance, /recipients/lookup, /sandbox/fundings
app.route("/v1", v1);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron fires at 04:00 and 05:00 UTC; only the run that lands on 00:00 Eastern (DST-aware) resets.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (easternHour(new Date(event.scheduledTime)) !== 0) return;
    const sql = connect(env);
    ctx.waitUntil(resetDailyCounters(sql).finally(() => sql.end()));
  },
} satisfies ExportedHandler<Env>;
