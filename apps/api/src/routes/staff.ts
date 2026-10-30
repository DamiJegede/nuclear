import { Hono } from "hono";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import { requireOwner, requireSession } from "../session";


export const staff = new Hono<AppContext>();
staff.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "B") return c.json({ error: "business_account_required" }, 403);
  await next();
});

type StaffRow = {
  id: string;
  staff_account_id: string;
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
  role: r.role,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const role = z.enum(["read", "write"]);

staff.get("/", async (c) => {
  const rows = await c.get("sql")<StaffRow[]>`
    select s.id, s.staff_account_id, s.role, s.created_at, s.updated_at, a.handle, a.name
      from staff s join accounts a on a.id = s.staff_account_id
     where s.account_id = ${c.get("auth").accountId}
     order by s.created_at, s.id`;
  return c.json({ staff: rows.map(json) });
});

staff.post("/", async (c) => {
  const body = z
    .object({ staff_account_id: uuid, role })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const b = body.data;

  const [person] = await sql<{ type: string; status: string }[]>`
    select type, status from accounts where id = ${b.staff_account_id}`;
  if (!person || person.type !== "C" || person.status !== "active") return c.json({ error: "staff_account_not_found" }, 404);
  try {
    const [r] = await sql<StaffRow[]>`
      insert into staff (account_id, staff_account_id, role)
      values (${accountId}, ${b.staff_account_id}, ${b.role})
      returning id, staff_account_id, role, created_at, updated_at`;
    return c.json({ staff: json(r!) }, 201);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "already_staff" }, 409);
    throw err;
  }
});

staff.patch("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = z
    .object({ role })
    .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" })
    .safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const [r] = await sql<StaffRow[]>`
    update staff set role = ${body.data.role}
     where id = ${id.data} and account_id = ${accountId}
    returning id, staff_account_id, role, created_at, updated_at`;
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ staff: json(r) });
});

staff.delete("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`
    delete from staff where id = ${id.data} and account_id = ${c.get("auth").accountId} returning id`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
