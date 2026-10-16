import { describe, expect, it } from "vitest";
import { parseUids } from "./csv";

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
