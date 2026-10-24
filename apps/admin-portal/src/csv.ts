/** Reads a supplier's file (CSV or plain list) and pulls out the NFC UIDs: 14 hex characters, with or without separators. */
export type ParsedUids = { uids: string[]; duplicates: number; ignored: number };

export function parseUids(text: string): ParsedUids {
  const seen = new Set<string>();
  let duplicates = 0;
  let ignored = 0;
  for (const raw of text.split(/[\s,;|]+/)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!token) continue;
    const uid = token.replace(/[:\-]/g, "").toUpperCase();
    if (/^[0-9A-F]{14}$/.test(uid)) {
      if (seen.has(uid)) duplicates++;
      else seen.add(uid);
    } else {
      ignored++;                       // header cells, labels and anything else that is not a UID
    }
  }
  return { uids: [...seen], duplicates, ignored };
}

/** One CSV field: quoted when needed, and a leading = + - @ (a spreadsheet formula) is defused with an apostrophe. Merchant names are free text. */
const field = (v: string | number | null) => {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export type PayoutRow = { merchant_id: string; merchant: string; kind: "payout" | "collection"; amount: number; status: string; status_code: string | null; bank_last4: string | null };

/** The day's payouts as a CSV (collections are left out). Amounts are in dollars and cents; the bank is its last four digits only, a full account number is never shown anywhere. */
export function payoutsCsv(date: string, items: PayoutRow[]): string {
  const head = ["settlement_date", "merchant", "merchant_id", "amount", "amount_cents", "bank_last4", "status", "reason"];
  const rows = items.filter((i) => i.kind === "payout").map((i) =>
    [date, i.merchant, i.merchant_id, (i.amount / 100).toFixed(2), i.amount, i.bank_last4, i.status, i.status_code].map(field).join(","));
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}
