import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { ApiError, type AdminMe, type Api, type MfaChallenge, type SignedIn, type Stats, type TagModel } from "./api";
import { groupSecret } from "./views/Mfa";

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
    await user.click(screen.getByRole("button", { name: "Security" }));
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

describe("admins page", () => {
  const ROWS = [
    { id: "a1", access_id: "NLINF8Q0KAZ4", name: "Nuclear Admin", status: "active", mfa_enabled: true, locked: false, last_login_at: "2026-10-15T20:00:00Z", created_at: "2026-10-14T00:00:00Z", created_by: null },
    { id: "a2", access_id: "KQ7M2XW9TBDV", name: "New Person", status: "active", mfa_enabled: false, locked: false, last_login_at: null, created_at: "2026-10-15T00:00:00Z", created_by: "NLINF8Q0KAZ4" },
  ];
  const CREDS = { access_id: "KQ7M2XW9TBDV", access_token: "Zk9-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+" };

  async function openAdmins(api: Api) {
    const user = await signIn(api);
    await screen.findByRole("article", { name: "Scheme balance" });
    await user.click(screen.getByRole("button", { name: "Admins" }));
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
    expect(screen.getByTestId("access-token")).toHaveTextContent(CREDS.access_token);
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
