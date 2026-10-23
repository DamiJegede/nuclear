import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type Api } from "../api";
import { Settlements } from "./Settlements";

const RUNS = [
  { id: "2026-10-22", cutoff_date: "2026-10-22", status: "submitted" as const, merchants: 2, payout_total: 150000, collection_total: 6000, provider_reference: "ref-1", created_at: "2026-10-23T04:01:00Z", completed_at: null },
  { id: "2026-10-21", cutoff_date: "2026-10-21", status: "completed" as const, merchants: 1, payout_total: 90000, collection_total: 0, provider_reference: "ref-0", created_at: "2026-10-22T04:01:00Z", completed_at: "2026-10-22T04:02:00Z" },
];
const DETAIL = {
  settlement: { id: "2026-10-22", cutoff_date: "2026-10-22", status: "submitted", provider_reference: "ref-1" },
  items: [
    { id: "i1", merchant_id: "m1", merchant: "Alpha Cafe", kind: "payout" as const, amount: 150000, status: "submitted" as const, status_code: null, bank_last4: "4321" },
    { id: "i2", merchant_id: "m2", merchant: "Beta Books", kind: "collection" as const, amount: 6000, status: "returned" as const, status_code: "account_closed", bank_last4: "9876" },
  ],
};
const api = (over: Partial<Api> = {}) => ({ settlements: vi.fn().mockResolvedValue(RUNS), settlement: vi.fn().mockResolvedValue(DETAIL), runSettlement: vi.fn(), confirmSettlement: vi.fn(), ...over }) as unknown as Api;

describe("Settlements", () => {
  it("lists the days with their totals and status", async () => {
    render(<Settlements api={api()} canAdmin onError={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "2026-10-22" })).toBeInTheDocument();
    const row = screen.getByRole("button", { name: "2026-10-21" }).closest("tr")!;
    expect(within(row).getByText("$900.00")).toBeInTheDocument();
    expect(within(row).getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("opens a day: each merchant's payout or collection, its bank and its status; a returned one is flagged with its reason", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(<Settlements api={api()} canAdmin openMerchant={open} onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "2026-10-22" }));
    expect(await screen.findByRole("heading", { name: "Settlement 2026-10-22" })).toBeInTheDocument();
    const alpha = screen.getByRole("button", { name: "Alpha Cafe" }).closest("tr")!;
    expect(within(alpha).getByText("Payout")).toBeInTheDocument();
    expect(within(alpha).getByText("•••• 4321")).toBeInTheDocument();
    const beta = screen.getByRole("button", { name: "Beta Books" }).closest("tr")!;
    expect(within(beta).getByText("account_closed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Beta Books" }));
    expect(open).toHaveBeenCalledWith("m2");
    await user.click(screen.getByRole("button", { name: /Settlements$/ }));
    expect(await screen.findByRole("button", { name: "2026-10-21" })).toBeInTheDocument();
  });

  it("only Admin can run settlement or ask the bank; everyone else just reads", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Settlements api={api()} canAdmin={false} onError={vi.fn()} />);
    await screen.findByRole("button", { name: "2026-10-22" });
    expect(screen.queryByRole("button", { name: "Run Settlement Now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "2026-10-22" }));
    await screen.findByRole("heading", { name: "Settlement 2026-10-22" });
    expect(screen.queryByRole("button", { name: "Confirm With Bank" })).toBeNull();
    unmount();
  });

  it("Run Settlement Now asks first, then says what happened", async () => {
    const user = userEvent.setup();
    const runSettlement = vi.fn().mockResolvedValue({ ran: true, cutoff_date: "2026-10-22", created: 3, payouts: 2, collections: 1, payout_total: 150000, collection_total: 6000, status: "submitted" });
    render(<Settlements api={api({ runSettlement })} canAdmin onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Run Settlement Now" }));
    expect(runSettlement).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Run Settlement" }));
    expect(runSettlement).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Settled 2026-10-22: 2 payouts \(\$1,500\.00\) and 1 collections \(\$60\.00\)/)).toBeInTheDocument();
  });

  it("says plainly when no bank rail is configured", async () => {
    const user = userEvent.setup();
    const runSettlement = vi.fn().mockRejectedValue(new ApiError(503, "no_payment_provider"));
    render(<Settlements api={api({ runSettlement })} canAdmin onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Run Settlement Now" }));
    await user.click(screen.getByRole("button", { name: "Run Settlement" }));
    expect(await screen.findByText("No bank rail is configured, so nothing was sent.")).toBeInTheDocument();
  });

  it("Confirm With Bank asks the bank about a day that is still waiting", async () => {
    const user = userEvent.setup();
    const confirmSettlement = vi.fn().mockResolvedValue({ status: "completed", settled: 1, returned: 1 });
    render(<Settlements api={api({ confirmSettlement })} canAdmin onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "2026-10-22" }));
    await user.click(await screen.findByRole("button", { name: "Confirm With Bank" }));
    await user.click(screen.getByRole("button", { name: "Ask The Bank" }));
    expect(confirmSettlement).toHaveBeenCalledWith("2026-10-22");
    expect(await screen.findByText("The bank answered: 1 settled, 1 returned.")).toBeInTheDocument();
  });

  it("offers Try Again when the list cannot load", async () => {
    const settlements = vi.fn().mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue(RUNS);
    const user = userEvent.setup();
    render(<Settlements api={api({ settlements })} canAdmin onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("button", { name: "2026-10-22" })).toBeInTheDocument();
  });
});
