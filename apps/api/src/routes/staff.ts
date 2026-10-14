import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { requireOwner, requireSession } from "../session";

const uuid = z.string().uuid();

export const staff = new Hono<AppContext>();
staff.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "B") return c.json({ error: "business_account_required" }, 403);
  await next();
});

type StaffRow = {
  id: string;
  staff_account_id: string;
  bank_account_id: string | null;
  role: string;
  created_at: Date;
  updated_at: Date;
  handle?: string | null;
  name?: string | null;
};

const json = (r: StaffRow) => ({
  id: r.id,
  staff_account_id: r.staff_account_id,
  handle: r.handle ?? null,
  name: r.name ?? null,
  bank_account_id: r.bank_account_id,
  role: r.role,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const role = z.enum(["read", "write"]);

// The bank account must be the staff member's own (active).
async function bankAccountBelongsToStaff(
  sql: AppContext["Variables"]["sql"],
  bankAccountId: string,
  staffAccountId: string,
): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`
    select true as ok from bank_accounts
     where id = ${bankAccountId} and account_id = ${staffAccountId} and status = 'active'`;
  return !!r;
}

staff.get("/", async (c) => {
  const rows = await c.get("sql")<StaffRow[]>`
    select s.id, s.staff_account_id, s.bank_account_id, s.role, s.created_at, s.updated_at, a.handle, a.name
      from staff s join accounts a on a.id = s.staff_account_id
     where s.account_id = ${c.get("auth").accountId}
     order by s.created_at, s.id`;
  return c.json({ staff: rows.map(json) });
});

staff.post("/", async (c) => {
  const body = z
    .object({ staff_account_id: uuid, role, bank_account_id: uuid.nullish() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const b = body.data;

  const [person] = await sql<{ type: string; status: string }[]>`
    select type, status from accounts where id = ${b.staff_account_id}`;
  if (!person || person.type !== "C" || person.status !== "active") return c.json({ error: "staff_account_not_found" }, 404);
  if (b.bank_account_id && !(await bankAccountBelongsToStaff(sql, b.bank_account_id, b.staff_account_id))) {
    return c.json({ error: "bank_account_not_found" }, 404);
  }
  try {
    const [r] = await sql<StaffRow[]>`
      insert into staff (account_id, staff_account_id, bank_account_id, role)
      values (${accountId}, ${b.staff_account_id}, ${b.bank_account_id ?? null}, ${b.role})
      returning id, staff_account_id, bank_account_id, role, created_at, updated_at`;
    return c.json({ staff: json(r!) }, 201);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "already_staff" }, 409);
    throw err;
  }
});

staff.patch("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = z
    .object({ role, bank_account_id: uuid.nullable() })
    .partial()
    .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" })
    .safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const [cur] = await sql<{ staff_account_id: string }[]>`
    select staff_account_id from staff where id = ${id.data} and account_id = ${accountId}`;
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (body.data.bank_account_id && !(await bankAccountBelongsToStaff(sql, body.data.bank_account_id, cur.staff_account_id))) {
    return c.json({ error: "bank_account_not_found" }, 404);
  }
  const patch = body.data;
  const [r] = await sql<StaffRow[]>`
    update staff set ${sql(patch, ...(Object.keys(patch) as (keyof typeof patch)[]))}
     where id = ${id.data} and account_id = ${accountId}
    returning id, staff_account_id, bank_account_id, role, created_at, updated_at`;
  return c.json({ staff: json(r!) });
});

staff.delete("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`
    delete from staff where id = ${id.data} and account_id = ${c.get("auth").accountId} returning id`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
