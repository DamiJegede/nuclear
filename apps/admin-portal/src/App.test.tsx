import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { ApiError, type AdminMe, type Api, type MfaChallenge, type SignedIn, type Stats, type TagModel } from "./api";
import { groupSecret } from "./views/Mfa";

vi.mock("./image", () => ({ PHOTO_SIZE: 256, resizePhoto: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })) }));

const v = (count: number, volume: number) => ({ count, volume });

const STATS: Stats = {
  as_of: new Date().toISOString(),
  scheme: { balance: 15000, consumer_balance: 12100, merchant_balance: 2900, merchant_debt: 0, pending: 900, credit_outstanding: 400, credit_limit: 1000 },
  reconciliation: { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true },
  users: { total: 1234, active: 1200, suspended: 30, closed: 4, new_7d: 56, new_30d: 200 },
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

const SIGNED: SignedIn = {
  session_token: "session-abc", expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
  admin: { access_id: "JANE.DOE", name: "Jane Doe" }, mfa_enabled: true,
};
const ME: AdminMe = { access_id: "JANE.DOE", name: "Jane Doe", mfa_enabled: true };
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
    transactions: vi.fn().mockResolvedValue({ counts: { all: 0, sends: 0, taps: 0, funds: 0, agents: 0 }, transactions: [], next_cursor: null }),
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

const TOKEN_KEY = "nuclear.admin.session";

async function signIn(api: Api, signInFn = vi.fn().mockResolvedValue(SIGNED), completeMfa = vi.fn()) {
  const user = userEvent.setup();
  render(<App makeApi={() => api} signIn={signInFn} completeMfa={completeMfa} />);
  await user.type(screen.getByLabelText("Access ID"), "JANE.DOE");
  await user.type(screen.getByLabelText("Access Token"), "correct horse battery");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("sign-in", () => {
  it("asks for an Access ID and an Access Token, and enables the button only when both are filled", async () => {
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Access ID")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("autocomplete", "current-password");
    const btn = screen.getByRole("button", { name: "Continue" });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText("Access ID"), "JANE.DOE");
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText("Access Token"), "x");
    expect(btn).toBeEnabled();
  });

  it("does not offer an operator-token sign-in any more", () => {
    render(<App makeApi={() => fakeApi()} signIn={vi.fn()} />);
    expect(screen.queryByLabelText(/operator/i)).toBeNull();
    expect(screen.getByLabelText("Access Token")).toBeInTheDocument();
  });

  it("sends the Access ID trimmed and in uppercase, and the Access Token exactly as typed", async () => {
    const signInFn = vi.fn().mockResolvedValue(SIGNED);
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={signInFn} />);
    await user.type(screen.getByLabelText("Access ID"), "  Jane.Doe ");
    await user.type(screen.getByLabelText("Access Token"), " pass word ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(signInFn).toHaveBeenCalledWith("JANE.DOE", " pass word ");
  });

  it("gives one message for any credential failure, keeps the Access ID and clears the Access Token", async () => {
    const signInFn = vi.fn().mockRejectedValue(new ApiError(401, "invalid_credentials"));
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={signInFn} />);
    await user.type(screen.getByLabelText("Access ID"), "JANE.DOE");
    await user.type(screen.getByLabelText("Access Token"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access ID or Access Token is incorrect.");
    expect(screen.getByLabelText("Access ID")).toHaveValue("JANE.DOE");
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
    await user.type(screen.getByLabelText("Access ID"), "a");
    await user.type(screen.getByLabelText("Access Token"), "b");
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
      reconciliation: { balances_match_ledger: false, balance_difference: 700, credit_matches_ledger: false, credit_difference: -500, ledger_balanced: false, earmarks_within_balances: true },
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
    await user.type(screen.getByLabelText("Price (USD)"), "10");
    await user.type(screen.getByLabelText("Quantity"), "-3");
    await user.click(d.getByRole("button", { name: "Add Tag" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quantity must be a whole number.");
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
    expect(screen.getByLabelText("Access ID")).toHaveValue("JANE.DOE");
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
    { id: "a1", access_id: "NLINF8Q0KAZ4", name: "Nuclear Admin", status: "active", mfa_enabled: true, locked: false, last_login_at: "2026-10-15T20:00:00Z", created_at: "2026-10-14T00:00:00Z", created_by: null },
    { id: "a2", access_id: "KQ7M2XW9TBDV", name: "New Person", status: "active", mfa_enabled: false, locked: false, last_login_at: null, created_at: "2026-10-15T00:00:00Z", created_by: "NLINF8Q0KAZ4" },
  ];
  const CREDS = { access_id: "KQ7M2XW9TBDV", access_token: "Zk9-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+" };

  async function openAdmins(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("link", { name: "Admins" }));
    return user;
  }

  it("lists admins with status, two-step, last sign-in and who added them", async () => {
    await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS) }));
    const first = await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    expect(within(first).getByText("Nuclear Admin")).toBeInTheDocument();
    expect(within(first).getByText("On")).toBeInTheDocument();
    expect(within(first).getByText("Operator")).toBeInTheDocument();
    const second = screen.getByRole("row", { name: /^KQ7M2XW9TBDV/ });
    expect(within(second).getByText("Not set up")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(createAdmin).toHaveBeenCalledWith("New Person");
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
    expect(createAdmin).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Full name"), "X");
    await user.click(screen.getByRole("button", { name: "Create admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create the admin");
  });

  it("returns to sign-in if the session ended while creating", async () => {
    const createAdmin = vi.fn().mockRejectedValue(new ApiError(401, "unauthorized"));
    const user = await openAdmins(fakeApi({ admins: vi.fn().mockResolvedValue(ROWS), createAdmin }));
    await screen.findByRole("row", { name: /^NLINF8Q0KAZ4/ });
    await user.type(screen.getByLabelText("Full name"), "X");
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

  it("orders the navigation Overview, Merchants, Users, Tags, Admins, with Transactions replacing Security on the right", async () => {
    await signIn(fakeApi());
    await screen.findByRole("article", { name: "Scheme balance" });
    expect(within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Merchants", "Users", "Tags", "Admins"]);
    expect(screen.getByRole("link", { name: "Transactions" })).toBeInTheDocument();
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
      counts: { all: 12, sends: 5, taps: 3, funds: 2, agents: 2 },
      transactions: [{ id: "t1", type: kind === "all" ? "send" : kind, status: "completed", status_code: null, amount: 500, timestamp: "2026-10-16T10:00:00Z", via: null, agent: kind === "agents", from: "Ada Lovelace", from_wallet: "Agent Smith", to: "Bob Builder", to_wallet: "Bob Builder" }],
      next_cursor: null,
    }));
    const user = await go(fakeApi({ transactions }), "Transactions");
    expect(window.location.pathname).toBe("/transactions");
    const group = await screen.findByRole("radiogroup", { name: "Show" });
    expect(within(group).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["all", "sends", "taps", "funds", "agents"]);
    expect(within(group).getByRole("radio", { name: /^All/ })).toBeChecked();
    expect(transactions).toHaveBeenCalledWith("all");
    await screen.findByRole("row", { name: /Ada Lovelace/ });
    expect(group).toHaveTextContent("12");
    await user.click(within(group).getByRole("radio", { name: /^Agents/ }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("agents"));
    expect(await screen.findByText("agent")).toBeInTheDocument();
  });

  it("loads more transactions with the cursor", async () => {
    const t = (id: string) => ({ id, type: "send", status: "completed", status_code: null, amount: 100, timestamp: "2026-10-16T10:00:00Z", via: null, agent: false, from: "Ada", from_wallet: "Ada", to: "Bob", to_wallet: "Bob" });
    const transactions = vi.fn()
      .mockResolvedValueOnce({ counts: { all: 2, sends: 2, taps: 0, funds: 0, agents: 0 }, transactions: [t("a")], next_cursor: "c1" })
      .mockResolvedValueOnce({ counts: { all: 2, sends: 2, taps: 0, funds: 0, agents: 0 }, transactions: [t("b")], next_cursor: null });
    const user = await go(fakeApi({ transactions }), "Transactions");
    await screen.findAllByRole("row");
    await user.click(await screen.findByRole("button", { name: "Load More" }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("all", "c1"));
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
