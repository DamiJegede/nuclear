import { dollarsToCents } from "./format";
import type { CreditRow } from "./api";

/** Splits CSV text into rows of cells. Handles quoted cells (with "" for a quote), commas and line breaks inside quotes, CRLF and a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export const MAX_ROWS = 2000;
export const MAX_CREDIT_CENTS = 10_000_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `errors` are formatting problems; `duplicates` are repeated employee IDs or emails (the file is well formed but must not run). */
export type CsvResult = { rows: CreditRow[]; errors: string[]; duplicates: string[]; total: number };

/** Reads the employee credit CSV: a header row with employee_id, name, email and amount (dollars), in any order. Every problem is listed, with its line number. */
export function readCreditCsv(text: string): CsvResult {
  const cells = parseCsv(text);
  const errors: string[] = [];
  if (cells.length === 0) return { rows: [], errors: ["The file is empty."], duplicates: [], total: 0 };
  const header = cells[0]!.map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(["employee_id", "name", "email", "amount"].map((k) => [k, header.indexOf(k)])) as Record<string, number>;
  const missing = Object.keys(col).filter((k) => col[k]! < 0);
  if (missing.length) return { rows: [], errors: [`The first line must name the columns employee_id, name, email and amount. Missing: ${missing.join(", ")}.`], duplicates: [], total: 0 };
  const body = cells.slice(1);
  if (body.length === 0) return { rows: [], errors: ["The file has a header but no employees."], duplicates: [], total: 0 };
  if (body.length > MAX_ROWS) return { rows: [], errors: [`A file can have at most ${MAX_ROWS} employees. Split it into smaller files.`], duplicates: [], total: 0 };

  const rows: CreditRow[] = [];
  const seen = new Set<string>(), seenEmail = new Set<string>();
  const duplicates: string[] = [];
  body.forEach((r, i) => {
    const line = i + 2;
    const employee_id = (r[col.employee_id!] ?? "").trim();
    const name = (r[col.name!] ?? "").trim();
    const email = (r[col.email!] ?? "").trim().toLowerCase();
    const amountText = (r[col.amount!] ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
    const cents = dollarsToCents(amountText);
    if (!/^[A-Za-z0-9]{1,64}$/.test(employee_id)) errors.push(`Line ${line}: employee_id must be letters and numbers only.`);
    else if (seen.has(employee_id)) duplicates.push(`Line ${line}: employee_id ${employee_id} appears more than once.`);
    seen.add(employee_id);
    if (EMAIL.test(email)) { if (seenEmail.has(email)) duplicates.push(`Line ${line}: ${email} appears more than once.`); seenEmail.add(email); }
    if (!name || name.length > 120) errors.push(`Line ${line}: enter a name (up to 120 characters).`);
    if (!EMAIL.test(email) || email.length > 254) errors.push(`Line ${line}: "${email}" is not a valid email.`);
    if (cents === null || cents <= 0) errors.push(`Line ${line}: "${r[col.amount!] ?? ""}" is not a valid amount.`);
    else if (cents > MAX_CREDIT_CENTS) errors.push(`Line ${line}: one credit can be at most $100,000.00.`);
    else rows.push({ employee_id, name, email, amount: cents });
  });
  const shown = errors.length > 20 ? [...errors.slice(0, 20), `…and ${errors.length - 20} more problems.`] : errors;
  return { rows: errors.length ? [] : rows, errors: shown, duplicates: duplicates.slice(0, 20), total: errors.length ? 0 : rows.reduce((s, r) => s + r.amount, 0) };
}

export const CSV_TEMPLATE = "employee_id,name,email,amount\nE001,Jane Doe,jane@example.com,50.00\nE002,John Smith,john@example.com,25.00\n";

export type FixedCsvResult = { rows: { employee_id: string; name: string; email: string; fixed_benefit: number }[]; errors: string[]; total: number; clears: number };

/** The fixed-benefits file: employee_id, name, email and fixed_benefit (dollars; 0 or empty clears that employee's fixed benefit). */
export function readFixedCsv(text: string): FixedCsvResult {
  const cells = parseCsv(text);
  const none = (errors: string[]): FixedCsvResult => ({ rows: [], errors, total: 0, clears: 0 });
  if (cells.length === 0) return none(["The file is empty."]);
  const header = cells[0]!.map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(["employee_id", "name", "email", "fixed_benefit"].map((k) => [k, header.indexOf(k)])) as Record<string, number>;
  const missing = Object.keys(col).filter((k) => col[k]! < 0);
  if (missing.length) return none([`The first line must name the columns employee_id, name, email and fixed_benefit. Missing: ${missing.join(", ")}.`]);
  const body = cells.slice(1);
  if (body.length === 0) return none(["The file has a header but no employees."]);
  if (body.length > MAX_ROWS) return none([`A file can have at most ${MAX_ROWS} employees. Split it into smaller files.`]);
  const errors: string[] = [];
  const rows: FixedCsvResult["rows"] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const line = i + 2;
    const employee_id = (r[col.employee_id!] ?? "").trim();
    const name = (r[col.name!] ?? "").trim();
    const email = (r[col.email!] ?? "").trim().toLowerCase();
    const raw = (r[col.fixed_benefit!] ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
    const cents = raw === "" ? 0 : dollarsToCents(raw);
    if (!/^[A-Za-z0-9]{1,64}$/.test(employee_id)) errors.push(`Line ${line}: employee_id must be letters and numbers only.`);
    else if (seen.has(employee_id)) errors.push(`Line ${line}: employee_id ${employee_id} appears more than once.`);
    seen.add(employee_id);
    if (!name || name.length > 120) errors.push(`Line ${line}: enter a name (up to 120 characters).`);
    if (!EMAIL.test(email) || email.length > 254) errors.push(`Line ${line}: "${email}" is not a valid email.`);
    if (cents === null) errors.push(`Line ${line}: "${r[col.fixed_benefit!] ?? ""}" is not a valid amount.`);
    else if (cents > MAX_CREDIT_CENTS) errors.push(`Line ${line}: one fixed benefit can be at most $100,000.00.`);
    else rows.push({ employee_id, name, email, fixed_benefit: cents });
  });
  const shown = errors.length > 20 ? [...errors.slice(0, 20), `…and ${errors.length - 20} more problems.`] : errors;
  return { rows: errors.length ? [] : rows, errors: shown, total: errors.length ? 0 : rows.reduce((t, r) => t + r.fixed_benefit, 0), clears: errors.length ? 0 : rows.filter((r) => r.fixed_benefit === 0).length };
}

export const FIXED_TEMPLATE = "employee_id,name,email,fixed_benefit\nE001,Jane Doe,jane@example.com,50.00\nE002,John Smith,john@example.com,25.00\nE003,No Benefit,none@example.com,0\n";
