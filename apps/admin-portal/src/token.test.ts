import { copyText, credentialsText, downloadText } from "./token";

describe("credentials file", () => {
  it("contains the Access ID, token and instructions", () => {
    const t = credentialsText("Jane Doe", "ABCDEFGH2345", "tok-0123456789", "https://admin.example");
    expect(t).toContain("Portal:        https://admin.example");
    expect(t).toContain("Name:          Jane Doe");
    expect(t).toContain("Access ID:     ABCDEFGH2345");
    expect(t).toContain("Access Token:  tok-0123456789");
    expect(t).toMatch(/two-step verification/);
  });
});

describe("browser helpers", () => {
  it("reports when copying is unavailable instead of throwing", async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    expect(await copyText("x")).toBe(false);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    expect(await copyText("x")).toBe(true);
    if (orig) Object.defineProperty(navigator, "clipboard", orig); else delete (navigator as any).clipboard;
  });

  it("downloads through a temporary link, and reports failure instead of throwing", () => {
    const click = vi.fn();
    const create = vi.fn().mockReturnValue("blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
    expect(downloadText("a.txt", "hello")).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:x");
    Object.assign(URL, { createObjectURL: () => { throw new Error("no"); } });
    expect(downloadText("a.txt", "hello")).toBe(false);
  });
});
