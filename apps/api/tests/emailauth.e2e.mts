import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { signAccountLink, passwordFingerprint } from "../src/crypto.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const mails: any[] = [];
const pending: Promise<unknown>[] = [];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), APP_URL: "https://app.test", MERCHANT_PORTAL_URL: "https://merchant.test", ORG_PORTAL_URL: "https://org.test", EMAIL_FROM: "Nuclear <noreply@nclr.app>", EMAIL: { send: async (m: any) => { mails.push(m); } } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); }, passThroughOnException() {} };
const settle = async () => { while (pending.length) await pending.shift(); };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; e?: any } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), o.e ?? env, ctx);
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
  await settle();
  return { status: r.status, json: j };
};
const linkToken = (m: any) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)![1]!);
const PW = "correct horse battery";

// ---- sign-up sends a verification email, from the system address, to the right place
const ada = (await call("POST", "/v1/auth/signup", { body: { name: "Ada", email: "ada@mail.test", password: PW } })).json;
eq("one verification email", mails.length, 1);
eq("sent from noreply@nclr.app", mails[0].from, "Nuclear <noreply@nclr.app>");
eq("to the new customer", mails[0].to, "ada@mail.test");
eq("customer link opens the customer app", mails[0].text.includes("https://app.test/verify-email?token="), true);
eq("account starts unverified", (await call("GET", "/v1/account", { token: ada.session_token })).json.email_verified, false);

const bob = (await call("POST", "/v1/auth/signup", { body: { type: "B", name: "Bob Bakery", email: "bob@mail.test", password: PW } })).json;
eq("business link opens the merchant portal", mails[1].text.includes("https://merchant.test/verify-email?token="), true);
const org = (await call("POST", "/v1/auth/signup", { body: { type: "O", name: "Acme Org", email: "org@mail.test", password: PW } })).json;
eq("organization link opens the organization portal", mails[2].text.includes("https://org.test/verify-email?token="), true);
eq("links are signed tokens, not stored: no table holds them", (await q("select to_regclass('account_tokens') t"))[0].t, null);

// ---- verifying
const t1 = linkToken(mails[0]);
eq("a bad token is refused", (await call("POST", "/v1/auth/verify-email", { body: { token: "x".repeat(43) } })).json.error, "invalid_token");
eq("a short token is a bad request", (await call("POST", "/v1/auth/verify-email", { body: { token: "abc" } })).status, 400);
eq("the link verifies", (await call("POST", "/v1/auth/verify-email", { body: { token: t1 } })).json, { verified: true });
eq("the account shows verified", (await call("GET", "/v1/account", { token: ada.session_token })).json.email_verified, true);
eq("opening the verify link again is harmless", (await call("POST", "/v1/auth/verify-email", { body: { token: t1 } })).json, { verified: true });
eq("resend on a verified account says so", (await call("POST", "/v1/auth/verify-email/resend", { token: ada.session_token })).json, { already_verified: true });

// ---- resend sends a new link (links are stateless: the older one works until it expires)
const before = mails.length;
const bobToken0 = linkToken(mails[1]);
const rs = await call("POST", "/v1/auth/verify-email/resend", { token: bob.session_token });
eq("resend is accepted", rs.status, 202);
eq("a new email went out", mails.length, before + 1);
eq("the older link also works until it expires", (await call("POST", "/v1/auth/verify-email", { body: { token: bobToken0 } })).json.verified, true);
eq("the new link works", (await call("POST", "/v1/auth/verify-email", { body: { token: linkToken(mails[mails.length - 1]) } })).json.verified, true);

// ---- an expired link, and a link for an address that has since changed
await call("POST", "/v1/auth/verify-email/resend", { token: org.session_token });
const orgTok = linkToken(mails[mails.length - 1]);
const expiredLink = await signAccountLink("x".repeat(40), { accountId: org.account_id, kind: "verify_email", email: "org@mail.test" }, -60);
eq("an expired link is refused", (await call("POST", "/v1/auth/verify-email", { body: { token: expiredLink } })).status, 400);
eq("a link of the wrong kind or a forged one is refused", [(await call("POST", "/v1/auth/password-reset/confirm", { body: { token: orgTok, password: "a long enough password" } })).status, (await call("POST", "/v1/auth/verify-email", { body: { token: orgTok.slice(0, -3) + "abc" } })).status], [400, 400]);
await call("POST", "/v1/auth/verify-email/resend", { token: org.session_token });
const orgTok2 = linkToken(mails[mails.length - 1]);
await q("update accounts set email = 'new@mail.test' where id = $1", [org.account_id]);
eq("a link for an old address does not verify the new one", (await call("POST", "/v1/auth/verify-email", { body: { token: orgTok2 } })).status, 400);
eq("so the account stays unverified", (await q("select email_verified_at from accounts where id=$1", [org.account_id]))[0].email_verified_at, null);
await q("update accounts set email = 'org@mail.test' where id = $1", [org.account_id]);

// ---- resend is rate limited per account
let limited = 0;
for (let i = 0; i < 5; i++) if ((await call("POST", "/v1/auth/verify-email/resend", { token: org.session_token })).status === 429) limited++;
eq("resend is limited to a few per hour", limited > 0, true);

// ---- password reset
mails.length = 0;
const ask = await call("POST", "/v1/auth/password-reset", { body: { email: "Ada@Mail.test" } });
eq("reset request is accepted", ask.status, 202);
eq("one reset email", mails.length, 1);
eq("it says one hour", mails[0].text.includes("within one hour"), true);
const unknown = await call("POST", "/v1/auth/password-reset", { body: { email: "nobody@mail.test" } });
eq("an unknown email gets the same answer", [unknown.status, unknown.json], [ask.status, ask.json]);
eq("and no email", mails.length, 1);
eq("a bad body is a bad request", (await call("POST", "/v1/auth/password-reset", { body: { email: "nope" } })).status, 400);

const rt = linkToken(mails[0]);
eq("a weak password is refused", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: rt, password: "short" } })).status, 400);
eq("a bad token is refused", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: "y".repeat(43), password: "a brand new password" } })).json.error, "invalid_token");
eq("the old session works before the reset", (await call("GET", "/v1/account", { token: ada.session_token })).status, 200);
mails.length = 0;
eq("the reset works", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: rt, password: "a brand new password" } })).json, { ok: true });
eq("a 'password changed' email follows", [mails.length, mails[0]?.subject], [1, "Your Nuclear password was changed"]);
eq("the old session is signed out", (await call("GET", "/v1/account", { token: ada.session_token })).status, 401);
eq("the old password no longer works", (await call("POST", "/v1/auth/login", { body: { email: "ada@mail.test", password: PW } })).status, 401);
eq("the new password works", (await call("POST", "/v1/auth/login", { body: { email: "ada@mail.test", password: "a brand new password" } })).status, 200);
eq("the link cannot be used twice", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: rt, password: "another password 12" } })).status, 400);

// a locked login is unlocked by a reset
for (let i = 0; i < 5; i++) await call("POST", "/v1/auth/login", { body: { email: "bob@mail.test", password: "wrong wrong wrong" } });
eq("login is locked after five wrong passwords", (await call("POST", "/v1/auth/login", { body: { email: "bob@mail.test", password: PW } })).status, 429);
mails.length = 0;
await call("POST", "/v1/auth/password-reset", { body: { email: "bob@mail.test" } });
eq("the business reset link opens the merchant portal", mails[0].text.includes("https://merchant.test/reset-password?token="), true);
await call("POST", "/v1/auth/password-reset/confirm", { body: { token: linkToken(mails[0]), password: "bobs new password" } });
eq("the reset lifts the lock", (await call("POST", "/v1/auth/login", { body: { email: "bob@mail.test", password: "bobs new password" } })).status, 200);

// two outstanding reset links: using one kills the other (it carries the old password fingerprint); an expired one is dead
mails.length = 0;
await call("POST", "/v1/auth/password-reset", { body: { email: "ada@mail.test" } });
await call("POST", "/v1/auth/password-reset", { body: { email: "ada@mail.test" } });
eq("two reset links are outstanding and the first works", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: linkToken(mails[0]), password: "something long enough" } })).status, 200);
eq("using it killed the other one", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: linkToken(mails[1]), password: "something else long" } })).status, 400);
const [adaRow] = await q("select password_hash from accounts where id = $1", [ada.account_id]);
const expiredReset = await signAccountLink("x".repeat(40), { accountId: ada.account_id, kind: "reset_password", email: "ada@mail.test", pwf: passwordFingerprint(adaRow.password_hash) }, -1);
eq("an expired reset link is dead", (await call("POST", "/v1/auth/password-reset/confirm", { body: { token: expiredReset, password: "something long enough" } })).status, 400);

// a reset also proves the address
const cy = (await call("POST", "/v1/auth/signup", { body: { name: "Cy", email: "cy@mail.test", password: PW } })).json;
mails.length = 0;
await call("POST", "/v1/auth/password-reset", { body: { email: "cy@mail.test" } });
await call("POST", "/v1/auth/password-reset/confirm", { body: { token: linkToken(mails[0]), password: "cy new password 1" } });
eq("resetting verifies the email", (await q("select email_verified_at is not null v from accounts where id=$1", [cy.account_id]))[0].v, true);

// reset requests per email are limited, but the answer never changes
let codes = new Set<number>();
for (let i = 0; i < 6; i++) codes.add((await call("POST", "/v1/auth/password-reset", { body: { email: "dee@mail.test" } })).status);
eq("always 202, however often", [...codes], [202]);
await call("POST", "/v1/auth/signup", { body: { name: "Dee", email: "dee@mail.test", password: PW } });
mails.length = 0;
for (let i = 0; i < 6; i++) await call("POST", "/v1/auth/password-reset", { body: { email: "dee@mail.test" } });
eq("but only a few emails go to one address", mails.length <= 3, true);

// ---- seeded demo addresses never receive mail
mails.length = 0;
const seed = (await call("POST", "/v1/auth/signup", { body: { type: "B", name: "Seed Shop", email: "shop1.abc@seed.nuclear.test", password: PW } })).json;
await call("POST", "/v1/auth/password-reset", { body: { email: "shop1.abc@seed.nuclear.test" } });
await call("POST", "/v1/auth/verify-email/resend", { token: seed.session_token });
eq("no mail reached a seeded address", mails.length, 0);
const { sendMail, isSuppressed } = await import("../src/lib/email.ts");
eq("sendMail reports suppressed", await sendMail(env, { to: "x@seed.nuclear.test", subject: "s", text: "t" }), "suppressed");
eq("a subdomain is suppressed too", isSuppressed("A@Mail.Seed.Nuclear.Test"), true);
eq("a lookalike is not", isSuppressed("a@notseed.nuclear.test"), false);
eq("a real domain is not", isSuppressed("a@gmail.com"), false);

// ---- audit
eq("reset is logged", (await q("select count(*)::int n from logs where action = 'customer.password_reset'"))[0].n >= 3, true);
eq("verification is logged", (await q("select count(*)::int n from logs where action = 'customer.email_verified'"))[0].n >= 1, true);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
