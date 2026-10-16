import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { ApiError, type Api, type Stats, type TagModel } from "./api";

const v = (count: number, volume: number) => ({ count, volume });

const STATS: Stats = {
  as_of: new Date().toISOString(),
  scheme: { balance: 15000, consumer_balance: 12100, merchant_balance: 2900, merchant_debt: 0, pending: 900, credit_outstanding: 400, credit_limit: 1000 },
  reconciliation: { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true },
  users: { total: 1234, active: 1200, suspended: 30, closed: 4, new_7d: 56, new_30d: 200 },
  merchants: { total: 42, active: 40, transacting: 31, terminals: 55 },
  payments: {
    sent: v(10, 150000), tapped: v(2000, 5000000), in_app: v(300, 900000), merchant_payments: v(2300, 5900000),
    total: v(2310, 6050000), refunds: v(7, 12000), loaded: v(90, 8000000),
    today: { sent: v(1, 1500), tapped: v(40, 100000), in_app: v(3, 7000) },
  },
};

const MODEL: TagModel = {
  id: "m1", type: "band", name: "NEO Band Lite", photo: null, currency: "USD", price: 2999, country: null,
  quantity: 1000, sold: 12, limited: false, status: "pending", created_at: new Date().toISOString(), tags: 800, unassigned: 790,
};

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    stats: vi.fn().mockResolvedValue(STATS),
    models: vi.fn().mockResolvedValue([MODEL]),
    createModel: vi.fn().mockResolvedValue({ ...MODEL, id: "m2", name: "New" }),
    ...over,
  } as Api;
}

async function signIn(api: Api) {
  const user = userEvent.setup();
  render(<App makeApi={() => api} />);
  await user.type(screen.getByLabelText("Operator token"), "good-token");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("sign-in", () => {
  it("shows the sign-in screen first, with the button disabled until a token is typed", () => {
    render(<App makeApi={() => fakeApi()} />);
    expect(screen.getByRole("heading", { name: "Operator sign-in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.getByLabelText("Operator token")).toHaveAttribute("type", "password");
  });

  it("rejects a bad token and stays on the sign-in screen", async () => {
    const api = fakeApi({ stats: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) });
    const user = userEvent.setup();
    render(<App makeApi={() => api} />);
    await user.type(screen.getByLabelText("Operator token"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That token was not accepted.");
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    [404, "Admin access is not enabled on this API."],
    [0, "Can't reach the API"],
    [500, "Something went wrong"],
  ])("explains a %i from the API", async (status, text) => {
    const api = fakeApi({ stats: vi.fn().mockRejectedValue(new ApiError(status, "x")) });
    const user = userEvent.setup();
    render(<App makeApi={() => api} />);
    await user.type(screen.getByLabelText("Operator token"), "t");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("signs in with a good token, keeping it for this tab only", async () => {
    await signIn(fakeApi());
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "System overview" })).toBeInTheDocument();
    expect(sessionStorage.getItem("nuclear.admin.token")).toBe("good-token");
  });

  it("restores the session after a refresh and signs out cleanly", async () => {
    sessionStorage.setItem("nuclear.admin.token", "kept");
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} />);
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("heading", { name: "Operator sign-in" })).toBeInTheDocument();
    expect(sessionStorage.getItem("nuclear.admin.token")).toBeNull();
  });

  it("returns to sign-in with a notice when the token stops working mid-session", async () => {
    sessionStorage.setItem("nuclear.admin.token", "revoked");
    const api = fakeApi({ stats: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) });
    render(<App makeApi={() => api} />);
    expect(await screen.findByRole("heading", { name: "Operator sign-in" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your session ended");
    expect(sessionStorage.getItem("nuclear.admin.token")).toBeNull();
  });
});

describe("overview", () => {
  it("shows the four headline numbers", async () => {
    await signIn(fakeApi());
    const card = (name: string) => within(screen.getByRole("article", { name }));
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(card("Scheme balance").getByText("$150.00")).toBeInTheDocument();
    expect(card("Scheme balance").getByText(/Consumers \$121\.00 · Merchants \$29\.00/)).toBeInTheDocument();
    expect(card("Users").getByText("1,234")).toBeInTheDocument();
    expect(card("Users").getByText(/1,200 active · 56 new in 7 days/)).toBeInTheDocument();
    expect(card("Merchants").getByText("42")).toBeInTheDocument();
    expect(card("Merchants").getByText(/31 taking payments · 55 terminals/)).toBeInTheDocument();
    expect(card("Payments processed").getByText("$60,500.00")).toBeInTheDocument();
    expect(card("Payments processed").getByText(/2,310 payments, lifetime/)).toBeInTheDocument();
  });

  it("breaks payments down into sent, tapped and in-app, lifetime and today", async () => {
    await signIn(fakeApi());
    const table = within(await screen.findByRole("table"));
    const row = (name: RegExp) => within(table.getByRole("row", { name }));
    expect(row(/^Sent/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["10", "$1,500.00", "1", "$15.00"]);
    expect(row(/^Tapped/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2,000", "$50,000.00", "40", "$1,000.00"]);
    expect(row(/^In app/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["300", "$9,000.00", "3", "$70.00"]);
    expect(row(/^All payments/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2,310", "$60,500.00", "44", "$1,085.00"]);
    expect(row(/^Refunds/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["7", "$120.00", "–", "–"]);
    expect(row(/^Loaded/).getAllByRole("cell").map((c) => c.textContent)).toEqual(["90", "$80,000.00", "–", "–"]);
  });

  it("shows scheme detail including pending loads and credit", async () => {
    await signIn(fakeApi());
    const facts = await screen.findByText("Loads awaiting clearance");
    expect(facts.parentElement).toHaveTextContent("$9.00");
    expect(screen.getByText("Credit drawn").parentElement).toHaveTextContent("$4.00 of $10.00");
    expect(screen.getByText("Suspended or closed users").parentElement).toHaveTextContent("34");
  });

  it("says the books reconcile when they do", async () => {
    await signIn(fakeApi());
    expect(await screen.findByText("Books reconcile")).toBeInTheDocument();
    expect(screen.getByText("Books reconcile").closest("[role=status]")).not.toBeNull();
  });

  it("raises an alert with the gaps when they do not", async () => {
    const bad: Stats = {
      ...STATS,
      reconciliation: { balances_match_ledger: false, balance_difference: 700, credit_matches_ledger: false, credit_difference: -500, ledger_balanced: false },
    };
    await signIn(fakeApi({ stats: vi.fn().mockResolvedValue(bad) }));
    const alert = await screen.findByText("Books do not reconcile");
    const banner = alert.closest("[role=alert]")!;
    expect(banner).toHaveTextContent("Balances differ from the ledger by $7.00");
    expect(banner).toHaveTextContent("Credit differs from the ledger by $5.00");
    expect(banner).toHaveTextContent("The ledger is unbalanced");
  });

  it("refreshes on demand", async () => {
    const stats = vi.fn().mockResolvedValue(STATS);
    const user = await signIn(fakeApi({ stats }));
    await screen.findByRole("article", { name: "Scheme balance" });
    const before = stats.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(stats.mock.calls.length).toBe(before + 1));
  });

  it("offers a retry when the first load fails", async () => {
    const stats = vi.fn().mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue(STATS);
    sessionStorage.setItem("nuclear.admin.token", "t");
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi({ stats })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the numbers");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
  });

  it("keeps showing the last numbers if a later refresh fails", async () => {
    const stats = vi.fn().mockResolvedValueOnce(STATS).mockResolvedValueOnce(STATS).mockRejectedValue(new ApiError(0, "network_error"));
    const user = await signIn(fakeApi({ stats }));
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText(/refresh failed/)).toBeInTheDocument());
    expect(screen.getByRole("article", { name: "Scheme balance" })).toHaveTextContent("$150.00");
  });
});

describe("tag models", () => {
  async function openModels(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Tag models" }));
    return user;
  }

  it("lists models with sold, UIDs loaded and unassigned counts", async () => {
    await openModels(fakeApi());
    const row = await screen.findByRole("row", { name: /NEO Band Lite/ });
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["pending", "$29.99", "1,000", "12", "800", "790"]);
  });

  it("starts new models as pending and sends the price in cents", async () => {
    const createModel = vi.fn().mockResolvedValue({ ...MODEL, name: "NEO Band Pro" });
    const user = await openModels(fakeApi({ createModel }));
    await screen.findByRole("row", { name: /NEO Band Lite/ });
    expect(screen.getByLabelText("Status")).toHaveValue("pending");
    await user.type(screen.getByLabelText("Name"), "NEO Band Pro");
    await user.type(screen.getByLabelText("Price (USD)"), "49.99");
    await user.type(screen.getByLabelText("Quantity"), "250");
    await user.click(screen.getByLabelText("Limited edition"));
    await user.click(screen.getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(createModel).toHaveBeenCalledTimes(1));
    expect(createModel).toHaveBeenCalledWith({ type: "band", name: "NEO Band Pro", price: 4999, quantity: 250, limited: true, status: "pending" });
    expect(await screen.findByText("Added NEO Band Pro.")).toBeInTheDocument();
  });

  it("validates before calling the API", async () => {
    const createModel = vi.fn();
    const user = await openModels(fakeApi({ createModel }));
    await screen.findByRole("row", { name: /NEO Band Lite/ });
    await user.click(screen.getByRole("button", { name: "Add model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the model a name.");
    await user.type(screen.getByLabelText("Name"), "X");
    await user.type(screen.getByLabelText("Price (USD)"), "29.999");
    await user.click(screen.getByRole("button", { name: "Add model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the price in dollars");
    await user.clear(screen.getByLabelText("Price (USD)"));
    await user.type(screen.getByLabelText("Price (USD)"), "10");
    await user.type(screen.getByLabelText("Quantity"), "-3");
    await user.click(screen.getByRole("button", { name: "Add model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quantity must be a whole number.");
    expect(createModel).not.toHaveBeenCalled();
  });

  it("shows an error when the API refuses the model", async () => {
    const createModel = vi.fn().mockRejectedValue(new ApiError(400, "invalid_request"));
    const user = await openModels(fakeApi({ createModel }));
    await screen.findByRole("row", { name: /NEO Band Lite/ });
    await user.type(screen.getByLabelText("Name"), "X");
    await user.type(screen.getByLabelText("Price (USD)"), "1");
    await user.type(screen.getByLabelText("Quantity"), "1");
    await user.click(screen.getByRole("button", { name: "Add model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The API rejected those details");
  });

  it("shows an empty state", async () => {
    await openModels(fakeApi({ models: vi.fn().mockResolvedValue([]) }));
    expect(await screen.findByText(/No models yet/)).toBeInTheDocument();
  });
});
