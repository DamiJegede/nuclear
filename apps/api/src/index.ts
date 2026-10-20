import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppContext, Env } from "./env";
import { connect } from "./db";
import { dailyJobs } from "./lib/cron";
import { setPublicBase } from "./lib/images";
import { programDay } from "./lib/dailyReset";
import { withDb } from "./session";
import { account } from "./routes/account";
import { business } from "./routes/business";
import { photos } from "./routes/photos";
import { admin } from "./routes/admin";
import { activity } from "./routes/activity";
import { auth } from "./routes/auth";
import { devices } from "./routes/devices";
import { handles } from "./routes/handles";
import { checkouts, terminalCheckouts } from "./routes/checkouts";
import { payments, terminalPayments } from "./routes/payments";
import { refunds, terminalRefunds } from "./routes/refunds";
import { employeeClaims, org } from "./routes/org";
import { benefitsApi } from "./routes/benefitsApi";
import { shop } from "./routes/shop";
import { staff } from "./routes/staff";
import { tags } from "./routes/tags";
import { orbs, terminalSelf, terminals } from "./routes/terminals";
import { transfers } from "./routes/transfers";
import { wallets } from "./routes/wallets";

const app = new Hono<AppContext>();

app.use("*", async (c, next) => {
  setPublicBase(c.env.PUBLIC_URL ?? new URL(c.req.url).origin);   // image keys become full URLs on this address
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
// The merchant portal is a browser app on its own origin: only origins in MERCHANT_ORIGINS (comma-separated) get CORS headers
// on the customer/business API (the admin API has its own list). Runs first so preflights, which carry no token, succeed.
v1.use("*", async (c, next) => {
  if (c.req.path.startsWith("/v1/admin")) return next();
  return cors({
    origin: (origin, ctx) => (((ctx.env.MERCHANT_ORIGINS ?? "") + "," + (ctx.env.ORG_ORIGINS ?? "")).split(",").map((o: string) => o.trim()).filter(Boolean).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type", "idempotency-key"],
    maxAge: 600,
  })(c, next);
});
v1.use("*", withDb);
// Anything that reads or changes spent_today / sold_today first makes sure the day's reset has happened
// (the cron usually did it; this is the backstop if a run was missed).
for (const path of ["/transfers", "/transfers/*", "/payments", "/payments/*", "/terminal/payments", "/terminal/payments/*", "/terminal/products", "/terminal/products/*", "/shop/orders", "/wallets", "/wallets/*", "/business/overview", "/business/products", "/benefits-api/credits"]) v1.use(path, programDay);
v1.route("/admin", admin);
v1.route("/auth", auth);
v1.route("/devices", devices);
v1.route("/handles", handles);
v1.route("/photos", photos);
v1.route("/business", business);
v1.route("/benefits-api", benefitsApi);
v1.route("/org", org);
v1.route("/employee/claims", employeeClaims);
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
  // Cron fires at 04:00 and 05:00 UTC; see lib/cron.ts for which run resets the daily counters.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyJobs(event.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;
