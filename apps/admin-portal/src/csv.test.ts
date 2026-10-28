import { describe, expect, it } from "vitest";
import { parseUids, payoutsCsv } from "./csv";

describe("parseUids", () => {
  it("reads one UID per line, in any case or separator style", () => {
    const r = parseUids("04ae42eaaf12a0\n04:AE:42:EA:AF:12:A1\r\n04-ae-42-ea-af-12-a2\n");
    expect(r.uids).toEqual(["04AE42EAAF12A0", "04AE42EAAF12A1", "04AE42EAAF12A2"]);
    expect(r.duplicates).toBe(0);
  });
  it("finds UIDs in CSV columns, skipping the header and other cells", () => {
    const r = parseUids('uid,batch\n"04AE42EAAF12A0",B1\n04AE42EAAF12A1;B1\n');
    expect(r.uids).toEqual(["04AE42EAAF12A0", "04AE42EAAF12A1"]);
    expect(r.ignored).toBe(4);   // uid, batch, B1, B1
  });
  it("drops duplicates and counts them", () => {
    const r = parseUids("04AE42EAAF12A0\n04ae42eaaf12a0\n04AE42EAAF12A1");
    expect(r.uids).toHaveLength(2);
    expect(r.duplicates).toBe(1);
  });
  it("ignores values of the wrong length", () => {
    expect(parseUids("04AE42EAAF12\n04AE42EAAF12A0FF").uids).toEqual([]);
  });
  it("is empty for an empty file", () => {
    expect(parseUids("")).toEqual({ uids: [], duplicates: 0, ignored: 0 });
  });
});

describe("payoutsCsv", () => {
  const row = (o: Partial<Parameters<typeof payoutsCsv>[1][number]>) => ({ merchant_id: "m1", merchant: "Alpha Cafe", kind: "payout" as const, amount: 150050, status: "settled", status_code: null, bank_last4: "4321", ...o });

  it("lists only payouts, in dollars and cents, with the bank's last four digits", () => {
    const csv = payoutsCsv("2026-10-22", [row({}), row({ merchant_id: "m2", merchant: "Beta Books", kind: "collection", amount: 6000 })]);
    expect(csv).toBe("settlement_date,merchant,merchant_id,amount,amount_cents,bank_last4,source,rail,status,reason\r\n2026-10-22,Alpha Cafe,m1,1500.50,150050,4321,nightly,ach,settled,\r\n");
  });

  it("quotes commas and quotes, and defuses spreadsheet formulas in merchant names", () => {
    const csv = payoutsCsv("2026-10-22", [row({ merchant: 'Salt, "Sage" & Co' }), row({ merchant: "=HYPERLINK(\"http://x\")" }), row({ merchant: "+1 Pizza" })]);
    const lines = csv.trim().split("\r\n");
    expect(lines[1]).toContain('"Salt, ""Sage"" & Co"');
    expect(lines[2]).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(lines[3]).toContain("'+1 Pizza");
  });

  it("says how each payout was started and sent", () => {
    const csv = payoutsCsv("2026-10-22", [row({ source: "close_out", rail: "instant" })]);
    expect(csv.trim().split("\r\n")[1]).toContain(",close_out,instant,");
  });

  it("has only the header when there are no payouts", () => {
    expect(payoutsCsv("2026-10-22", [row({ kind: "collection" })]).trim().split("\r\n")).toHaveLength(1);
  });
});
