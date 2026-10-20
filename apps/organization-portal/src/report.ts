import type { BatchRowResult } from "./api";

/** One CSV cell: quoted when needed, and a leading = + - @ is neutralised so a spreadsheet never runs a name as a formula. */
const cell = (v: string | number): string => {
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export type ReportFilter = "all" | "claimed" | "unclaimed";

export const filterRows = (rows: BatchRowResult[], f: ReportFilter) => (f === "all" ? rows : rows.filter((r) => (f === "claimed" ? r.claimed : !r.claimed)));

/** The follow-up report: who was credited, how, and whether they have claimed (as of now). Amounts are dollars. */
export function reportCsv(rows: BatchRowResult[]): string {
  const head = ["employee_id", "name", "email", "amount", "credited_as", "status", "still_held", "last_reminded"];
  const lines = rows.map((r) => [
    r.employee_id, r.name, r.email, (r.amount / 100).toFixed(2), r.mode === "sent" ? "sent" : "held", r.claimed ? "claimed" : "not claimed",
    (r.balance / 100).toFixed(2), r.reminded_at ? r.reminded_at.slice(0, 10) : "",
  ].map(cell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
