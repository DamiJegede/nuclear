import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { ApiError, type AdminMe, type Api, type MfaChallenge, type SignedIn, type Stats, type TagModel } from "./api";
import { groupSecret } from "./views/Mfa";
import type { Page } from "./roles";

vi.mock("./image", () => ({ PHOTO_SIZE: 256, resizePhoto: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })) }));

const v = (count: number, volume: number) => ({ count, volume });

const STATS: Stats = {
  as_of: new Date().toISOString(),
  scheme: { balance: 15000, consumer_balance: 12100, merchant_balance: 2900, merchant_debt: 0, pending: 900, credit_outstanding: 400, credit_limit: 1000 },
  reconciliation: { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true, escrow_matches_employees: true, benefits_match_ledger: true, daily_caps_match_ledger: true },
  users: { total: 1234, active: 1200, suspended: 30, closed: 4, new_today: 7, new_7d: 56, new_30d: 200, wallets: 1890 },
  merchants: { total: 42, active: 40, transacting: 31, terminals: 55 },
  payments: {
    sent: v(10, 150000), tapped: v(2000, 5000000), in_app: v(300, 900000), agents: v(25, 40000), merchant_payments: v(2300, 5900000),
    total: v(2310, 6050000), refunds: v(7, 12000), loaded: v(90, 8000000),
    today: { sent: v(1, 1500), tapped: v(40, 100000), in_app: v(3, 7000), agents: v(2, 900) },
  },
};

const MODEL: TagModel = {
  id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", type: "band", name: "NEO Band Lite", photo: null, currency: "USD", price: 2999, country: null,
  quantity: 1000, sold: 12, limited: false, status: "pending", created_at: new Date().toISOString(), tags: 800, unassigned: 790,
};

const ALL_PAGES: Page[] = ["overview", "merchants", "users", "tags", "admins", "transactions"];
const SIGNED: SignedIn = {
  session_token: "session-abc", expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
  admin: { access_id: "JANEDOE00001", name: "Jane Doe", role: "admin" }, role: "admin", pages: ALL_PAGES, landing: "overview", mfa_enabled: true,
};
const ME: AdminMe = { access_id: "JANEDOE00001", name: "Jane Doe", role: "admin", pages: ALL_PAGES, landing: "overview", mfa_enabled: true };
const CHALLENGE: MfaChallenge = { mfa_required: true, mfa_token: "challenge-token-0123456789", expires_in: 300 };
const SETUP = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/Nuclear%20Admin:JANE.DOE?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Nuclear%20Admin&algorithm=SHA1&digits=6&period=30" };
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBB${i}`);

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    me: vi.fn().mockResolvedValue(ME),
    logout: vi.fn().mockResolvedValue(null),
    changeAccessToken: vi.fn().mockResolvedValue(null),
    admins: vi.fn().mockResolvedValue([]),
    createAdmin: vi.fn(),
    merchants: vi.fn().mockResolvedValue([]),
    users: vi.fn().mockResolvedValue([]),
    transactions: vi.fn().mockResolvedValue({ counts: { all: 0, sends: 0, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: 0, completed_volume: 0 }, transactions: [], next_cursor: null }),
    uploadModelPhoto: vi.fn().mockResolvedValue(null),
    model: vi.fn().mockResolvedValue(undefined),
    updateModel: vi.fn(),
    provisionTags: vi.fn(),
    mfaSetup: vi.fn().mockResolvedValue(SETUP),
    mfaEnable: vi.fn().mockResolvedValue(CODES),
    newRecoveryCodes: vi.fn().mockResolvedValue(CODES),
    stats: vi.fn().mockResolvedValue(STATS),
    models: vi.fn().mockResolvedValue([MODEL]),
    createModel: vi.fn().mockResolvedValue({ ...MODEL, id: "m2", name: "New" }),
    ...over,
  } as Api;
}

const T32 = "Tk7-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+";   // a 32-character Access Token
const TOKEN_KEY = "nuclear.admin.session";

async function signIn(api: Api, signInFn = vi.fn().mockResolvedValue(SIGNED), completeMfa = vi.fn()) {
  const user = userEvent.setup();
  render(<App makeApi={() => api} signIn={signInFn} completeMfa={completeMfa} />);
  await user.type(screen.getByLabelText("Access ID"), "JANEDOE00001");
  await user.type(screen.getByLabelText("Access Token"), T32);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("sign-in", () => {
  it("asks for an Access ID and an Access Token, and shows Continue only once both are complete", async () => {
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Access ID")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    await user.type(screen.getByLabelText("Access ID"), "JANEDOE00001");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();            // the token is still missing
    await user.type(screen.getByLabelText("Access Token"), T32.slice(0, 31));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();            // 31 of 32
    await user.type(screen.getByLabelText("Access Token"), T32.slice(31));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    await user.type(screen.getByLabelText("Access ID"), "{Backspace}");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();            // 11 of 12
  });

  it("limits the length of both fields: 12 characters and 32", async () => {
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.getByLabelText("Access ID")).toHaveAttribute("maxlength", "12");
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("maxlength", "32");
    await user.type(screen.getByLabelText("Access ID"), "ABCDEFGHJKMNPQRST");
    await user.type(screen.getByLabelText("Access Token"), T32 + "EXTRA-CHARACTERS");
    expect(screen.getByLabelText("Access ID")).toHaveValue("ABCDEFGHJKMN");
    expect(screen.getByLabelText("Access Token")).toHaveValue(T32);
  });

  it("does not offer an operator-token sign-in any more", () => {
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.queryByLabelText(/operator/i)).toBeNull();
    expect(screen.getByLabelText("Access Token")).toBeInTheDocument();
  });

  it("sends the Access ID in uppercase, and the Access Token exactly as typed", async () => {
    const signInFn = vi.fn().mockResolvedValue(SIGNED);
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={signInFn} />);
    await user.type(screen.getByLabelText("Access ID"), "janedoe00001");
    await user.type(screen.getByLabelText("Access Token"), T32);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(signInFn).toHaveBeenCalledWith("JANEDOE00001", T32);
  });

  it("gives one message for any credential failure, keeps the Access ID and clears the Access Token", async () => {
    const signInFn = vi.fn().mockRejectedValue(new ApiError(401, "invalid_credentials"));
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={signInFn} />);
    await user.type(screen.getByLabelText("Access ID"), "JANEDOE00001");
    await user.type(screen.getByLabelText("Access Token"), "w".repeat(32));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access ID or Access Token is incorrect.");
    expect(screen.getByLabelText("Access ID")).toHaveValue("JANEDOE00001");
    expect(screen.getByLabelText("Access Token")).toHaveValue("");
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    [0, "Can't reach the API"],
    [400, "Enter your Access ID and Access Token."],
    [500, "Something went wrong"],
  ])("explains a %i from the API", async (status, text) => {
    const signInFn = vi.fn().mockRejectedValue(new ApiError(status, "x"));
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={signInFn} />);
    await user.type(screen.getByLabelText("Access ID"), "a".repeat(12));
    await user.type(screen.getByLabelText("Access Token"), "b".repeat(32));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("tells people about the lock-out rule", () => {
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.getByText(/lock the account for 15 minutes/)).toBeInTheDocument();
  });

  it("signs in, showing the admin's name and keeping only the session token for this tab", async () => {
    await signIn(fakeApi());
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("session-abc");
    const stored = JSON.stringify(Object.entries(sessionStorage));
    expect(stored).not.toContain("correct horse battery");
  });

  it("restores the session after a refresh by asking the API who it is", async () => {
    sessionStorage.setItem(TOKEN_KEY, "kept");
    const me = vi.fn().mockResolvedValue(ME);
    render(<App makeApi={() => fakeApi({ me })} signIn={vi.fn()} />);
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(me).toHaveBeenCalled();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });

  it("signs out on the server and clears the tab", async () => {
    const logout = vi.fn().mockResolvedValue(null);
    const user = await signIn(fakeApi({ logout }));
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("still signs out locally when the server cannot be reached", async () => {
    const user = await signIn(fakeApi({ logout: vi.fn().mockRejectedValue(new ApiError(0, "network_error")) }));
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("returns to sign-in with a notice when the session stops working mid-use", async () => {
    sessionStorage.setItem(TOKEN_KEY, "expired");
    const api = fakeApi({ stats: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) });
    render(<App makeApi={() => api} signIn={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your session ended");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("returns to sign-in when a restored session is no longer valid", async () => {
    sessionStorage.setItem(TOKEN_KEY, "revoked");
    render(<App makeApi={() => fakeApi({ me: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) })} signIn={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("overview", () => {
  it("shows the four headline numbers", async () => {
    await signIn(fakeApi());
    const card = (name: string) => within(screen.getByRole("article", { name }));
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(card("Scheme balance").getByText("$150.00")).toBeInTheDocument();
    expect(card("Scheme balance").getByText("Consumers $121.00")).toBeInTheDocument();
    expect(card("Scheme balance").getByText("Merchants $29.00")).toBeInTheDocument();
    expect(card("Users").getByText("1,234")).toBeInTheDocument();
    expect(card("Users").getByText("1,200 active · 7 new today")).toBeInTheDocument();
    expect(card("Users").getByText("1,890 wallets")).toBeInTheDocument();
    expect(card("Merchants").getByText("42")).toBeInTheDocument();
    expect(card("Merchants").getByText("31 accepting payments")).toBeInTheDocument();
    expect(card("Merchants").getByText("55 terminals")).toBeInTheDocument();
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
      reconciliation: { balances_match_ledger: false, balance_difference: 700, credit_matches_ledger: false, credit_difference: -500, ledger_balanced: false, earmarks_within_balances: true, escrow_matches_employees: true, benefits_match_ledger: true, daily_caps_match_ledger: true },
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
    sessionStorage.setItem(TOKEN_KEY, "t");
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi({ stats })} signIn={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the numbers");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
  });

  it("keeps showing the last numbers if a later refresh fails", async () => {
    const stats = vi.fn().mockResolvedValueOnce(STATS).mockRejectedValue(new ApiError(0, "network_error"));
    const user = await signIn(fakeApi({ stats }));
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText(/refresh failed/)).toBeInTheDocument());
    expect(screen.getByRole("article", { name: "Scheme balance" })).toHaveTextContent("$150.00");
  });
});

const DETAIL = { ...MODEL, tags: 600, unassigned: 480, activated: 120, pending: 400, rank: 1, models_total: 3 };
const dialog = () => screen.getByRole("dialog");
const PNG = () => new File(["x"], "band.png", { type: "image/png" });

describe("tags page", () => {
  async function openModels(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Tags" }));
    return user;
  }
  const addCard = () => screen.findByRole("button", { name: "Add Tag" });

  it("shows each tag as a card with name, sold / quantity and type", async () => {
    await openModels(fakeApi());
    const card = (await screen.findByRole("heading", { name: "NEO Band Lite" })).closest("li")!;
    expect(card).toHaveTextContent("12 / 1,000 sold");
    expect(within(card).getByText("BAND")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Tags" })).getByRole("button", { name: "Add Tag" })).toBeInTheDocument();
  });

  it("gives every page its own history entry, so back and forward work", async () => {
    const user = await openModels(fakeApi());
    expect(window.location.pathname).toBe("/tags");
    expect(screen.getByRole("link", { name: "Tags" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("link", { name: "Admins" }));
    expect(window.location.pathname).toBe("/admins");
    act(() => { window.history.back(); });
    await screen.findByRole("heading", { name: "Tags" });
    expect(window.location.pathname).toBe("/tags");
    act(() => { window.history.back(); });
    await screen.findByRole("article", { name: "Scheme balance" });
    act(() => { window.history.forward(); });
    await screen.findByRole("heading", { name: "Tags" });
  });

  it("opens the Add a Tag modal with the type as two cards, uppercase statuses, a Limited Edition switch and a PNG-only image", async () => {
    const user = await openModels(fakeApi());
    await user.click(await addCard());
    const d = within(dialog());
    expect(d.getByRole("heading", { name: "Add a Tag" })).toBeInTheDocument();
    expect(d.getByRole("radio", { name: "Band" })).toBeChecked();
    await user.click(d.getByRole("radio", { name: "Card" }));
    expect(d.getByRole("radio", { name: "Card" })).toBeChecked();
    expect(d.getAllByRole("option").map((o) => o.textContent)).toEqual(["PENDING", "PREORDER", "AVAILABLE", "CLOSED"]);
    expect(d.getByRole("switch", { name: "Limited Edition" })).not.toBeChecked();
    expect(d.getByRole("button", { name: "Select Image" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tag Image")).toHaveAttribute("accept", "image/png");
    const zone = d.getByText("Drag and drop a PNG here").parentElement!;
    zone.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } }));
    expect(await d.findByText("Only PNG images are accepted.")).toBeInTheDocument();
    expect(d.getAllByRole("button").map((b) => b.textContent).slice(-2)).toEqual(["Add Tag", "Cancel"]);
  });

  it("adds a tag as pending, sending the price in cents, then uploads the image", async () => {
    URL.createObjectURL = vi.fn(() => "blob:preview"); URL.revokeObjectURL = vi.fn();
    const createModel = vi.fn().mockResolvedValue({ ...MODEL, id: "m-new", name: "NEO Band Pro" });
    const uploadModelPhoto = vi.fn().mockResolvedValue(null);
    const user = await openModels(fakeApi({ createModel, uploadModelPhoto }));
    await user.click(await addCard());
    expect(screen.getByLabelText("Status")).toHaveValue("pending");
    await user.type(screen.getByLabelText("Name"), "NEO Band Pro");
    await user.type(screen.getByLabelText("Price (USD)"), "49.99");
    await user.type(screen.getByLabelText("Quantity"), "250");
    await user.click(screen.getByRole("switch", { name: "Limited Edition" }));
    await user.upload(screen.getByLabelText("Tag Image"), PNG());
    await screen.findByAltText("Photo preview");
    await user.click(within(dialog()).getByRole("button", { name: "Add Tag" }));
    await waitFor(() => expect(createModel).toHaveBeenCalledWith({ type: "band", name: "NEO Band Pro", price: 4999, quantity: 250, limited: true, status: "pending" }));
    await waitFor(() => expect(uploadModelPhoto).toHaveBeenCalledWith("m-new", expect.any(Blob)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("validates before calling the API", async () => {
    const createModel = vi.fn();
    const user = await openModels(fakeApi({ createModel }));
    await user.click(await addCard());
    const d = within(dialog());
    await user.click(d.getByRole("button", { name: "Add Tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Give the tag a name.");
    await user.type(screen.getByLabelText("Name"), "X");
    await user.type(screen.getByLabelText("Price (USD)"), "29.999");
    await user.click(d.getByRole("button", { name: "Add Tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the price in dollars");
    await user.clear(screen.getByLabelText("Price (USD)"));
    await user.type(screen.getByLabelText("Price (USD)"), "$2a9.9.9,");
    expect(screen.getByLabelText("Price (USD)")).toHaveValue("29.99");             // only 0-9 and one "." are accepted
    await user.clear(screen.getByLabelText("Price (USD)"));
    await user.type(screen.getByLabelText("Price (USD)"), "10");
    await user.type(screen.getByLabelText("Quantity"), "-3.5e");
    expect(screen.getByLabelText("Quantity")).toHaveValue("35");                     // quantity takes digits only
    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "5");
    await user.click(d.getByRole("button", { name: "Add Tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a PNG image of the tag.");
    expect(createModel).not.toHaveBeenCalled();
  });

  it("shows an error when the API refuses the tag", async () => {
    URL.createObjectURL = vi.fn(() => "blob:preview"); URL.revokeObjectURL = vi.fn();
    const createModel = vi.fn().mockRejectedValue(new ApiError(400, "invalid_request"));
    const user = await openModels(fakeApi({ createModel }));
    await user.click(await addCard());
    await user.type(screen.getByLabelText("Name"), "X");
    await user.type(screen.getByLabelText("Price (USD)"), "1");
    await user.type(screen.getByLabelText("Quantity"), "1");
    await user.upload(screen.getByLabelText("Tag Image"), PNG());
    await screen.findByAltText("Photo preview");
    await user.click(within(dialog()).getByRole("button", { name: "Add Tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The API rejected those details");
  });

  it("with no tags, the Add Tag card is all there is", async () => {
    await openModels(fakeApi({ models: vi.fn().mockResolvedValue([]) }));
    expect(await addCard()).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("tag page", () => {
  async function openTag(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Tags" }));
    await user.click(await screen.findByRole("link", { name: /NEO Band Lite/ }));
    await screen.findByRole("group", { name: "Sales Ranking" });
    return user;
  }
  const detailApi = (extra: Partial<Api> = {}) => fakeApi({ model: vi.fn().mockResolvedValue(DETAIL), ...extra } as Partial<Api>);

  it("opens from a card at its own address, with a static copy of the card, ranking, activation and pending", async () => {
    await openTag(detailApi());
    expect(window.location.pathname).toBe(`/tags/${MODEL.id}`);
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Tags" })).toHaveClass("active");
    const stat = (n: string) => screen.getByRole("group", { name: n });
    expect(stat("Sales Ranking")).toHaveTextContent("#1");
    expect(stat("Sales Ranking")).toHaveTextContent("of 3 tags");
    expect(stat("Activated")).toHaveTextContent("120");
    expect(screen.getByRole("button", { name: "Provision Tags" })).toHaveTextContent("400");
    expect(screen.getByRole("button", { name: "Provision Tags" })).toHaveTextContent("PENDING · 600 of 1,000 loaded");
    expect(screen.getByLabelText("NEO Band Lite")).toHaveClass("static");   // the unselectable card
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("works with back, forward and a direct visit", async () => {
    const user = await openTag(detailApi());
    act(() => { window.history.back(); });
    await screen.findByRole("list", { name: "Tags" });
    act(() => { window.history.forward(); });
    await screen.findByRole("group", { name: "Sales Ranking" });
    cleanup();
    window.history.replaceState(null, "", `/tags/${MODEL.id}`);
    sessionStorage.setItem(TOKEN_KEY, "t");
    render(<App makeApi={() => detailApi()} signIn={vi.fn()} />);
    expect(await screen.findByRole("group", { name: "Sales Ranking" })).toBeInTheDocument();
  });

  it("edits the tag in the same modal, titled Edit Tag, filled with the current values", async () => {
    const updateModel = vi.fn().mockResolvedValue(MODEL);
    const user = await openTag(detailApi({ updateModel }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const d = within(dialog());
    expect(d.getByRole("heading", { name: "Edit Tag" })).toBeInTheDocument();
    expect(d.getByLabelText("Name")).toHaveValue("NEO Band Lite");
    expect(d.getByLabelText("Price (USD)")).toHaveValue("29.99");
    expect(d.getByLabelText("Quantity")).toHaveValue("1000");
    await user.clear(d.getByLabelText("Name"));
    await user.type(d.getByLabelText("Name"), "NEO Band Lite 2");
    await user.click(d.getByRole("button", { name: "Save Changes" }));   // no new image needed when editing
    await waitFor(() => expect(updateModel).toHaveBeenCalledWith(MODEL.id, { type: "band", name: "NEO Band Lite 2", price: 2999, quantity: 1000, limited: false, status: "pending" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("explains the API's refusals when editing", async () => {
    const updateModel = vi.fn().mockRejectedValue(new ApiError(409, "quantity_below_sold"));
    const user = await openTag(detailApi({ updateModel }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(within(dialog()).getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("can't be lower than the number already sold");
  });

  it("provisions tags from a CSV: shows what it found, loads it, and reports the new pending count", async () => {
    const provisionTags = vi.fn().mockResolvedValue({ requested: 3, inserted: 3, duplicates_in_request: 0, already_existing: [] });
    const user = await openTag(detailApi({ provisionTags }));
    await user.click(screen.getByRole("button", { name: "Provision Tags" }));
    const d = within(dialog());
    expect(d.getByText(/600 of 1,000 provisioned, 400 pending/)).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Load Tags" })).toBeDisabled();
    const csv = new File(["uid,batch\n04AE42EAAF12A0,B1\n04AE42EAAF12A1,B1\n04ae42eaaf12a0,B1\n04AE42EAAF12A2,B1\n"], "uids.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("UID File"), csv);
    expect(await d.findByText(/3 UIDs found, 1 repeated, 6 other values ignored/)).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Load 3 Tags" }));
    await waitFor(() => expect(provisionTags).toHaveBeenCalledWith(MODEL.id, ["04AE42EAAF12A0", "04AE42EAAF12A1", "04AE42EAAF12A2"]));
    expect(await d.findByText(/tags loaded for NEO Band Lite/)).toBeInTheDocument();
    expect(d.getByText(/603 of 1,000 provisioned, 397 pending/)).toBeInTheDocument();
  });

  it("refuses a file with no UIDs in it", async () => {
    const user = await openTag(detailApi());
    await user.click(screen.getByRole("button", { name: "Provision Tags" }));
    await user.upload(screen.getByLabelText("UID File"), new File(["nothing,here\n"], "x.csv", { type: "text/csv" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No UIDs found");
  });
});

describe("two-step sign-in", () => {
  async function toCodeStep(extra: Partial<{ completeMfa: any; api: Api }> = {}) {
    const signInFn = vi.fn().mockResolvedValue(CHALLENGE);
    const completeMfa = extra.completeMfa ?? vi.fn().mockResolvedValue(SIGNED);
    const user = await signIn(extra.api ?? fakeApi(), signInFn, completeMfa);
    await screen.findByRole("heading", { name: "Two-step verification" });
    return { user, signInFn, completeMfa };
  }

  it("asks for the authenticator code after a correct password, and forgets the Access Token", async () => {
    const { user } = await toCodeStep();
    expect(screen.getByLabelText("Authentication code")).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.getByLabelText("Authentication code")).toHaveAttribute("inputmode", "numeric");
    expect(screen.queryByLabelText("Access Token")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Access Token")).toHaveValue("");
    expect(screen.getByLabelText("Access ID")).toHaveValue("JANEDOE00001");
  });

  it("finishes sign-in with the code, sending the challenge token", async () => {
    const { user, completeMfa } = await toCodeStep();
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(completeMfa).toHaveBeenCalledWith("challenge-token-0123456789", "123456");
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("session-abc");
  });

  it("does not store a session until the second step succeeds", async () => {
    await toCodeStep();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("refuses a wrong code with one message and clears the field", async () => {
    const { user } = await toCodeStep({ completeMfa: vi.fn().mockRejectedValue(new ApiError(401, "invalid_credentials")) });
    await user.type(screen.getByLabelText("Authentication code"), "000000");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work");
    expect(screen.getByLabelText("Authentication code")).toHaveValue("");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it.each([[503, "unavailable right now"], [0, "Can't reach the API"], [500, "Something went wrong"]])("explains a %i on the code step", async (status, text) => {
    const { user } = await toCodeStep({ completeMfa: vi.fn().mockRejectedValue(new ApiError(status, "x")) });
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("switches to a recovery code and back", async () => {
    const { user, completeMfa } = await toCodeStep();
    await user.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    expect(screen.getByLabelText("Recovery code")).toBeInTheDocument();
    expect(screen.getByText(/works only once/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Recovery code"), "ABCDE-FGHJK");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(completeMfa).toHaveBeenCalledWith("challenge-token-0123456789", "ABCDE-FGHJK");
    await screen.findByRole("article", { name: "Scheme balance" });
  });

  it("can go back to the authenticator code from recovery mode", async () => {
    const { user } = await toCodeStep();
    await user.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    await user.click(screen.getByRole("button", { name: "Use my authenticator app instead" }));
    expect(screen.getByLabelText("Authentication code")).toBeInTheDocument();
  });

  it("keeps the Sign in button disabled until something is typed", async () => {
    await toCodeStep();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });
});

describe("two-step enrollment", () => {
  const NEEDS: SignedIn = { ...SIGNED, mfa_enabled: false };

  async function enrollScreen(api: Api, first: SignedIn = NEEDS) {
    const user = await signIn(api, vi.fn().mockResolvedValue(first));
    await screen.findByRole("heading", { name: "Set up two-step verification" });
    return user;
  }

  it("is required before the portal opens", async () => {
    await enrollScreen(fakeApi());
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("article", { name: "Scheme balance" })).toBeNull();
  });

  it("shows a scannable QR code and the key to type by hand", async () => {
    await enrollScreen(fakeApi());
    const qr = await screen.findByRole("img", { name: /QR code/ });
    await waitFor(() => expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/));
    expect(decodeURIComponent(qr.getAttribute("src")!)).toContain("<svg");
    expect(screen.getByLabelText("Setup key")).toHaveTextContent("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  });

  it("groups the key in fours", () => {
    expect(groupSecret("ABCDEFGHIJKL")).toBe("ABCD EFGH IJKL");
    expect(groupSecret("ABCDEF")).toBe("ABCD EF");
  });

  it("does nothing until a code is typed, then shows the ten recovery codes once", async () => {
    const mfaEnable = vi.fn().mockResolvedValue(CODES);
    const user = await enrollScreen(fakeApi({ mfaEnable }));
    const go = screen.getByRole("button", { name: "Turn on two-step verification" });
    await screen.findByRole("img", { name: /QR code/ });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText(/enter the 6-digit code/i), "123456");
    await user.click(go);
    expect(mfaEnable).toHaveBeenCalledWith("123456");
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(within(list).getByText("AAAA0-BBBB0")).toBeInTheDocument();
  });

  it("makes the person confirm they saved the codes before continuing", async () => {
    const user = await enrollScreen(fakeApi());
    await screen.findByRole("img", { name: /QR code/ });
    await user.type(screen.getByLabelText(/enter the 6-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    await screen.findByRole("list", { name: "Recovery codes" });
    const cont = screen.getByRole("button", { name: "Continue" });
    expect(cont).toBeDisabled();
    await user.click(screen.getByLabelText("I have saved these codes"));
    await user.click(cont);
    expect(await screen.findByRole("article", { name: "Scheme balance" })).toBeInTheDocument();
  });

  it("rejects a wrong code and lets them retry", async () => {
    const mfaEnable = vi.fn().mockRejectedValueOnce(new ApiError(401, "invalid_code")).mockResolvedValue(CODES);
    const user = await enrollScreen(fakeApi({ mfaEnable }));
    await screen.findByRole("img", { name: /QR code/ });
    await user.type(screen.getByLabelText(/enter the 6-digit code/i), "000000");
    await user.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not right");
    expect(screen.getByLabelText(/enter the 6-digit code/i)).toHaveValue("");
    await user.type(screen.getByLabelText(/enter the 6-digit code/i), "654321");
    await user.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toBeInTheDocument();
  });

  it("says so when the API cannot do two-step verification", async () => {
    await enrollScreen(fakeApi({ mfaSetup: vi.fn().mockRejectedValue(new ApiError(503, "mfa_unavailable")) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable right now");
  });

  it("lets the person sign out instead", async () => {
    const user = await enrollScreen(fakeApi());
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("is demanded if the API says the data is closed until MFA is set up", async () => {
    sessionStorage.setItem(TOKEN_KEY, "t");
    const stats = vi.fn().mockRejectedValue(new ApiError(403, "mfa_setup_required"));
    render(<App makeApi={() => fakeApi({ stats })} signIn={vi.fn()} completeMfa={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Set up two-step verification" })).toBeInTheDocument();
  });
});

describe("security tab", () => {
  async function openSecurity(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Jane Doe" }));   // the name opens Security
    return user;
  }

  it("shows that two-step verification is on", async () => {
    await openSecurity(fakeApi());
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("On.");
  });

  it("makes new recovery codes only with a current code", async () => {
    const newRecoveryCodes = vi.fn().mockResolvedValue(CODES);
    const user = await openSecurity(fakeApi({ newRecoveryCodes }));
    const btn = screen.getByRole("button", { name: "Make new recovery codes" });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(btn);
    expect(newRecoveryCodes).toHaveBeenCalledWith("123456");
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("I have saved these codes"));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("list", { name: "Recovery codes" })).toBeNull();
  });

  it("refuses a wrong code", async () => {
    const user = await openSecurity(fakeApi({ newRecoveryCodes: vi.fn().mockRejectedValue(new ApiError(401, "invalid_code")) }));
    await user.type(screen.getByLabelText("Authentication code"), "000000");
    await user.click(screen.getByRole("button", { name: "Make new recovery codes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not right.");
  });
});

describe("rotating an Access Token", () => {
  const ROWS = [
    { id: "a1", access_id: "NLINF8Q0KAZ4", name: "Nuclear Admin", status: "active", mfa_enabled: true, locked: false, last_login_at: "2026-10-15T20:00:00Z", created_at: "2026-10-14T00:00:00Z", created_by: null },
  ];
  const NEW = { access_id: "NLINF8Q0KAZ4", access_token: "Rr7-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+" };

  async function open(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Admins" }));
    return user;
  }

  it("asks first, then shows the new token masked with copy and download", async () => {
    const rotateAccessToken = vi.fn().mockResolvedValue({ admin: { id: "a1", access_id: NEW.access_id, name: "Nuclear Admin" }, credentials: NEW });
    const user = await open(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), rotateAccessToken }));
    await user.click(await screen.findByRole("button", { name: "Rotate Access Token for Nuclear Admin" }));
    expect(rotateAccessToken).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rotate Access Token" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm rotate" }));
    expect(rotateAccessToken).toHaveBeenCalledWith("a1");
    expect(screen.getByRole("dialog", { name: "New Access Token for Nuclear Admin" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "New Access Token for Nuclear Admin" })).toBeInTheDocument();
    expect(screen.getByTestId("access-token")).not.toHaveTextContent(NEW.access_token);
    expect(screen.getByRole("button", { name: "Download credentials" })).toBeInTheDocument();
    expect(screen.queryByText(NEW.access_token)).toBeNull();
  });

  it("can be cancelled without calling the API", async () => {
    const rotateAccessToken = vi.fn();
    const user = await open(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), rotateAccessToken }));
    await user.click(await screen.findByRole("button", { name: "Rotate Access Token for Nuclear Admin" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rotateAccessToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rotate Access Token for Nuclear Admin" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rotateAccessToken).not.toHaveBeenCalled();
  });

  it("cannot be dismissed by Escape while the new token is on screen, and the Copy button turns into Copied", async () => {
    const rotateAccessToken = vi.fn().mockResolvedValue({ admin: { id: "a1", access_id: NEW.access_id, name: "Nuclear Admin" }, credentials: NEW });
    const user = await open(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), rotateAccessToken }));
    await user.click(await screen.findByRole("button", { name: "Rotate Access Token for Nuclear Admin" }));
    await user.click(screen.getByRole("button", { name: "Confirm rotate" }));
    await screen.findByRole("dialog", { name: "New Access Token for Nuclear Admin" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Copy" })[1]!);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();   // the button itself says so
    expect(screen.queryByText(/copied\./i)).toBeNull();                                  // no separate notice
    await user.click(screen.getByLabelText("I have saved these credentials"));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports a failure", async () => {
    const user = await open(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), rotateAccessToken: vi.fn().mockRejectedValue(new ApiError(500, "server_error")) }));
    await user.click(await screen.findByRole("button", { name: "Rotate Access Token for Nuclear Admin" }));
    await user.click(screen.getByRole("button", { name: "Confirm rotate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't rotate");
  });
});

describe("admins page", () => {
  const ROWS = [
    { id: "a1", access_id: "NLINF8Q0KAZ4", name: "Nuclear Admin", role: "admin", status: "active", mfa_enabled: true, locked: false, last_login_at: "2026-10-15T20:00:00Z", created_at: "2026-10-14T00:00:00Z", created_by: null },
    { id: "a2", access_id: "KQ7M2XW9TBDV", name: "New Person", role: "accounting", status: "active", mfa_enabled: false, locked: false, last_login_at: null, created_at: "2026-10-15T00:00:00Z", created_by: "NLINF8Q0KAZ4" },
  ];
  const CREDS = { access_id: "KQ7M2XW9TBDV", access_token: "Zk9-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+" };

  async function openAdmins(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Admins" }));
    return user;
  }

  it("lists admins with status, role, last sign-in and who added them", async () => {
    await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS) }));
    const first = await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    expect(within(first).getByText("Nuclear Admin")).toBeInTheDocument();
    expect(within(first).getByText("Admin")).toBeInTheDocument();
    expect(within(first).getByText("Operator")).toBeInTheDocument();
    const second = screen.getByRole("row", { name: /^KQ7M2XW9TBDV/ });
    expect(within(second).getByText("Accounting")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Two-step" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeInTheDocument();
    expect(within(second).getByText("Never")).toBeInTheDocument();
    expect(within(second).getByText("has not signed in yet")).toBeInTheDocument();
    expect(within(second).getByText("NLINF8Q0KAZ4")).toBeInTheDocument();
  });

  it("creates an admin and shows the Access ID and token once", async () => {
    const createAdmin = vi.fn().mockResolvedValue({ admin: { id: "a2", access_id: CREDS.access_id, name: "New Person" }, credentials: CREDS });
    const admins = vi.fn().mockResolvedValue(ROWS);
    const user = await openAdmins(fakeApi({ admins, createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.type(screen.getByLabelText("Full name"), "  New Person ");
    await user.click(screen.getByRole("radio", { name: /^Accounting/ }));
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(createAdmin).toHaveBeenCalledWith("New Person", "accounting");
    expect(await screen.findByTestId("access-id")).toHaveTextContent("KQ7M2XW9TBDV");
    expect(screen.getByTestId("access-token")).not.toHaveTextContent(CREDS.access_token);   // masked on screen
    expect(screen.getByText(/only time/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download credentials" })).toBeInTheDocument();
  });

  it("makes the creator confirm they saved the credentials, then removes them from the screen", async () => {
    const createAdmin = vi.fn().mockResolvedValue({ admin: { id: "a2", access_id: CREDS.access_id, name: "New Person" }, credentials: CREDS });
    const user = await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.type(screen.getByLabelText("Full name"), "New Person");
    await user.click(screen.getByRole("radio", { name: /^Tags/ }));
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    await screen.findByTestId("access-token");
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await user.click(screen.getByLabelText("I have saved these credentials"));
    await user.click(done);
    expect(screen.queryByTestId("access-token")).toBeNull();
    expect(screen.queryByText(CREDS.access_token)).toBeNull();
    expect(screen.getByRole("button", { name: "Create admin" })).toBeInTheDocument();
  });

  it("downloads a file containing the credentials", async () => {
    const createAdmin = vi.fn().mockResolvedValue({ admin: { id: "a2", access_id: CREDS.access_id, name: "New Person" }, credentials: CREDS });
    let blobText = "";
    Object.assign(URL, { createObjectURL: (b: Blob) => { void b.text().then((t) => (blobText = t)); return "blob:y"; }, revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.type(screen.getByLabelText("Full name"), "New Person");
    await user.click(screen.getByRole("radio", { name: /^Tags/ }));
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    await user.click(await screen.findByRole("button", { name: "Download credentials" }));
    expect(click).toHaveBeenCalled();
    await waitFor(() => expect(blobText).toContain(CREDS.access_token));
    expect(blobText).toContain(`Access ID:     ${CREDS.access_id}`);
    expect(blobText).toContain("Name:          New Person");
    expect(await screen.findByText(/Downloaded/)).toBeInTheDocument();
  });

  it("asks for a name and reports a failure", async () => {
    const createAdmin = vi.fn().mockRejectedValue(new ApiError(500, "boom"));
    const user = await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the person's name.");
    await user.type(screen.getByLabelText("Full name"), "X");
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a role.");
    expect(createAdmin).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /^Sales/ }));
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create the admin");
  });

  it("returns to sign-in if the session ended while creating", async () => {
    const createAdmin = vi.fn().mockRejectedValue(new ApiError(401, "unauthorized"));
    const user = await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.type(screen.getByLabelText("Full name"), "X");
    await user.click(screen.getByRole("radio", { name: /^Sales/ }));
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("merchants, users and transactions", () => {
  async function go(api: Api, page: string) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: page }));
    return user;
  }
  const M = { id: "m1", name: "Cafe Nero", handle: "nero", status: "active", created_at: "2026-10-01T00:00:00Z", balance: 12500, terminals: 2, payments: 40, volume: 98000 };
  const U = { id: "u1", name: "Ada Lovelace", handle: "ada01", email: "ada@example.com", status: "active", created_at: "2026-10-02T00:00:00Z", balance: 9200, wallets: 2, agents: 1 };

  it("centres the navigation: Overview, Merchants, Users, Tags, Admins, Transactions; the name (Security) and Sign Out stay on the right", async () => {
    await signIn(fakeApi());
    await screen.findByRole("article", { name: "Scheme balance" });
    expect(within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Merchants", "Users", "Tags", "Admins", "Transactions"]);
    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
  });

  it("lists merchants and filters them by name as you type", async () => {
    const merchants = vi.fn().mockResolvedValue([M]);
    const user = await go(fakeApi({ merchants }), "Merchants");
    expect(window.location.pathname).toBe("/merchants");
    const row = await screen.findByRole("row", { name: /Cafe Nero/ });
    expect(row).toHaveTextContent("$125.00");
    expect(row).toHaveTextContent("@nero");
    await user.type(screen.getByLabelText("Filter merchants by name"), "caf");
    await waitFor(() => expect(merchants).toHaveBeenLastCalledWith("caf"));
    merchants.mockResolvedValueOnce([]);
    await user.type(screen.getByLabelText("Filter merchants by name"), "x");
    expect(await screen.findByText("No merchants match that name.")).toBeInTheDocument();
  });

  it("lists users with their balance, wallets and agents, and filters by name", async () => {
    const users = vi.fn().mockResolvedValue([U]);
    const user = await go(fakeApi({ users }), "Users");
    const row = await screen.findByRole("row", { name: /Ada Lovelace/ });
    expect(row).toHaveTextContent("ada@example.com");
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toContain("$92.00");
    await user.type(screen.getByLabelText("Filter users by name"), "ada");
    await waitFor(() => expect(users).toHaveBeenLastCalledWith("ada"));
  });

  it("shows transactions with ALL selected by default and a card per filter with its count", async () => {
    const transactions = vi.fn().mockImplementation(async (kind: string) => ({
      counts: { all: 12, sends: 5, taps: 3, funds: 2, agents: 2 }, totals: { completed_count: 9, completed_volume: 123400 },
      transactions: [{ id: "t1", type: kind === "all" ? "send" : kind, status: "completed", status_code: null, amount: 500, timestamp: "2026-10-16T10:00:00Z", via: null, agent: kind === "agents", from: "Ada Lovelace", from_wallet: "Agent Smith", to: "Bob Builder", to_wallet: "Bob Builder" }],
      next_cursor: null,
    }));
    const user = await go(fakeApi({ transactions }), "Transactions");
    expect(window.location.pathname).toBe("/transactions");
    const group = await screen.findByRole("radiogroup", { name: "Show" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["all", "sends", "taps", "funds", "agents"]);
    expect(within(group).getByRole("radio", { name: /^All/ })).toBeChecked();
    expect(transactions).toHaveBeenCalledWith("all", undefined, {});
    await screen.findByRole("row", { name: /Ada Lovelace/ });
    expect(group).toHaveTextContent("12");
    await user.click(within(group).getByRole("radio", { name: /^Agents/ }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("agents", undefined, {}));
    expect(await screen.findByText("agent")).toBeInTheDocument();
  });

  it("the full list tints failed rows and keeps the reason out of the row", async () => {
    const transactions = vi.fn().mockResolvedValue({ counts: { all: 2, sends: 2, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: 1, completed_volume: 100 },
      transactions: [
        { id: "ok", type: "send", status: "completed", status_code: null, amount: 100, timestamp: "2026-10-16T10:00:00Z", via: null, agent: false, from: "Ada", from_wallet: "Ada", to: "Bob", to_wallet: "Bob", from_party: null, to_party: null },
        { id: "bad", type: "send", status: "failed", status_code: "wallet_balance_exceeded", amount: 500, timestamp: "2026-10-16T09:00:00Z", via: null, agent: true, from: "Eve", from_wallet: "Agent", to: "Bob", to_wallet: "Bob", from_party: null, to_party: null },
      ], next_cursor: null });
    await go(fakeApi({ transactions }), "Transactions");
    const bad = await screen.findByRole("row", { name: /Eve/ });
    expect(bad).toHaveClass("fail-row");
    expect(within(bad).queryByText("wallet_balance_exceeded")).toBeNull();
    expect(screen.getByRole("row", { name: /Ada/ })).not.toHaveClass("fail-row");
  });

  it("opens a row to show the transaction id, status and reason, and sender > receiver with photos loaded only then", async () => {
    const photo = "https://img.example/ada.png";
    const transactions = vi.fn().mockResolvedValue({ counts: { all: 2, sends: 0, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: 0, completed_volume: 0 },
      transactions: [
        { id: "tx-1", type: "refund", status: "pending", status_code: "awaiting_approval", amount: 400, timestamp: "2026-10-16T09:00:00Z", via: null, agent: false, from: "Harbor Pizza", from_wallet: null, to: "Hana Silva", to_wallet: "Hana Silva",
          from_party: { id: "0190aaaa-0000-7000-8000-000000000001", kind: "merchant", photo: null }, to_party: { id: "0190aaaa-0000-7000-8000-000000000002", kind: "user", photo } },
        { id: "tx-2", type: "purchase", status: "completed", status_code: null, amount: 100, timestamp: "2026-10-16T08:00:00Z", via: null, agent: false, from: "Ada", from_wallet: "Ada", to: "Nuclear store", to_wallet: null,
          from_party: { id: "0190aaaa-0000-7000-8000-000000000003", kind: "user", photo: null }, to_party: null },
      ], next_cursor: null });
    const merchant = vi.fn().mockResolvedValue(undefined);
    const user = await go(fakeApi({ transactions, merchant }), "Transactions");
    const row = await screen.findByRole("row", { name: /Harbor Pizza/ });
    expect(document.querySelector("img")).toBeNull();                       // nothing loads before a row is opened
    expect(row).toHaveAttribute("aria-expanded", "false");
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("tx-1")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    expect(screen.getByText("awaiting_approval")).toBeInTheDocument();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    expect(document.querySelectorAll("img").length).toBe(1);                // the sender has no photo: initials
    expect(screen.getByRole("link", { name: "Hana Silva" })).toHaveAttribute("href", "/users/0190aaaa-0000-7000-8000-000000000002");
    await user.click(screen.getByRole("link", { name: "Harbor Pizza" }));
    expect(window.location.pathname).toBe("/merchants/0190aaaa-0000-7000-8000-000000000001");
  });

  it("loads more transactions with the cursor", async () => {
    const t = (id: string) => ({ id, type: "send", status: "completed", status_code: null, amount: 100, timestamp: "2026-10-16T10:00:00Z", via: null, agent: false, from: "Ada", from_wallet: "Ada", to: "Bob", to_wallet: "Bob" });
    const transactions = vi.fn()
      .mockResolvedValueOnce({ counts: { all: 2, sends: 2, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: 2, completed_volume: 200 }, transactions: [t("a")], next_cursor: "c1" })
      .mockResolvedValueOnce({ counts: { all: 2, sends: 2, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: 2, completed_volume: 200 }, transactions: [t("b")], next_cursor: null });
    const user = await go(fakeApi({ transactions }), "Transactions");
    await screen.findAllByRole("row");
    await user.click(await screen.findByRole("button", { name: "Load More" }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", "c1", {}));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));   // header + two
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
  });

  it("shows the Agents row under Tapped in the payments table", async () => {
    await signIn(fakeApi());
    const row = await screen.findByRole("row", { name: /Agents/ });
    expect(row).toHaveTextContent("25");
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.findIndex((x) => x.startsWith("Agents"))).toBe(rows.findIndex((x) => x.startsWith("Tapped")) + 1);
  });
});

describe("page titles", () => {
  const title = () => document.title;
  async function nav(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(within(screen.getByRole("navigation")).getByRole("link", { name }));
  }

  it("titles the sign-in and two-step pages", async () => {
    render(<App makeApi={() => fakeApi()} signIn={vi.fn().mockResolvedValue(CHALLENGE)} completeMfa={vi.fn()} />);
    await screen.findByLabelText("Access ID");
    expect(title()).toBe("Sign In · Nuclear Admin");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Access ID"), "JANEDOE00001");
    await user.type(screen.getByLabelText("Access Token"), "x".repeat(32));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Two-step verification" });
    expect(title()).toBe("Two-Step Verification · Nuclear Admin");
  });

  it("titles each page as you move around, and the tag page with the tag's name", async () => {
    const user = await signIn(fakeApi({ model: vi.fn().mockResolvedValue(DETAIL) } as Partial<Api>));
    await screen.findByRole("article", { name: "Scheme balance" });
    expect(title()).toBe("Overview · Nuclear Admin");
    for (const page of ["Merchants", "Users", "Tags", "Admins", "Transactions"]) {
      await nav(user, page);
      expect(title()).toBe(`${page} · Nuclear Admin`);
    }
    await nav(user, "Tags");
    await user.click(await screen.findByRole("link", { name: /NEO Band Lite/ }));
    await screen.findByRole("group", { name: "Sales Ranking" });
    await waitFor(() => expect(title()).toBe("NEO Band Lite · Tags · Nuclear Admin"));
    await user.click(screen.getByRole("link", { name: "Jane Doe" }));
    expect(title()).toBe("Security · Nuclear Admin");
  });

  it("titles the two-step enrollment page", async () => {
    await signIn(fakeApi(), vi.fn().mockResolvedValue({ ...SIGNED, mfa_enabled: false }));
    await screen.findByRole("heading", { name: "Set up two-step verification" });
    expect(title()).toBe("Set Up Two-Step Verification · Nuclear Admin");
  });
});

describe("roles", () => {
  const as = (role: SignedIn["role"], pages: Page[]): SignedIn => ({ ...SIGNED, admin: { ...SIGNED.admin, role }, role, pages, landing: pages[0]! });
  const ROLES_TABLE: [SignedIn["role"], Page[], string, string[]][] = [
    ["accounting", ["overview", "transactions"], "/", ["Overview", "Transactions"]],
    ["sales", ["users", "merchants", "tags"], "/users", ["Merchants", "Users", "Tags"]],
    ["support", ["users", "transactions"], "/users", ["Users", "Transactions"]],
    ["tags", ["tags"], "/tags", ["Tags"]],
    ["merchants", ["merchants"], "/merchants", ["Merchants"]],
  ];
  const navLinks = () => within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent);

  it.each(ROLES_TABLE)("%s sees only its own pages and lands on the first one after sign-in", async (role, pages, path, links) => {
    await signIn(fakeApi(), vi.fn().mockResolvedValue(as(role, pages)));
    await waitFor(() => expect(window.location.pathname).toBe(path));
    expect(navLinks()).toEqual(links);
  });

  it("an address a role may not open sends it to its landing page (a Tags person typing /admins)", async () => {
    window.history.replaceState(null, "", "/admins");
    sessionStorage.setItem(TOKEN_KEY, "t");
    render(<App makeApi={() => fakeApi({ me: vi.fn().mockResolvedValue({ ...ME, role: "tags", pages: ["tags"], landing: "tags" }) })} signIn={vi.fn()} />);
    await screen.findByRole("heading", { name: "Tags" });
    expect(window.location.pathname).toBe("/tags");
    expect(screen.queryByRole("heading", { name: "Admins" })).toBeNull();
  });

  it("every role keeps its own Security page (the name on the right)", async () => {
    const user = await signIn(fakeApi(), vi.fn().mockResolvedValue(as("tags", ["tags"])));
    await user.click(await screen.findByRole("link", { name: "Jane Doe" }));
    expect(await screen.findByRole("heading", { name: "Security" })).toBeInTheDocument();
  });

  it("Sales can look at tags but not change them: no Add Tag card, no Provision or Edit on a tag", async () => {
    const user = await signIn(fakeApi({ model: vi.fn().mockResolvedValue({ ...MODEL, tags: 600, unassigned: 480, activated: 120, pending: 400, rank: 1, models_total: 3 }) } as Partial<Api>), vi.fn().mockResolvedValue(as("sales", ["users", "merchants", "tags"])));
    await user.click(await screen.findByRole("link", { name: "Tags" }));
    await screen.findByRole("heading", { name: "NEO Band Lite" });
    expect(screen.queryByRole("button", { name: "Add Tag" })).toBeNull();
    await user.click(screen.getByRole("link", { name: /NEO Band Lite/ }));
    await screen.findByRole("group", { name: "Sales Ranking" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Provision Tags" })).toBeNull();
    expect(screen.getByRole("group", { name: "Pending" })).toHaveTextContent("400");
  });

  it("the Tags role can change tags", async () => {
    const user = await signIn(fakeApi(), vi.fn().mockResolvedValue(as("tags", ["tags"])));
    expect(await screen.findByRole("button", { name: "Add Tag" })).toBeInTheDocument();
    void user;
  });

  const ROWS = [
    { id: "a1", access_id: "JANEDOE00001", name: "Jane Doe", role: "admin", status: "active", mfa_enabled: true, locked: false, last_login_at: null, created_at: "2026-10-14T00:00:00Z", created_by: null },
    { id: "a2", access_id: "KQ7M2XW9TBDV", name: "Sam Sales", role: "sales", status: "active", mfa_enabled: true, locked: false, last_login_at: null, created_at: "2026-10-15T00:00:00Z", created_by: "JANEDOE00001" },
  ];

  it("the Admins page changes someone's role in a modal; you cannot change your own", async () => {
    const setAdminRole = vi.fn().mockResolvedValue({ admin: { id: "a2", access_id: "KQ7M2XW9TBDV", name: "Sam Sales", role: "support" } });
    const user = await signIn(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), setAdminRole }));
    await user.click(await screen.findByRole("link", { name: "Admins" }));
    await screen.findByRole("row", { name: /^KQ7M2XW9TBDV/ });
    expect(screen.queryByRole("button", { name: "Change role for Jane Doe" })).toBeNull();         // that is you
    await user.click(screen.getByRole("button", { name: "Change role for Sam Sales" }));
    const d = within(screen.getByRole("dialog", { name: "Role for Sam Sales" }));
    expect(d.getByRole("radio", { name: /^Sales/ })).toBeChecked();
    expect(d.getByRole("button", { name: "Save Role" })).toBeDisabled();                           // nothing changed yet
    await user.click(d.getByRole("radio", { name: /^Support/ }));
    await user.click(d.getByRole("button", { name: "Save Role" }));
    await waitFor(() => expect(setAdminRole).toHaveBeenCalledWith("a2", "support"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("each role in the picker says what it can open", async () => {
    const user = await signIn(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS) }));
    await user.click(await screen.findByRole("link", { name: "Admins" }));
    const group = await screen.findByRole("radiogroup", { name: "Role" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["admin", "accounting", "sales", "support", "tags", "merchants"]);
    expect(group).toHaveTextContent("Overview and Transactions");
    expect(group).toHaveTextContent("Tags only");
  });
});

describe("transaction periods", () => {
  async function open(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Transactions" }));
    await screen.findByRole("radiogroup", { name: "Show" });
    return user;
  }
  const page = (n = 0) => ({ counts: { all: n, sends: 0, taps: 0, funds: 0, agents: 0 }, totals: { completed_count: n, completed_volume: n * 1000 }, transactions: [], next_cursor: null });

  it("offers All Time (the default), Today, Yesterday, Last 7 Days, Last 30 Days, This Month, Last Month and a custom range", async () => {
    await open(fakeApi());
    const sel = screen.getByLabelText("Period") as HTMLSelectElement;
    expect(sel.value).toBe("all");
    expect(within(sel).getAllByRole("option").map((o) => o.textContent)).toEqual(["All Time", "Today", "Yesterday", "Last 7 Days", "Last 30 Days", "This Month", "Last Month", "Custom Range"]);
  });

  it("asks the API for the chosen period, shows its totals, and the cards follow", async () => {
    const transactions = vi.fn().mockResolvedValue(page(3));
    const user = await open(fakeApi({ transactions }));
    await user.selectOptions(screen.getByLabelText("Period"), "today");
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", undefined, expect.objectContaining({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })));
    const last = transactions.mock.calls.at(-1)![2];
    expect(last.from).toBe(last.to);
    const totalsLine = await screen.findByText(/completed/, { selector: ".period-totals" });
    expect(totalsLine).toHaveTextContent("3 completed · $30.00");
    await user.click(screen.getByRole("radio", { name: /^Sends/ }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("sends", undefined, last));            // the kind keeps the period
  });

  it("works out the ranges in New York dates", async () => {
    const { periodRange } = await import("./views/Transactions");
    const now = new Date("2026-03-09T03:30:00Z");                       // 23:30 on 8 March in New York (EDT started that day)
    expect(periodRange("today", { from: "", to: "" }, now)).toEqual({ from: "2026-03-08", to: "2026-03-08" });
    expect(periodRange("yesterday", { from: "", to: "" }, now)).toEqual({ from: "2026-03-07", to: "2026-03-07" });
    expect(periodRange("7d", { from: "", to: "" }, now)).toEqual({ from: "2026-03-02", to: "2026-03-08" });
    expect(periodRange("30d", { from: "", to: "" }, now)).toEqual({ from: "2026-02-07", to: "2026-03-08" });
    expect(periodRange("month", { from: "", to: "" }, now)).toEqual({ from: "2026-03-01", to: "2026-03-08" });
    expect(periodRange("last-month", { from: "", to: "" }, now)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("last-month", { from: "", to: "" }, new Date("2026-01-15T12:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodRange("all", { from: "", to: "" }, now)).toEqual({});
    expect(periodRange("custom", { from: "2026-02-01", to: "" }, now)).toEqual({ from: "2026-02-01" });
  });

  it("a custom range takes two dates, and a start after the end is flagged instead of sent", async () => {
    const transactions = vi.fn().mockResolvedValue(page(1));
    const user = await open(fakeApi({ transactions }));
    await user.selectOptions(screen.getByLabelText("Period"), "custom");
    await user.type(screen.getByLabelText("From"), "2026-10-01");
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", undefined, { from: "2026-10-01" }));
    await user.type(screen.getByLabelText("To"), "2026-10-15");
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", undefined, { from: "2026-10-01", to: "2026-10-15" }));
    const calls = transactions.mock.calls.length;
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-10-20");
    expect(await screen.findByRole("alert")).toHaveTextContent("The start date is after the end date.");
    expect(transactions.mock.calls.slice(calls).some((c) => c[2].from === "2026-10-20")).toBe(false);
  });

  it("load more keeps the period", async () => {
    const t = (id: string) => ({ id, type: "send", status: "completed", status_code: null, amount: 100, timestamp: "2026-10-16T10:00:00Z", via: null, agent: false, from: "Ada", from_wallet: "Ada", to: "Bob", to_wallet: "Bob" });
    const transactions = vi.fn().mockImplementation(async (_k: string, cursor?: string) => ({ ...page(2), transactions: [t(cursor ? "b" : "a")], next_cursor: cursor ? null : "c1" }));
    const user = await open(fakeApi({ transactions }));
    await user.selectOptions(screen.getByLabelText("Period"), "7d");
    await screen.findAllByRole("row");
    const range = transactions.mock.calls.at(-1)![2];
    await user.click(await screen.findByRole("button", { name: "Load More" }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", "c1", range));
  });
});

describe("merchant support page", () => {
  const MID = "0190bbbb-cccc-7ddd-8eee-ffffffffffff";
  const ML = { id: MID, name: "Cafe Nero", handle: "nero", status: "active", created_at: "2026-10-01T00:00:00Z", balance: 3800, terminals: 2, payments: 3, volume: 4200 };
  const DETAIL = {
    id: MID, name: "Cafe Nero", legal_name: "Nero Holdings LLC", handle: "nero", status: "active", email: "cafe@example.com", phone: "555-0100", created_at: "2026-10-01T00:00:00Z", website: "https://nero.example",
    photo: null, tier: "free", address: { line: null, city: "Springfield", state: "NY", post_code: "10001", country: "US" }, bank: { last4: "4321", status: "active" }, balance: 3800,
    stats: { payments: { count: 3, volume: 4200, today: { count: 2, volume: 3000 }, declined: 1 }, refunds: { count: 1, volume: 400 }, pending_refunds: { count: 1, volume: 700 }, customers: 2, last_payment_at: "2026-10-16T12:00:00Z", terminals: 2, staff: 1, products: 2 },
  };
  const TERMS = [
    { id: "t1", name: "Counter", allow_refunds: true, created_at: "2026-10-01T00:00:00Z", signed_in: true, orb: { uid: "AABBCC000001", model: "Orb 2", software: "1.4.2" }, payments: 2, volume: 3500, last_payment_at: "2026-10-16T12:00:00Z" },
    { id: "t2", name: "Bar", allow_refunds: false, created_at: "2026-10-02T00:00:00Z", signed_in: false, orb: null, payments: 1, volume: 700, last_payment_at: null },
  ];
  const tx = (id: string, type: string, status: string, amount: number, extra: object = {}) => ({ id, type, status, status_code: null, amount, timestamp: "2026-10-16T12:00:00Z", via: type === "pay" ? "app" : null, reference: null, terminal: "Counter", customer: "Ada", approved_by: null, refund_of: null, ...extra });
  const TXPAGE = { counts: { all: 3, payments: 2, refunds: 1, pending: 0 }, totals: { payments: { count: 2, volume: 3500 }, refunds: { count: 1, volume: 400 } }, transactions: [tx("a", "pay", "completed", 2500), tx("b", "pay", "failed", 900, { status_code: "insufficient_balance", customer: "Poor" }), tx("c", "refund", "completed", 400, { approved_by: "Sam Staff" })], next_cursor: null };
  const api = (extra: Partial<Api> = {}) => fakeApi({
    merchants: vi.fn().mockResolvedValue([ML]), merchant: vi.fn().mockResolvedValue(DETAIL), merchantTerminals: vi.fn().mockResolvedValue(TERMS),
    merchantStaff: vi.fn().mockResolvedValue([{ id: "s1", staff_account_id: "x", name: "Sam Staff", email: "sam@example.com", handle: "sam", role: "write", bank_last4: "9876", created_at: "2026-10-03T00:00:00Z" }]),
    merchantProducts: vi.fn().mockResolvedValue([{ id: "p1", name: "Latte", category: "Drinks", price: 450, discount: 50, stock: 12, active: true, status: "available", total_sold: 30, sold_today: 4 }, { id: "p2", name: "Muffin", category: null, price: 300, discount: 0, stock: null, active: false, status: "available", total_sold: 0, sold_today: 0 }]),
    merchantTransactions: vi.fn().mockResolvedValue(TXPAGE), signOutTerminal: vi.fn().mockResolvedValue(null), ...extra,
  } as Partial<Api>);
  async function open(a: Api, signed: SignedIn = SIGNED) {
    const user = await signIn(a, vi.fn().mockResolvedValue(signed));
    await user.click(await screen.findByRole("link", { name: "Merchants" }));
    await user.click(await screen.findByRole("link", { name: "Cafe Nero" }));
    await screen.findByRole("article", { name: "Balance" });
    return user;
  }
  const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

  it("opens from the list at its own address, with the numbers support needs first", async () => {
    await open(api());
    expect(window.location.pathname).toBe(`/merchants/${MID}`);
    expect(document.title).toBe("Cafe Nero · Merchants · Nuclear Admin");
    expect(within(screen.getByRole("article", { name: "Balance" })).getByText("$38.00")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Payments" })).toHaveTextContent("$42.00 lifetime");
    expect(screen.getByRole("article", { name: "Payments" })).toHaveTextContent("2 today · $30.00");
    expect(screen.getByRole("article", { name: "Refunds" })).toHaveTextContent("1 declined payments");
    expect(screen.getByRole("article", { name: "Awaiting approval" })).toHaveTextContent("$7.00 in pending refunds");
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Merchants" })).toHaveClass("active");
  });

  it("five top cards; the first is the business: a 128 x 128 photo (initials when none) with the handle and plan stacked under it", async () => {
    await open(api());
    expect(screen.getAllByRole("article")).toHaveLength(5);
    const profile = screen.getByRole("article", { name: "Profile" });
    expect(within(profile).getByRole("img", { name: "Cafe Nero, no photo" })).toHaveTextContent("CN");
    expect(profile.children[1]).toHaveTextContent("@nero");
    expect(profile.children[2]).toHaveTextContent("free");
    cleanup(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
    await open(api({ merchant: vi.fn().mockResolvedValue({ ...DETAIL, photo: "https://img.example/nero.png", handle: null, tier: "plus" }) }));
    const p2 = screen.getByRole("article", { name: "Profile" });
    const img = within(p2).getByRole("img", { name: "Cafe Nero's photo" });
    expect(img).toHaveAttribute("src", "https://img.example/nero.png");
    expect(img).toHaveAttribute("width", "128");
    expect(within(p2).getByText("No handle")).toBeInTheDocument();
  });

  it("Details shows the business, contact, address, payout bank (last four only) and IDs", async () => {
    await open(api());
    const d = screen.getByRole("tab", { name: "Details" });
    expect(d).toHaveAttribute("aria-selected", "true");
    for (const t of ["Nero Holdings LLC", "cafe@example.com", "555-0100", "Springfield, NY · 10001 · US", "https://nero.example", MID]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByText("@nero")).toHaveLength(2);                                       // the profile card and Details
    expect(screen.getByText(/•••• 4321/)).toBeInTheDocument();
  });

  it("Terminals: refund permission, session, Orb, payments, and Sign Out (with a confirm) for roles that may", async () => {
    const signOutTerminal = vi.fn().mockResolvedValue(null);
    const user = await open(api({ signOutTerminal }));
    await user.click(tab("Terminals"));
    expect(window.location.search).toBe("?tab=terminals");
    const counter = await screen.findByRole("row", { name: /^Counter/ });
    expect(within(counter).getByText("signed in")).toBeInTheDocument();
    expect(within(counter).getByText("allowed")).toBeInTheDocument();
    expect(counter).toHaveTextContent("Orb 2");
    expect(counter).toHaveTextContent("AABBCC000001 · v1.4.2");
    const bar = screen.getByRole("row", { name: /^Bar/ });
    expect(within(bar).getByText("needs approval")).toBeInTheDocument();
    expect(within(bar).getByText("None paired")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: /Sign out/ })).toBeNull();                   // already signed out
    await user.click(within(counter).getByRole("button", { name: "Sign out terminal Counter" }));
    expect(signOutTerminal).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Sign Out Terminal" })).getByRole("button", { name: "Confirm Sign Out" }));
    await waitFor(() => expect(signOutTerminal).toHaveBeenCalledWith("t1"));
  });

  it("a read-only role (Sales) can look at terminals but has no Sign Out", async () => {
    const sales: SignedIn = { ...SIGNED, admin: { ...SIGNED.admin, role: "sales" }, role: "sales", pages: ["users", "merchants", "tags"], landing: "users" };
    const user = await open(api(), sales);
    await user.click(tab("Terminals"));
    await screen.findByRole("row", { name: /^Counter/ });
    expect(screen.queryByRole("button", { name: /Sign out terminal/ })).toBeNull();
  });

  it("Staff and Products tabs", async () => {
    const user = await open(api());
    await user.click(tab("Staff"));
    const sam = await screen.findByRole("row", { name: /^Sam Staff/ });
    expect(sam).toHaveTextContent("sam@example.com");
    expect(within(sam).getByText("can approve refunds")).toBeInTheDocument();
    expect(sam).toHaveTextContent("•••• 9876");
    await user.click(tab("Products"));
    const latte = await screen.findByRole("row", { name: /^Latte/ });
    expect(latte).toHaveTextContent("Drinks");
    expect(latte).toHaveTextContent("$4.50");
    expect(within(latte).getByText("visible")).toBeInTheDocument();
    const muffin = screen.getByRole("row", { name: /^Muffin/ });
    expect(within(muffin).getByText("Not tracked")).toBeInTheDocument();
    expect(within(muffin).getByText("hidden")).toBeInTheDocument();
  });

  it("Transactions: payments and refunds with customer, terminal, status and why it failed; the cards filter; periods apply", async () => {
    const merchantTransactions = vi.fn().mockResolvedValue(TXPAGE);
    const user = await open(api({ merchantTransactions }));
    await user.click(tab("Transactions"));
    await screen.findByRole("row", { name: /Poor/ });
    expect(screen.getByRole("row", { name: /Poor/ })).not.toHaveTextContent("insufficient_balance");
    await user.click(screen.getByRole("row", { name: /Poor/ }));
    expect(screen.getByText("insufficient_balance")).toHaveClass("tx-code");
    expect(screen.getByRole("row", { name: /refund/ })).toHaveTextContent("approved by Sam Staff");
    expect(screen.getByRole("status")).toHaveTextContent("2 payments · $35.00");
    expect(merchantTransactions).toHaveBeenLastCalledWith(MID, "all", undefined, {});
    await user.click(screen.getByRole("radio", { name: /^Awaiting Approval/ }));
    await waitFor(() => expect(merchantTransactions).toHaveBeenLastCalledWith(MID, "pending", undefined, {}));
    await user.selectOptions(screen.getByLabelText("Period"), "7d");
    await waitFor(() => expect(merchantTransactions).toHaveBeenLastCalledWith(MID, "pending", undefined, expect.objectContaining({ from: expect.any(String), to: expect.any(String) })));
  });

  const PENDING = { ...TXPAGE, counts: { all: 4, payments: 2, refunds: 1, pending: 1 }, transactions: [...TXPAGE.transactions, tx("p", "refund", "pending", 700, { status_code: "awaiting_approval", customer: "Ada" })] };

  it("failed rows are tinted and show the reason code on its own line; pending refunds are light yellow without a code", async () => {
    const user = await open(api({ merchantTransactions: vi.fn().mockResolvedValue(PENDING) }));
    await user.click(tab("Transactions"));
    const failed = await screen.findByRole("row", { name: /Poor/ });
    expect(failed).toHaveClass("fail-row");
    expect(within(failed).queryByText("insufficient_balance")).toBeNull();
    expect(screen.getByRole("row", { name: /2,500|\$25\.00/ })).not.toHaveClass("fail-row");
    const pending = screen.getByRole("row", { name: /\$7\.00/ });
    expect(pending).not.toHaveClass("fail-row");
    expect(within(pending).queryByText(/Failure reason|insufficient/)).toBeNull();
    expect(within(pending).queryByText("awaiting_approval")).toBeNull();
    expect(pending).toHaveClass("refund-row");
  });

  it("a pending business shows the approval card: download the document, approve after a confirm", async () => {
    const merchantDocuments = vi.fn().mockResolvedValue([{ id: "d1", type: "business_document", created_at: "2026-10-16T09:00:00Z", file: "pdf" }]);
    const downloadMerchantDocument = vi.fn().mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
    const approveMerchant = vi.fn().mockResolvedValue({ merchant: { id: MID, status: "active" }, email: "sent" });
    const merchant = vi.fn().mockResolvedValueOnce({ ...DETAIL, status: "pending" }).mockResolvedValue(DETAIL);
    URL.createObjectURL = vi.fn().mockReturnValue("blob:x"); URL.revokeObjectURL = vi.fn();
    const user = await open(api({ merchant, merchantDocuments, downloadMerchantDocument, approveMerchant }));
    const card = await screen.findByRole("region", { name: "Business approval" });
    expect(screen.queryByRole("button", { name: "Suspend Merchant" })).toBeNull();
    await user.click(await within(card).findByRole("button", { name: "Download" }));
    expect(downloadMerchantDocument).toHaveBeenCalledWith(MID, "d1");
    await user.click(within(card).getByRole("button", { name: "Approve Business" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm Approve" }));
    expect(approveMerchant).toHaveBeenCalledWith(MID);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Business approval" })).toBeNull());
  });

  it("declining needs a reason, which goes to the API (and is emailed)", async () => {
    const merchantDocuments = vi.fn().mockResolvedValue([{ id: "d1", type: "business_document", created_at: "2026-10-16T09:00:00Z", file: "png" }]);
    const declineMerchant = vi.fn().mockResolvedValue({ merchant: { id: MID, status: "declined" }, email: "not_configured" });
    const merchant = vi.fn().mockResolvedValueOnce({ ...DETAIL, status: "pending" }).mockResolvedValue({ ...DETAIL, status: "declined" });
    const user = await open(api({ merchant, merchantDocuments, declineMerchant }));
    const card = await screen.findByRole("region", { name: "Business approval" });
    await user.click(await within(card).findByRole("button", { name: "Decline Business" }));
    const dlg = screen.getByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Confirm Decline" }));
    expect(await within(dlg).findByText(/Write the reason/)).toBeInTheDocument();
    expect(declineMerchant).not.toHaveBeenCalled();
    await user.type(within(dlg).getByLabelText("Reason"), "The document is blurry.");
    await user.click(within(dlg).getByRole("button", { name: "Confirm Decline" }));
    expect(declineMerchant).toHaveBeenCalledWith(MID, "The document is blurry.");
    expect(await screen.findByText(/Declined\. Email isn't set up yet/)).toBeInTheDocument();
  });

  it("Email Merchant opens a compose window with five templates then Custom; a template fills subject and message; {{name}} is left for the server", async () => {
    const emailMerchants = vi.fn().mockResolvedValue({ total: 1, sent: 1, failed: 0, not_configured: 0, no_address: 0, skipped: [], results: [{ id: MID, name: "Cafe Nero", email: "sent" }] });
    const user = await open(api({ emailMerchants }));
    await user.click(await screen.findByRole("button", { name: "Email Merchant" }));
    const dlg = screen.getByRole("dialog", { name: "Email Merchant" });
    expect(within(within(dlg).getByRole("radiogroup", { name: "Template" })).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["welcome", "documents", "review", "approved", "notice", "custom"]);
    expect(within(dlg).getByText("Cafe Nero")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Send Email" }));
    expect(await within(dlg).findByText("Write a subject.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("radio", { name: "Documents needed" }));
    expect((within(dlg).getByLabelText("Subject") as HTMLInputElement).value).toContain("{{name}}");
    expect((within(dlg).getByLabelText("Message") as HTMLTextAreaElement).value).toContain("upload a clear copy");
    await user.click(within(dlg).getByRole("button", { name: "Send Email" }));
    expect(emailMerchants).toHaveBeenCalledWith({ merchant_ids: [MID], subject: expect.stringContaining("{{name}}"), body: expect.stringContaining("business document") });
    expect(await screen.findByText("Cafe Nero was emailed.")).toBeInTheDocument();
  });

  it("Email Merchants (from the list) picks an audience with counts and asks to confirm before sending", async () => {
    const merchants = vi.fn().mockResolvedValue([{ ...ML, status: "active" }, { ...ML, id: "m2", name: "Bar", status: "pending" }, { ...ML, id: "m3", name: "Pub", status: "pending" }]);
    const emailMerchants = vi.fn().mockResolvedValue({ total: 2, sent: 0, failed: 0, not_configured: 2, no_address: 0, skipped: [], results: [] });
    const user = await signIn(api({ merchants, emailMerchants }), vi.fn().mockResolvedValue(SIGNED));
    await user.click(await screen.findByRole("link", { name: "Merchants" }));
    await user.click(await screen.findByRole("button", { name: "Email Merchants" }));
    const dlg = screen.getByRole("dialog", { name: "Email Merchants" });
    expect(await within(dlg).findByRole("option", { name: "Active and Pending (3)" })).toBeInTheDocument();
    await user.selectOptions(within(dlg).getByLabelText("To"), "pending");
    await user.click(within(dlg).getByRole("radio", { name: "Under review" }));
    await user.click(within(dlg).getByRole("button", { name: "Send Email" }));
    const confirm = screen.getByRole("dialog", { name: "Send to Merchants" });
    expect(confirm).toHaveTextContent("to 2 pending merchants");
    expect(emailMerchants).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Confirm Send" }));
    expect(emailMerchants).toHaveBeenCalledWith({ audience: "pending", subject: expect.any(String), body: expect.any(String) });
    expect(await screen.findByText(/Email isn't set up yet/)).toBeInTheDocument();
  });

  it("Sales cannot email merchants (no button)", async () => {
    const sales: SignedIn = { ...SIGNED, admin: { ...SIGNED.admin, role: "sales" }, role: "sales", pages: ["users", "merchants", "tags"], landing: "users" };
    const user = await signIn(api({ merchants: vi.fn().mockResolvedValue([ML]) }), vi.fn().mockResolvedValue(sales));
    await user.click(await screen.findByRole("link", { name: "Merchants" }));
    await screen.findByRole("row", { name: /Cafe Nero/ });
    expect(screen.queryByRole("button", { name: "Email Merchants" })).toBeNull();
  });

  it("an Admin approves a pending refund after a confirm; the lists and numbers refresh", async () => {
    const resolveMerchantRefund = vi.fn().mockResolvedValue({ refund: { id: "p", status: "completed", status_code: null } });
    const merchantTransactions = vi.fn().mockResolvedValue(PENDING);
    const user = await open(api({ resolveMerchantRefund, merchantTransactions }));
    await user.click(tab("Transactions"));
    await user.click(await screen.findByRole("button", { name: "Approve refund $7.00 to Ada" }));
    expect(resolveMerchantRefund).not.toHaveBeenCalled();
    const d = within(screen.getByRole("dialog", { name: "Approve Refund" }));
    expect(d.getByText(/moves from the merchant to the customer now/)).toBeInTheDocument();
    const loads = merchantTransactions.mock.calls.length;
    await user.click(d.getByRole("button", { name: "Confirm Approve" }));
    await waitFor(() => expect(resolveMerchantRefund).toHaveBeenCalledWith(MID, "p", "approve"));
    await waitFor(() => expect(merchantTransactions.mock.calls.length).toBeGreaterThan(loads));
  });

  it("an Admin can reject one, and a failed attempt is reported without closing the dialog", async () => {
    const resolveMerchantRefund = vi.fn().mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue({ refund: { id: "p", status: "failed", status_code: "rejected" } });
    const user = await open(api({ resolveMerchantRefund, merchantTransactions: vi.fn().mockResolvedValue(PENDING) }));
    await user.click(tab("Transactions"));
    await user.click(await screen.findByRole("button", { name: "Reject refund $7.00 to Ada" }));
    const d = within(screen.getByRole("dialog", { name: "Reject Refund" }));
    await user.click(d.getByRole("button", { name: "Confirm Reject" }));
    expect(await d.findByRole("alert")).toHaveTextContent("Couldn't resolve the refund");
    await user.click(d.getByRole("button", { name: "Confirm Reject" }));
    await waitFor(() => expect(resolveMerchantRefund).toHaveBeenLastCalledWith(MID, "p", "reject"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("only the Admin role gets Approve, Reject and Suspend; the Merchants role can sign terminals out but nothing else", async () => {
    const merchantsRole: SignedIn = { ...SIGNED, admin: { ...SIGNED.admin, role: "merchants" }, role: "merchants", pages: ["merchants"], landing: "merchants" };
    const user = await signIn(api({ merchantTransactions: vi.fn().mockResolvedValue(PENDING) }), vi.fn().mockResolvedValue(merchantsRole));
    await user.click(await screen.findByRole("link", { name: "Cafe Nero" }));
    await screen.findByRole("article", { name: "Balance" });
    expect(screen.queryByRole("button", { name: "Suspend Merchant" })).toBeNull();
    await user.click(tab("Transactions"));
    await screen.findByRole("row", { name: /Poor/ });
    expect(screen.queryByRole("button", { name: /Approve refund/ })).toBeNull();
    await user.click(tab("Terminals"));
    expect(await screen.findByRole("button", { name: "Sign out terminal Counter" })).toBeInTheDocument();
  });

  it("an Admin suspends a merchant after a confirm that says what stops, and can reactivate it", async () => {
    const setMerchantStatus = vi.fn().mockResolvedValue({ merchant: { id: MID, status: "suspended" } });
    const merchant = vi.fn().mockResolvedValueOnce(DETAIL).mockResolvedValue({ ...DETAIL, status: "suspended" });
    const user = await open(api({ setMerchantStatus, merchant }));
    await user.click(screen.getByRole("button", { name: "Suspend Merchant" }));
    const d = within(screen.getByRole("dialog", { name: "Suspend Merchant" }));
    expect(d.getByText(/can't take payments, its owner can't sign in and its terminals stop working/)).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Confirm Suspend" }));
    await waitFor(() => expect(setMerchantStatus).toHaveBeenCalledWith(MID, "suspended"));
    expect(await screen.findByRole("button", { name: "Reactivate Merchant" })).toBeInTheDocument();
    expect(screen.getAllByText("suspended").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Reactivate Merchant" }));
    await user.click(within(screen.getByRole("dialog", { name: "Reactivate Merchant" })).getByRole("button", { name: "Confirm Reactivate" }));
    await waitFor(() => expect(setMerchantStatus).toHaveBeenLastCalledWith(MID, "active"));
  });

  it("each tab is its own history entry (back and forward), and a link straight to a tab works", async () => {
    const user = await open(api());
    await user.click(tab("Staff"));
    await screen.findByRole("row", { name: /^Sam Staff/ });
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true"));
    act(() => { window.history.forward(); });
    await screen.findByRole("row", { name: /^Sam Staff/ });
    cleanup();
    window.history.replaceState(null, "", `/merchants/${MID}?tab=products`);
    sessionStorage.setItem(TOKEN_KEY, "t");
    render(<App makeApi={() => api()} signIn={vi.fn()} />);
    expect(await screen.findByRole("row", { name: /^Latte/ })).toBeInTheDocument();
  });

  it("Back goes to the list, and roles without the Merchants page are sent away", async () => {
    const user = await open(api());
    await user.click(document.querySelector("a.crumb")!);
    await screen.findByRole("heading", { name: "Merchants" });
    expect(window.location.pathname).toBe("/merchants");
    cleanup();
    window.history.replaceState(null, "", `/merchants/${MID}`);
    sessionStorage.setItem(TOKEN_KEY, "t");
    render(<App makeApi={() => api({ me: vi.fn().mockResolvedValue({ ...ME, role: "accounting", pages: ["overview", "transactions"], landing: "overview" }) })} signIn={vi.fn()} />);
    await screen.findByRole("article", { name: "Scheme balance" });
    expect(window.location.pathname).toBe("/");
  });
});

describe("user support page", () => {
  const UID = "0190cccc-dddd-7eee-8fff-aaaaaaaaaaaa";
  const UL = { id: UID, name: "Ada Lovelace", handle: "ada01", email: "ada@example.com", status: "active", created_at: "2026-10-01T00:00:00Z", balance: 91000, wallets: 3, agents: 1 };
  const DETAIL = {
    id: UID, name: "Ada Lovelace", handle: "ada01", email: "ada@example.com", phone: "555-0101", status: "active", tier: "free", photo: null, created_at: "2026-10-01T00:00:00Z", login_locked: null,
    balances: { balance: 91000, pending: 500, credit_limit: 0, credit_spent: 0, earmarked: 19300, shared: 71700 },
    stats: { sent: { count: 2, volume: 2200 }, received: { count: 1, volume: 400 }, payments: { count: 2, volume: 3400 }, loads: { count: 1, volume: 100000 }, failed: 2, today: 5, last_activity_at: "2026-10-16T12:00:00Z", wallets: 3, agents: 1, tags: 1, devices: 3, orders: 1 },
  };
  const WALLETS = [
    { id: "w1", name: "Ada Lovelace", type: "default", status: "active", balance: null, earmarked: false, daily_limit: null, spent_today: 0, allow_pay: true, allow_send: true, tags: 1, key: null, created_at: "2026-10-01T00:00:00Z" },
    { id: "w2", name: "Ada's Agent", type: "agent", status: "active", balance: 19300, earmarked: true, daily_limit: 5000, spent_today: 700, allow_pay: true, allow_send: true, tags: 0, key: { hint: "CSEY", last_used_at: "2026-10-16T11:00:00Z" }, created_at: "2026-10-02T00:00:00Z" },
  ];
  const utx = (id: string, type: string, status: string, amount: number, extra: object = {}) => ({ id, type, status, status_code: null, amount, timestamp: "2026-10-16T12:00:00Z", direction: "out", via: null, counterparty: "Bob", wallet: "Ada Lovelace", agent: false, reference: null, ...extra });
  const TXP = { counts: { all: 3, sends: 2, received: 1, payments: 0, loads: 0, refunds: 0 }, totals: { money_out: 1500, money_in: 400 }, transactions: [utx("a", "send", "completed", 1500), utx("b", "send", "completed", 400, { direction: "in", counterparty: "Bob" }), utx("c", "send", "failed", 100, { status_code: "send_not_allowed", wallet: "Kid" })], next_cursor: null };
  const api = (extra: Partial<Api> = {}) => fakeApi({
    users: vi.fn().mockResolvedValue([UL]), user: vi.fn().mockResolvedValue(DETAIL), userWallets: vi.fn().mockResolvedValue(WALLETS),
    userTags: vi.fn().mockResolvedValue([{ id: "t1", label: "Wrist", locked: false, transaction_limit: 5000, last_read_at: null, updated_at: "2026-10-03T00:00:00Z", model: "NEO Band", model_type: "band", wallet: "Ada Lovelace" }]),
    userDevices: vi.fn().mockResolvedValue([{ id: "d1", platform: "ios", wallet: null, created_at: "2026-10-01T00:00:00Z", last_accessed_at: "2026-10-16T10:00:00Z", session_expires_at: "2027-01-01T00:00:00Z", revoked_at: null, active: true }, { id: "d2", platform: null, wallet: "Kid", created_at: "2026-10-02T00:00:00Z", last_accessed_at: null, session_expires_at: "2027-01-01T00:00:00Z", revoked_at: "2026-10-05T00:00:00Z", active: false }]),
    userFunding: vi.fn().mockResolvedValue({ banks: [{ id: "b1", last4: "4321", status: "active", created_at: "2026-10-01T00:00:00Z" }], fundings: [{ id: "f1", amount: 100000, status: "completed", failure_code: null, last4: "4321", created_at: "2026-10-01T00:00:00Z", released_at: "2026-10-01T00:01:00Z", returned_at: null }, { id: "f2", amount: 5000, status: "failed", failure_code: "insufficient_funds", last4: "4321", created_at: "2026-10-02T00:00:00Z", released_at: null, returned_at: null }] }),
    userOrders: vi.fn().mockResolvedValue([{ id: "o1", model_name: "NEO Band", model_type: "band", quantity: 2, unit_price: 2999, total: 5998, status: "paid", shipping: { city: "London", region: "LDN", country: "GB" }, created_at: "2026-10-04T00:00:00Z" }]),
    userTransactions: vi.fn().mockResolvedValue(TXP), signOutUser: vi.fn().mockResolvedValue({ signed_out: 3 }), unlockUserLogin: vi.fn().mockResolvedValue(null),
    revokeAgentKey: vi.fn().mockResolvedValue(null), setUserStatus: vi.fn().mockResolvedValue({ user: { id: UID, status: "suspended" } }), setWalletStatus: vi.fn().mockResolvedValue({ wallet: { id: "w2", status: "suspended" } }), ...extra,
  } as Partial<Api>);
  const as = (role: SignedIn["role"], pages: Page[]): SignedIn => ({ ...SIGNED, admin: { ...SIGNED.admin, role }, role, pages, landing: pages[0]! });
  async function open(a: Api, signed: SignedIn = SIGNED) {
    const user = await signIn(a, vi.fn().mockResolvedValue(signed));
    await user.click(await screen.findByRole("link", { name: "Users" }));
    await user.click(await screen.findByRole("link", { name: "Ada Lovelace" }));
    await screen.findByRole("article", { name: "Balance" });
    return user;
  }
  const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

  it("opens from the Users list at its own address with the balance split and activity numbers", async () => {
    await open(api());
    expect(window.location.pathname).toBe(`/users/${UID}`);
    expect(document.title).toBe("Ada Lovelace · Users · Nuclear Admin");
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Users" })).toHaveClass("active");
    const bal = screen.getByRole("article", { name: "Balance" });
    expect(bal).toHaveTextContent("$910.00");
    expect(bal).toHaveTextContent("$717.00 shared · $193.00 earmarked");
    expect(screen.getByRole("article", { name: "Money out" })).toHaveTextContent("$22.00 sent · $34.00 paid");
    expect(screen.getByRole("article", { name: "Activity" })).toHaveTextContent("2 failed attempts");
    for (const t of ["ada@example.com", "555-0101", UID]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByText("@ada01")).toHaveLength(2);                                      // on the profile card and in Details
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  it("Details no longer repeats the plan (it is on the profile card) but keeps the handle", async () => {
    await open(api());
    expect(screen.queryByText("Plan", { selector: "dt" })).toBeNull();
    expect(screen.getByText("Handle", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getAllByText("@ada01")).toHaveLength(2);
  });

  it("five top cards; the first is the person: a 128 x 128 photo (initials when there is none) with the handle and plan stacked under it", async () => {
    await open(api());
    expect(screen.getAllByRole("article")).toHaveLength(5);
    const profile = screen.getByRole("article", { name: "Profile" });
    expect(within(profile).getByRole("img", { name: "Ada Lovelace, no photo" })).toHaveTextContent("AL");
    expect(within(profile).getByText("@ada01")).toBeInTheDocument();
    expect(within(profile).getByText("free")).toBeInTheDocument();
    expect(profile.firstElementChild).toHaveClass("avatar");                                      // photo first, then handle, then plan
    expect(profile.children[1]).toHaveTextContent("@ada01");
    expect(profile.children[2]).toHaveTextContent("free");
    cleanup(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
    await open(api({ user: vi.fn().mockResolvedValue({ ...DETAIL, photo: "https://img.example/ada.png", handle: null, tier: "plus" }) }));
    const p2 = screen.getByRole("article", { name: "Profile" });
    const img = within(p2).getByRole("img", { name: "Ada Lovelace's photo" });
    expect(img).toHaveAttribute("src", "https://img.example/ada.png");
    expect(img).toHaveAttribute("width", "128"); expect(img).toHaveAttribute("height", "128");
    expect(within(p2).getByText("No handle")).toBeInTheDocument();
    expect(within(p2).getByText("plus")).toBeInTheDocument();
  });

  it("Wallets: earmarked balance, limits, what each can do and the agent key hint; Revoke Key and Suspend behind confirms", async () => {
    const revokeAgentKey = vi.fn().mockResolvedValue(null), setWalletStatus = vi.fn().mockResolvedValue({ wallet: { id: "w2", status: "suspended" } });
    const user = await open(api({ revokeAgentKey, setWalletStatus }));
    await user.click(tab("Wallets"));
    expect(window.location.search).toBe("?tab=wallets");
    const agent = await screen.findByRole("row", { name: /^Ada's Agent/ });
    expect(agent).toHaveTextContent("$193.00");
    expect(agent).toHaveTextContent("$7.00 of $50.00");
    expect(agent).toHaveTextContent("pay · send");
    expect(agent).toHaveTextContent("…CSEY");
    expect(within(screen.getByRole("row", { name: /^Ada Lovelace/ })).getByText("Shared funds")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /^Ada Lovelace/ })).queryByRole("button", { name: /Suspend wallet/ })).toBeNull();     // the default wallet stays
    await user.click(within(agent).getByRole("button", { name: "Revoke agent key for Ada's Agent" }));
    await user.click(within(screen.getByRole("dialog", { name: "Revoke Agent Key" })).getByRole("button", { name: "Confirm Revoke" }));
    await waitFor(() => expect(revokeAgentKey).toHaveBeenCalledWith("w2"));
    await user.click(await screen.findByRole("button", { name: "Suspend wallet Ada's Agent" }));
    await user.click(within(screen.getByRole("dialog", { name: "Suspend Wallet" })).getByRole("button", { name: "Confirm Suspend" }));
    await waitFor(() => expect(setWalletStatus).toHaveBeenCalledWith("w2", "suspended"));
  });

  it("Transactions: in and out with signs, the wallet and counterparty, failed rows tinted with their code; cards and period", async () => {
    const userTransactions = vi.fn().mockResolvedValue(TXP);
    const user = await open(api({ userTransactions }));
    await user.click(tab("Transactions"));
    const failed = await screen.findByRole("row", { name: /Kid/ });
    expect(failed).toHaveClass("fail-row");
    expect(within(failed).queryByText("send_not_allowed")).toBeNull();
    await user.click(failed);
    expect(screen.getByText("send_not_allowed")).toHaveClass("tx-code");
    expect(screen.getByText("+$4.00")).toHaveClass("amount-in");
    expect(screen.getByText("−$15.00")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("$15.00 out · $4.00 in");
    expect(within(screen.getByRole("radiogroup", { name: "Show" })).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["all", "sends", "received", "payments", "loads", "refunds"]);
    await user.click(screen.getByRole("radio", { name: /^Received/ }));
    await waitFor(() => expect(userTransactions).toHaveBeenLastCalledWith(UID, "received", undefined, {}));
    await user.selectOptions(screen.getByLabelText("Period"), "7d");
    await waitFor(() => expect(userTransactions).toHaveBeenLastCalledWith(UID, "received", undefined, expect.objectContaining({ from: expect.any(String) })));
  });

  it("Tags, Devices, Funding and Orders tabs", async () => {
    const user = await open(api());
    await user.click(tab("Tags"));
    expect(await screen.findByRole("row", { name: /NEO Band/ })).toHaveTextContent("Wrist");
    await user.click(tab("Devices"));
    const active = await screen.findByRole("row", { name: /ios/ });
    expect(within(active).getByText("active")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Kid/ })).getByText("signed out")).toBeInTheDocument();
    await user.click(tab("Funding"));
    const bad = await screen.findByRole("row", { name: /\$50\.00/ });
    expect(bad).toHaveClass("fail-row");
    expect(within(bad).getByText("insufficient_funds")).toBeInTheDocument();
    expect(screen.getByText(/Linked banks: •••• 4321 \(active\)/)).toBeInTheDocument();
    await user.click(tab("Orders"));
    expect(await screen.findByRole("row", { name: /NEO Band/ })).toHaveTextContent("London, LDN, GB");
  });

  it("Sign Out Everywhere asks first, then signs them out; Unlock Login only shows while locked", async () => {
    const signOutUser = vi.fn().mockResolvedValue({ signed_out: 3 }), unlockUserLogin = vi.fn().mockResolvedValue(null);
    const locked = { ...DETAIL, login_locked: { retry_after: 600 } };
    const user = await open(api({ signOutUser, unlockUserLogin, user: vi.fn().mockResolvedValueOnce(locked).mockResolvedValue(DETAIL) }));
    expect(screen.getByText("login locked")).toBeInTheDocument();
    expect(screen.getByText(/Locked, retry in about 10 min/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlock Login" }));
    await user.click(within(screen.getByRole("dialog", { name: "Unlock Login" })).getByRole("button", { name: "Confirm Unlock" }));
    await waitFor(() => expect(unlockUserLogin).toHaveBeenCalledWith(UID));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unlock Login" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Sign Out Everywhere" }));
    expect(signOutUser).not.toHaveBeenCalled();
    const d = within(screen.getByRole("dialog", { name: "Sign Out Everywhere" }));
    expect(d.getByText(/all 3 active sessions/)).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Confirm Sign Out" }));
    await waitFor(() => expect(signOutUser).toHaveBeenCalledWith(UID));
  });

  it("an Admin suspends and reactivates a person, with a confirm that says what stops", async () => {
    const setUserStatus = vi.fn().mockResolvedValue({ user: { id: UID, status: "suspended" } });
    const user = await open(api({ setUserStatus, user: vi.fn().mockResolvedValueOnce(DETAIL).mockResolvedValue({ ...DETAIL, status: "suspended" }) }));
    await user.click(screen.getByRole("button", { name: "Suspend User" }));
    const d = within(screen.getByRole("dialog", { name: "Suspend User" }));
    expect(d.getByText(/Every session and agent key stops working/)).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Confirm Suspend" }));
    await waitFor(() => expect(setUserStatus).toHaveBeenCalledWith(UID, "suspended"));
    expect(await screen.findByRole("button", { name: "Reactivate User" })).toBeInTheDocument();
  });

  it("roles: Sales only looks; Support can sign out, unlock and revoke keys but not suspend; Admin can do everything", async () => {
    const locked = { ...DETAIL, login_locked: { retry_after: 60 } };
    await open(api({ user: vi.fn().mockResolvedValue(locked) }), as("sales", ["users", "merchants", "tags"]));
    for (const b of ["Sign Out Everywhere", "Unlock Login", "Suspend User"]) expect(screen.queryByRole("button", { name: b })).toBeNull();
    cleanup(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
    const user = await open(api({ user: vi.fn().mockResolvedValue(locked) }), as("support", ["users", "transactions"]));
    expect(screen.getByRole("button", { name: "Sign Out Everywhere" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock Login" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend User" })).toBeNull();
    await user.click(tab("Wallets"));
    expect(await screen.findByRole("button", { name: "Revoke agent key for Ada's Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Suspend wallet/ })).toBeNull();
  });

  it("each tab is its own history entry, a link straight to a tab works, and roles without Users are sent away", async () => {
    const user = await open(api());
    await user.click(tab("Devices"));
    await screen.findByRole("row", { name: /ios/ });
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true"));
    cleanup();
    window.history.replaceState(null, "", `/users/${UID}?tab=orders`);
    sessionStorage.setItem(TOKEN_KEY, "t");
    render(<App makeApi={() => api()} signIn={vi.fn()} />);
    expect(await screen.findByRole("row", { name: /NEO Band/ })).toBeInTheDocument();
    cleanup();
    window.history.replaceState(null, "", `/users/${UID}`);
    render(<App makeApi={() => api({ me: vi.fn().mockResolvedValue({ ...ME, role: "tags", pages: ["tags"], landing: "tags" }) })} signIn={vi.fn()} />);
    await screen.findByRole("heading", { name: "Tags" });
    expect(window.location.pathname).toBe("/tags");
  });
});

describe("shop and audit log", () => {
  const PAGES: Page[] = [...ALL_PAGES, "shop", "audit"];
  const signed: SignedIn = { ...SIGNED, pages: PAGES };
  const ITEM = { id: "i1", name: "Nuclear Tee", description: "Soft cotton", photo: null, price: 2500, currency: "USD", stock: 3, sold: 2, status: "available" as const, created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };
  const LOG = { id: "l1", actor_type: "admin" as const, actor_id: "a1", actor_label: "JANEDOE00001", action: "tag_model.created", target_type: "tag_model", target_id: "t1", target_label: "NEO Band", details: { price: 2999 }, ip: "1.2.3.4", created_at: "2026-10-16T12:00:00Z" };
  async function open(a: Api, page: string) {
    const user = await signIn(a, vi.fn().mockResolvedValue(signed));
    await user.click(await screen.findByRole("link", { name: page }));
    return user;
  }

  it("adds Shop and Logs to the navigation when the role has them", async () => {
    await signIn(fakeApi({ shopItems: vi.fn().mockResolvedValue([]) }), vi.fn().mockResolvedValue(signed));
    await screen.findByRole("article", { name: "Scheme balance" });
    const links = within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent);
    expect(links).toContain("Shop");
    expect(links).toContain("Logs");
  });

  it("lists shop items with price, stock, sold and status, and adds an item with the price in cents", async () => {
    const shopItems = vi.fn().mockResolvedValue([ITEM]);
    const createShopItem = vi.fn().mockResolvedValue({ ...ITEM, id: "i2" });
    const user = await open(fakeApi({ shopItems, createShopItem }), "Shop");
    expect(window.location.pathname).toBe("/shop");
    const row = await screen.findByRole("row", { name: /Nuclear Tee/ });
    expect(row).toHaveTextContent("$25.00");
    expect(row).toHaveTextContent("available");
    expect(document.title).toBe("Shop · Nuclear Admin");
    await user.click(screen.getByRole("button", { name: "Add Item" }));
    await user.type(screen.getByLabelText("Name"), "Cap");
    await user.type(screen.getByLabelText("Price (USD)"), "19.99");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add Item" }));
    expect(await screen.findByText("Add an image of the item.")).toBeInTheDocument();
    expect(createShopItem).not.toHaveBeenCalled();
  });

  it("the Add Item window offers Physical Product and Digital Product cards; digital swaps Stock for a download file and uploads it after saving", async () => {
    const shopItems = vi.fn().mockResolvedValue([ITEM]);
    const createShopItem = vi.fn().mockResolvedValue({ ...ITEM, id: "d1", kind: "digital", status: "pending", stock: null, has_file: false, file_ext: null });
    const uploadShopItemFile = vi.fn().mockResolvedValue(null);
    const updateShopItem = vi.fn().mockResolvedValue({ ...ITEM, id: "d1", kind: "digital" });
    const uploadShopItemPhoto = vi.fn().mockResolvedValue(null);
    const user = await open(fakeApi({ shopItems, createShopItem, uploadShopItemFile, updateShopItem, uploadShopItemPhoto }), "Shop");
    await user.click(await screen.findByRole("button", { name: "Add Item" }));
    const dlg = screen.getByRole("dialog");
    const kinds = within(within(dlg).getByRole("radiogroup", { name: "Product Type" }));
    expect(kinds.getByText("Physical Product")).toBeInTheDocument();
    expect(kinds.getByText("Requires handling, shipping and delivery")).toBeInTheDocument();
    expect(within(dlg).queryByText("Product Type")).toBeNull();
    expect(within(dlg).queryByLabelText("Status")).toBeNull();
    expect(kinds.getByText("Digital Product")).toBeInTheDocument();
    expect(kinds.getByText("Available for download after payment")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Stock")).toBeInTheDocument();
    await user.click(kinds.getByRole("radio", { name: /Digital Product/ }));
    expect(within(dlg).queryByLabelText("Stock")).toBeNull();
    expect(within(dlg).getByLabelText("Download File")).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Name"), "Handbook");
    await user.type(within(dlg).getByLabelText("Price (USD)"), "12");
    await user.click(within(dlg).getByRole("button", { name: "Add Item" }));
    expect(await within(dlg).findByText("Add an image of the item.")).toBeInTheDocument();
    expect(createShopItem).not.toHaveBeenCalled();
  });

  it("shows the audit log newest first and filters by who", async () => {
    const logs = vi.fn().mockResolvedValue({ logs: [LOG], next_cursor: null });
    const user = await open(fakeApi({ logs }), "Logs");
    const row = await screen.findByRole("row", { name: /Tag created/ });
    expect(row).toHaveTextContent("JANEDOE00001");
    expect(row).toHaveTextContent("NEO Band");
    expect(row).toHaveTextContent("price: 2999");
    await user.selectOptions(screen.getByLabelText("Who"), "customer");
    await waitFor(() => expect(logs).toHaveBeenLastCalledWith({ who: "customer" }, undefined));
  });

  it("shows an Activity tab on a user", async () => {
    const UID = "0190cccc-dddd-7eee-8fff-aaaaaaaaaaaa";
    const userActivity = vi.fn().mockResolvedValue({ logs: [{ ...LOG, actor_type: "customer", action: "customer.login", actor_label: "ada@example.com" }], next_cursor: null });
    const a = fakeApi({
      users: vi.fn().mockResolvedValue([{ id: UID, name: "Ada Lovelace", handle: "ada01", email: "ada@example.com", status: "active", created_at: "2026-10-01T00:00:00Z", balance: 0, wallets: 1, agents: 0 }]),
      user: vi.fn().mockResolvedValue({
        id: UID, name: "Ada Lovelace", handle: "ada01", email: "ada@example.com", phone: null, status: "active", tier: "free", photo: null, created_at: "2026-10-01T00:00:00Z", login_locked: null,
        balances: { balance: 0, pending: 0, credit_limit: 0, credit_spent: 0, earmarked: 0, shared: 0 },
        stats: { sent: { count: 0, volume: 0 }, received: { count: 0, volume: 0 }, payments: { count: 0, volume: 0 }, loads: { count: 0, volume: 0 }, failed: 0, today: 0, last_activity_at: null, wallets: 1, agents: 0, tags: 0, devices: 0, orders: 0 },
      } as any),
      userActivity,
    });
    const user = await open(a, "Users");
    await user.click(await screen.findByRole("link", { name: "Ada Lovelace" }));
    await user.click(await screen.findByRole("tab", { name: /^Activity/ }));
    expect(await screen.findByRole("row", { name: /Customer login/ })).toBeInTheDocument();
    expect(userActivity).toHaveBeenCalledWith(UID, undefined);
  });
});

describe("organizations", () => {
  const OID = "0190dddd-eeee-7fff-8aaa-bbbbbbbbbbbb";
  const ROW = { id: OID, name: "Acme Corp", email: "hr@acme.test", status: "active", created_at: "2026-10-01T00:00:00Z", email_verified: true, balance: 100000, mode: "fixed" as const, chosen: true, employees: 3, claimed: 1, held: 7500, runs: 2 };
  const DETAIL = {
    id: OID, name: "Acme Corp", legal_name: "Acme Corporation Inc", handle: "acme", status: "active", email: "hr@acme.test", email_verified: false, phone: null,
    created_at: "2026-10-01T00:00:00Z", website: "https://acme.test", photo: null, bio: null,
    address: { line: "1 Main St", city: "Brooklyn", state: "NY", post_code: "11201", country: "US" }, balance: 100000,
    program: { mode: "fixed" as const, chosen: true, cadence: "monthly" as const, day_of_month: 15, weekday: null, next_run_date: "2026-11-15", fixed_total: 16000 },
    employees: { total: 3, claimed: 1, unclaimed: 2, removed: 1, held: 7500 }, runs: { count: 2, credited: 20000, last_run_at: "2026-10-18T10:00:00Z" },
    api_key: { hint: "AB12", created_at: "2026-10-05T00:00:00Z", last_used_at: null }, documents: 1,
  };
  const EMPLOYEES = [
    { id: "e1", employee_id: "E001", name: "Eve One", email: "eve@example.com", status: "active" as const, claimed: false, balance: 5000, fixed_benefit: 5000, reminded_at: null, created_at: "2026-10-02T00:00:00Z" },
    { id: "e2", employee_id: "E002", name: "Sam Two", email: "sam@example.com", status: "removed" as const, claimed: true, balance: 0, fixed_benefit: null, reminded_at: null, created_at: "2026-10-02T00:00:00Z" },
  ];
  const RUNS = [{ id: "r1", source: "schedule" as const, run_date: "2026-10-15", status: "missed" as const, row_count: 3, total: 16000, sent: 0, held: 0, failure_code: "insufficient_balance", created_at: "2026-10-15T09:00:00Z" }];
  const api = (extra: Partial<Api> = {}) => fakeApi({
    organizations: vi.fn().mockResolvedValue([ROW]), organization: vi.fn().mockResolvedValue(DETAIL),
    organizationEmployees: vi.fn().mockResolvedValue(EMPLOYEES), organizationRuns: vi.fn().mockResolvedValue(RUNS),
    organizationDocuments: vi.fn().mockResolvedValue([{ id: "d1", type: "business_document", created_at: "2026-10-03T00:00:00Z", file: "pdf" }]),
    downloadOrganizationDocument: vi.fn().mockResolvedValue(new Blob(["x"])),
    setOrganizationStatus: vi.fn().mockResolvedValue({ organization: { id: OID, status: "suspended" } }),
    organizationActivity: vi.fn().mockResolvedValue({ logs: [], next_cursor: null }), ...extra,
  } as Partial<Api>);
  const PAGES: Page[] = ["overview", "merchants", "organizations", "users", "tags", "admins", "transactions"];
  async function open(a: Api, signed: SignedIn = { ...SIGNED, pages: PAGES }) {
    const user = await signIn(a, vi.fn().mockResolvedValue(signed));
    await user.click(await screen.findByRole("link", { name: "Organizations" }));
    await user.click(await screen.findByRole("link", { name: "Acme Corp" }));
    await screen.findByRole("article", { name: "Wallet" });
    return user;
  }
  const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

  it("lists organizations and opens one at its own address with the numbers first", async () => {
    await open(api());
    expect(window.location.pathname).toBe(`/organizations/${OID}`);
    expect(document.title).toBe("Acme Corp · Organizations · Nuclear Admin");
    expect(within(screen.getByRole("article", { name: "Wallet" })).getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Employees" })).toHaveTextContent("1 claimed · 2 not yet");
    expect(screen.getByRole("article", { name: "Employees" })).toHaveTextContent("1 removed");
    expect(screen.getByRole("article", { name: "Held for employees" })).toHaveTextContent("$75.00");
    expect(screen.getByRole("article", { name: "Benefit runs" })).toHaveTextContent("$200.00 credited");
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Organizations" })).toHaveClass("active");
  });

  it("the list shows wallet, program, people and money held", async () => {
    const user = await signIn(api(), vi.fn().mockResolvedValue({ ...SIGNED, pages: PAGES }));
    await user.click(await screen.findByRole("link", { name: "Organizations" }));
    const row = await screen.findByRole("row", { name: /Acme Corp/ });
    expect(row).toHaveTextContent("hr@acme.test");
    expect(row).toHaveTextContent("fixed");
    expect(row).toHaveTextContent("$1,000.00");
    expect(row).toHaveTextContent("$75.00");
  });

  it("Details: contact with the verified state, the schedule in words, the API key's last four and IDs", async () => {
    await open(api());
    expect(screen.getByText("not verified")).toBeInTheDocument();
    expect(screen.getByText(/Fixed: monthly on day 15/)).toBeInTheDocument();
    expect(screen.getByText("Acme Corporation Inc")).toBeInTheDocument();
    expect(screen.getByText(/•••• AB12/)).toBeInTheDocument();
    expect(screen.getByText(OID)).toBeInTheDocument();
  });

  it("Employees and Benefit Runs tabs show what support needs", async () => {
    const a = api();
    const user = await open(a);
    await user.click(tab("Employees"));
    const eve = await screen.findByRole("row", { name: /Eve One/ });
    expect(eve).toHaveTextContent("unclaimed");
    expect(eve).toHaveTextContent("$50.00");
    expect(screen.getByRole("row", { name: /Sam Two/ })).toHaveTextContent("removed");
    await user.type(screen.getByLabelText("Filter employees"), "eve");
    await waitFor(() => expect(a.organizationEmployees).toHaveBeenLastCalledWith(OID, "eve"));
    await user.click(tab("Benefit Runs"));
    const run = await screen.findByRole("row", { name: /Schedule/ });
    expect(run).toHaveTextContent("missed");
    expect(run).toHaveTextContent("insufficient balance");
  });

  it("Documents: lists the files and downloads one", async () => {
    const a = api();
    URL.createObjectURL = vi.fn().mockReturnValue("blob:x"); URL.revokeObjectURL = vi.fn();
    const user = await open(a);
    await user.click(tab("Documents"));
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(a.downloadOrganizationDocument).toHaveBeenCalledWith(OID, "d1"));
  });

  it("an admin suspends an organization behind a confirmation", async () => {
    const a = api();
    const user = await open(a);
    await user.click(screen.getByRole("button", { name: "Suspend Organization" }));
    const dialog = screen.getByRole("dialog", { name: "Suspend Organization" });
    expect(dialog).toHaveTextContent("Benefits API key stops working");
    await user.click(within(dialog).getByRole("button", { name: "Confirm Suspend" }));
    await waitFor(() => expect(a.setOrganizationStatus).toHaveBeenCalledWith(OID, "suspended"));
  });

  it("support can look but not suspend, and a role without the page never sees it", async () => {
    const support: SignedIn = { ...SIGNED, role: "support", pages: ["users", "organizations", "transactions"], landing: "users" };
    await open(api(), support);
    expect(screen.queryByRole("button", { name: "Suspend Organization" })).not.toBeInTheDocument();
    cleanup(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
    const accounting: SignedIn = { ...SIGNED, role: "accounting", pages: ["overview", "transactions"], landing: "overview" };
    await signIn(api(), vi.fn().mockResolvedValue(accounting));
    expect(screen.queryByRole("link", { name: "Organizations" })).not.toBeInTheDocument();
  });
});
