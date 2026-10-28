import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Api, BankRow } from "../api";
import { Banks } from "./Banks";

const bank = (o: Partial<BankRow> = {}): BankRow => ({ id: "b1", routing_number: "110000000", name: "Test National Bank", icon: null, instant: true, networks: ["RTP", "FedNow"], refreshed_at: "2026-10-20T12:00:00Z", created_at: "2026-10-01T12:00:00Z", accounts: 3, ...o });
const page = (banks: BankRow[], o: object = {}) => ({ banks, next_cursor: null, total: banks.length, needs_logo: banks.filter((b) => !b.icon && b.accounts > 0).length, ...o });
const api = (over: Partial<Api> = {}) => ({ banks: vi.fn().mockResolvedValue(page([bank(), bank({ id: "b2", routing_number: "021000021", name: null, instant: null, networks: [], accounts: 1, icon: "https://x.test/v1/photos/banks/b2.png" })])), renameBank: vi.fn().mockResolvedValue(null), uploadBankIcon: vi.fn().mockResolvedValue(null), ...over }) as unknown as Api;

describe("Banks", () => {
  it("lists banks with name, routing number, instant status, accounts and a 'needs logo' marker", async () => {
    render(<Banks api={api()} canWrite onError={vi.fn()} />);
    const row = await screen.findByRole("row", { name: /Test National Bank/ });
    expect(row).toHaveTextContent("110000000");
    expect(row).toHaveTextContent("Yes · RTP, FedNow");
    expect(row).toHaveTextContent("needs logo");
    const other = screen.getByRole("row", { name: /021000021/ });
    expect(other).toHaveTextContent("Unnamed");
    expect(other).toHaveTextContent("Unknown");
    expect(other.querySelector("img.bank-icon")).toHaveAttribute("src", "https://x.test/v1/photos/banks/b2.png");
    expect(other).not.toHaveTextContent("needs logo");
  });

  it("the Needs Logo filter asks the API and shows how many are waiting", async () => {
    const banks = vi.fn().mockResolvedValue(page([bank()]));
    const user = userEvent.setup();
    render(<Banks api={api({ banks })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Needs Logo \(1\)/ }));
    await waitFor(() => expect(banks).toHaveBeenLastCalledWith(expect.objectContaining({ needsLogo: true })));
  });

  it("reports the count so the navigation badge and the Overview can show it", async () => {
    const onCount = vi.fn();
    render(<Banks api={api()} canWrite onError={vi.fn()} onCount={onCount} />);
    await screen.findByRole("row", { name: /Test National Bank/ });
    expect(onCount).toHaveBeenCalledWith(1);
  });

  it("a row opens to its actions; renaming asks for a name", async () => {
    const renameBank = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<Banks api={api({ renameBank })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("row", { name: /Test National Bank/ }));
    await user.click(screen.getByRole("button", { name: "Rename Test National Bank" }));
    const dlg = screen.getByRole("dialog", { name: "Rename Bank" });
    await user.clear(within(dlg).getByLabelText("Name"));
    await user.type(within(dlg).getByLabelText("Name"), "TNB");
    await user.click(within(dlg).getByRole("button", { name: "Save Name" }));
    await waitFor(() => expect(renameBank).toHaveBeenCalledWith("b1", "TNB"));
  });

  it("choosing a logo resizes it and uploads it for that bank", async () => {
    const uploadBankIcon = vi.fn().mockResolvedValue(null);
    // jsdom has no image decoding: stand in for the canvas pipeline
    const bitmap = { width: 400, height: 100, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const ctx = { drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array(10)], { type: "image/png" })));
    const user = userEvent.setup();
    render(<Banks api={api({ uploadBankIcon })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("row", { name: /Test National Bank/ }));
    await user.click(screen.getByRole("button", { name: "Upload logo for Test National Bank" }));
    await user.upload(screen.getByLabelText("Choose a bank logo"), new File([new Uint8Array(20)], "logo.png", { type: "image/png" }));
    await waitFor(() => expect(uploadBankIcon).toHaveBeenCalledWith("b1", expect.any(Blob)));
    // a wide logo is fitted, not cropped: drawn whole into the middle of the square
    const args = ctx.drawImage.mock.calls[0]!;
    expect(args.slice(1, 5)).toEqual([0, 0, 400, 100]);
    expect(args[7]).toBe(256);
    expect(await screen.findByText("Logo saved for Test National Bank.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("a role that can only look has no buttons", async () => {
    const user = userEvent.setup();
    render(<Banks api={api()} canWrite={false} onError={vi.fn()} />);
    await user.click(await screen.findByRole("row", { name: /Test National Bank/ }));
    expect(screen.queryByRole("button", { name: /^(Rename|Upload logo|Replace logo)/i })).toBeNull();
    expect(screen.getAllByText("You can look but not change banks.").length).toBeGreaterThan(0);
  });
});
