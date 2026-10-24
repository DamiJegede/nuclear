import { describe, expect, it } from "vitest";
import { deviceName } from "./deviceNames";

describe("deviceName", () => {
  it("maps a known iOS identifier to its printed name", () => {
    expect(deviceName("iPhone16,2")).toBe("iPhone 15 Pro Max");
    expect(deviceName("iPad16,3")).toBe("iPad Pro 11-inch (M4)");
  });
  it("shows anything else exactly as reported", () => {
    expect(deviceName("iPhone99,9")).toBe("iPhone99,9");
    expect(deviceName("samsung SM-S918B")).toBe("samsung SM-S918B");
  });
  it("is null when the device reported nothing", () => {
    expect(deviceName(null)).toBeNull();
  });
});
