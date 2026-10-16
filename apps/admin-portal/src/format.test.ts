import { ago, dollarsToCents, int, money } from "./format";

describe("format", () => {
  it("formats cents as dollars", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(2999)).toBe("$29.99");
    expect(money(123456789)).toBe("$1,234,567.89");
    expect(money(-250)).toBe("-$2.50");
  });
  it("groups counts", () => expect(int(1234567)).toBe("1,234,567"));
  it("parses typed dollars into cents without float drift", () => {
    expect(dollarsToCents("29.99")).toBe(2999);
    expect(dollarsToCents("0.07")).toBe(7);
    expect(dollarsToCents("19.9")).toBe(1990);
    expect(dollarsToCents(" 5 ")).toBe(500);
    expect(dollarsToCents("1.005")).toBeNull();
    expect(dollarsToCents("-1")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("")).toBeNull();
  });
  it("describes how old a snapshot is", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(ago("2026-10-16T12:00:00Z", now)).toBe("just now");
    expect(ago("2026-10-16T11:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-10-16T11:50:00Z", now)).toBe("10 min ago");
    expect(ago("2026-10-16T09:00:00Z", now)).toBe("3 h ago");
  });
});
