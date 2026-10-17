import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App";
import { ApiError, type Account, type Api, type Session } from "./api";

const SESSION: Session = { account_id: "a1", device_id: "d1", session_token: "tok-1", session_expires_at: "2027-01-01T00:00:00Z" };
const ACCOUNT: Account = { account_id: "a1", type: "B", handle: "nero", name: "Cafe Nero", email: "cafe@example.com", phone: null, photo: null, bio: null, tier: "free", status: "active" };
const TERMINAL = { id: "t1", name: "Counter", allow_refunds: true, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", orb: { id: "o1", uid: "AABBCC000001", model: "Orb 2", software: "1.4.2" } };
const REFUND = { id: "r1", status: "pending" as const, status_code: "awaiting_approval", amount: 700, payment_id: "p1", payment_amount: 2500, attempt: null, reference: "Order 7", payer: { display_name: "Ada" }, items: null, requested_on_terminal_id: "t1", approver_account_id: null, timestamp: "2026-10-16T09:00:00Z", completed_at: null };

const navLink = async (name: string) => within(await screen.findByRole("navigation")).getByRole("link", { name });

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    logout: vi.fn().mockResolvedValue(null),
    account: vi.fn().mockResolvedValue(ACCOUNT),
    balance: vi.fn().mockResolvedValue({ balance: 125000, earmarked: 0, balance_pending: 0, credit_limit: 0, credit_spent: 0, available_to_send: 0, available_to_pay: 0, restricted: false }),
    terminals: vi.fn().mockResolvedValue([TERMINAL]),
    refunds: vi.fn().mockResolvedValue([]),
    orbs: vi.fn().mockResolvedValue([]),
    staff: vi.fn().mockResolvedValue([]),
    documents: vi.fn().mockResolvedValue([]),
    devices: vi.fn().mockResolvedValue([]),
    overview: vi.fn().mockResolvedValue({ balance: 125000, balance_pending: 0, terminals: { count: 1, paired: 1 }, pending_refunds: { count: 0, amount: 0 }, staff: { count: 0, writers: 0 }, open_orders: 0, city: "Brooklyn", state: "NY", categories: 0, products: 0, best_seller: null, today: { transactions: 0 }, yesterday: { net: 0 } }),
    profile: vi.fn().mockResolvedValue({ legal_name: "Nero LLC", display_name: "Cafe Nero", tax_id_last4: null, address: null, city: "Brooklyn", state: "NY", post_code: null, country: "US", website: null }),
    categories: vi.fn().mockResolvedValue([]),
    products: vi.fn().mockResolvedValue([]),
    checkouts: vi.fn().mockResolvedValue([]),
    transactions: vi.fn().mockResolvedValue({ counts: { all: 0, payments: 0, refunds: 0, pending: 0 }, totals: { payments: { count: 0, volume: 0 }, refunds: { count: 0, volume: 0 } }, transactions: [], next_cursor: null }),
    ...over,
  } as Api;
}

async function signIn(api: Api, signInFn = vi.fn().mockResolvedValue(SESSION)) {
  const user = userEvent.setup();
  render(<App makeApi={() => api} signIn={signInFn} signUp={vi.fn()} />);
  await user.type(screen.getByLabelText("Email"), "Cafe@Example.com");
  await user.type(screen.getByLabelText("Password"), "correct horse battery");
  await user.click(screen.getByRole("button", { name: "Sign In" }));
  return { user, signInFn };
}

describe("sign-in", () => {
  it("signs in with a lowercase email, keeps the token only for this tab, and lands on the overview", async () => {
    const { signInFn } = await signIn(fakeApi());
    expect(signInFn).toHaveBeenCalledWith("cafe@example.com", "correct horse battery");
    expect(await screen.findByRole("article", { name: "Today" })).toHaveTextContent("$1,250.00");
    expect(sessionStorage.getItem("nuclear.merchant.session")).toBe("tok-1");
    expect(within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Transactions", "Orders", "Catalog", "Terminals", "Orbs", "Staff", "Refunds"]);
  });

  it("explains a wrong password and clears it", async () => {
    const user = userEvent.setup();
    render(<App makeApi={() => fakeApi()} signIn={vi.fn().mockRejectedValue(new ApiError(401, "invalid_credentials"))} signUp={vi.fn()} />);
    await user.type(screen.getByLabelText("Email"), "a@b.co");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByText("Email or password is incorrect.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("creates a business account: it asks for the name and a 10-character password, then shows the review page", async () => {
    const signUp = vi.fn().mockResolvedValue(SESSION);
    const api = fakeApi({ account: vi.fn().mockResolvedValue({ ...ACCOUNT, status: "pending" }) });
    const user = userEvent.setup();
    render(<App makeApi={() => api} signIn={vi.fn()} signUp={signUp} />);
    await user.click(screen.getByRole("button", { name: "Create a business account" }));
    await user.type(screen.getByLabelText("Email"), "new@biz.co");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create Account" }));
    expect(await screen.findByText("Enter your business name.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Business Name"), "New Biz");
    await user.click(screen.getByRole("button", { name: "Create Account" }));
    expect(await screen.findByText("Use a password of at least 10 characters.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "long enough password");
    await user.click(screen.getByRole("button", { name: "Create Account" }));
    expect(signUp).toHaveBeenCalledWith({ name: "New Biz", email: "new@biz.co", password: "long enough password" });
    expect(await screen.findByRole("heading", { name: "Your account is being reviewed" })).toBeInTheDocument();
  });

  it("returns to sign-in with a notice when the session ends", async () => {
    const api = fakeApi({ overview: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) });
    await signIn(api);
    expect(await screen.findByText("Your session ended. Sign in again.")).toBeInTheDocument();
  });
});

describe("review state", () => {
  it("a pending business sees only the review page and can upload a document", async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ document: { id: "d1", type: "business_document", created_at: "2026-10-16T09:00:00Z" }, status: "pending" });
    const user = userEvent.setup();
    const api = fakeApi({ account: vi.fn().mockResolvedValue({ ...ACCOUNT, status: "pending" }), uploadDocument });
    await signIn(api).then(() => undefined);
    expect(await screen.findByRole("heading", { name: "Your account is being reviewed" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    await user.upload(screen.getByLabelText("Business document"), new File(["%PDF"], "cert.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(uploadDocument).toHaveBeenCalled());
  });

  it("a declined business is told why and can upload a new document", async () => {
    const api = fakeApi({ account: vi.fn().mockResolvedValue({ ...ACCOUNT, status: "declined", decline: { reason: "The document is blurry.", at: "2026-10-16T09:00:00Z" } }) });
    await signIn(api);
    expect(await screen.findByRole("heading", { name: "We couldn't approve your account yet" })).toBeInTheDocument();
    expect(screen.getByText("The document is blurry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload New Document" })).toBeInTheDocument();
  });
});

describe("terminals", () => {
  it("lists terminals with refund permission and Orb, and adds one: the session token is shown once, masked, with Copy and Download", async () => {
    const createTerminal = vi.fn().mockResolvedValue({ terminal: { ...TERMINAL, id: "t2", name: "Bar", orb: null }, session_token: "secret-terminal-token", session_expires_at: "2026-10-17T00:00:00Z" });
    const { user } = await signIn(fakeApi({ createTerminal }));
    await user.click(await navLink("Terminals"));
    const row = await screen.findByRole("row", { name: /Counter/ });
    expect(row).toHaveTextContent("allowed");
    expect(row).toHaveTextContent("AABBCC000001");
    await user.click(screen.getByRole("button", { name: "Add Terminal" }));
    const dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getByLabelText("Name"), "Bar");
    await user.click(within(dlg).getByRole("switch", { name: "Allow refunds without approval" }));
    await user.click(within(dlg).getByRole("button", { name: "Add Terminal" }));
    expect(createTerminal).toHaveBeenCalledWith({ name: "Bar", allow_refunds: false });
    const secret = await screen.findByRole("group", { name: "Session Token" });
    expect(screen.queryByText("secret-terminal-token")).toBeNull();
    expect(within(secret).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(secret).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(within(secret).getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("signing a terminal out asks first", async () => {
    const revokeTerminal = vi.fn().mockResolvedValue(null);
    const { user } = await signIn(fakeApi({ revokeTerminal }));
    await user.click(await navLink("Terminals"));
    await user.click(await screen.findByRole("button", { name: "Sign Out", hidden: false }));
    expect(revokeTerminal).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
    expect(revokeTerminal).toHaveBeenCalledWith("t1");
  });
});

describe("refunds, staff, orbs, profile", () => {
  it("shows pending refunds on the overview and approves one after a confirm", async () => {
    const refunds = vi.fn().mockResolvedValueOnce([REFUND]).mockResolvedValueOnce([REFUND]).mockResolvedValue([]);
    const resolveRefund = vi.fn().mockResolvedValue({});
    const overview = vi.fn().mockResolvedValue({ balance: 0, balance_pending: 0, terminals: { count: 1, paired: 1 }, pending_refunds: { count: 1, amount: 700 }, staff: { count: 0, writers: 0 }, open_orders: 0, city: null, state: null, categories: 0, products: 0, best_seller: null, today: { transactions: 0 }, yesterday: { net: 0 } });
    const { user } = await signIn(fakeApi({ refunds, resolveRefund, overview }));
    expect(await screen.findByText(/1 refund \(\$7\.00\) waiting for your approval/)).toBeInTheDocument();
    await user.click(await navLink("Refunds"));
    await user.click(await screen.findByRole("button", { name: /Approve refund \$7\.00 to Ada/ }));
    expect(resolveRefund).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm Approve" }));
    expect(resolveRefund).toHaveBeenCalledWith("r1", "approve");
  });

  it("adds staff by handle: find first, then choose a role", async () => {
    const lookupHandle = vi.fn().mockResolvedValue({ account_id: "p1", handle: "sam123", type: "C", display_name: "Sam Staff", photo: null, wallet_id: "w1" });
    const addStaff = vi.fn().mockResolvedValue({ id: "s1" });
    const { user } = await signIn(fakeApi({ lookupHandle, addStaff }));
    await user.click(await navLink("Staff"));
    await user.click(await screen.findByRole("button", { name: "Add Staff" }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByRole("button", { name: "Add Staff" })).toBeDisabled();
    await user.type(within(dlg).getByLabelText("Handle"), "@sam123");
    await user.click(within(dlg).getByRole("button", { name: "Find" }));
    expect(await within(dlg).findByText(/Sam Staff/)).toBeInTheDocument();
    await user.selectOptions(within(dlg).getByLabelText("Role"), "write");
    await user.click(within(dlg).getByRole("button", { name: "Add Staff" }));
    expect(addStaff).toHaveBeenCalledWith("p1", "write");
  });

  it("releases an Orb after a confirm", async () => {
    const releaseOrb = vi.fn().mockResolvedValue(null);
    const { user } = await signIn(fakeApi({ releaseOrb, orbs: vi.fn().mockResolvedValue([{ id: "o1", uid: "AABBCC000001", model: "Orb 2", software: "1.4.2", terminal_id: "t1" }]) }));
    await user.click(await navLink("Orbs"));
    expect(await screen.findByRole("row", { name: /AABBCC000001/ })).toHaveTextContent("Counter");
    await user.click(screen.getByRole("button", { name: "Release" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm Release" }));
    expect(releaseOrb).toHaveBeenCalledWith("o1");
  });

  it("the profile is one full-width column in this order: profile, payout bank, business details, documents; the bio saves", async () => {
    const setBio = vi.fn().mockResolvedValue("We roast our own beans.");
    const { user } = await signIn(fakeApi({ setBio, bank: vi.fn().mockResolvedValue(null) }));
    await user.click(within(await screen.findByRole("banner")).getByRole("link", { name: "Cafe Nero" }));
    await screen.findByRole("form", { name: "Business details" });
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles.slice(0, 4)).toEqual(["Business", "Payout Bank", "Business Details", "Business Documents"]);
    expect(document.querySelectorAll(".two-col").length).toBe(0);
    const bio = screen.getByLabelText("Bio");
    expect(screen.getByRole("button", { name: "Save Bio" })).toBeDisabled();
    await user.type(bio, "We roast our own beans.");
    await user.click(screen.getByRole("button", { name: "Save Bio" }));
    expect(setBio).toHaveBeenCalledWith("We roast our own beans.");
  });

  it("the profile saves a handle (lowercase letters and numbers only) and the page has its own address", async () => {
    const setHandle = vi.fn().mockResolvedValue({ handle: "newname" });
    const { user } = await signIn(fakeApi({ setHandle }));
    await user.click(within(await screen.findByRole("banner")).getByRole("link", { name: "Cafe Nero" }));
    expect(window.location.pathname).toBe("/profile");
    const input = await screen.findByLabelText("Handle");
    await user.clear(input);
    await user.type(input, "New_Name!");
    expect(input).toHaveValue("newname");
    await user.click(screen.getByRole("button", { name: "Save Handle" }));
    expect(setHandle).toHaveBeenCalledWith("newname");
  });
});

const PRODUCT = { id: "pr1", category_id: "c1", name: "Latte", currency: "USD", price: 450, discount: 50, effective_price: 400, photo: null, stock: 10, active: true, status: "available" as const, total_sold: 30, sold_today: 4, created_at: "2026-10-01T00:00:00Z" };
const CATEGORY = { id: "c1", name: "Drinks", active: true, products: 1, created_at: "2026-10-01T00:00:00Z" };

describe("transactions and orders", () => {
  const tx = (id: string, type: string, status: string, amount: number, extra: object = {}) => ({ id, type, status, status_code: null, amount, timestamp: "2026-10-16T12:00:00Z", via: type === "pay" ? "app" : null, reference: null, terminal: "Counter", customer: "Ada", approved_by: null, refund_of: null, from: "Ada", to: "Cafe Nero", ...extra });
  const PAGE = { counts: { all: 3, payments: 2, refunds: 1, pending: 0 }, totals: { payments: { count: 2, volume: 3500 }, refunds: { count: 1, volume: 400 } }, transactions: [tx("a", "pay", "completed", 2500), tx("b", "pay", "failed", 900, { status_code: "insufficient_balance", customer: "Poor" }), tx("c", "refund", "completed", 400)], next_cursor: null };

  it("lists payments and refunds with cards, totals and a period; a row opens to show its id, status and reason", async () => {
    const transactions = vi.fn().mockResolvedValue(PAGE);
    const { user } = await signIn(fakeApi({ transactions }));
    await user.click(await navLink("Transactions"));
    const failed = await screen.findByRole("row", { name: /Poor/ });
    expect(failed).toHaveClass("fail-row");
    expect(failed).not.toHaveTextContent("insufficient_balance");
    expect(screen.getByRole("status")).toHaveTextContent("2 payments · $35.00");
    await user.click(failed);
    expect(screen.getByText("insufficient_balance")).toHaveClass("tx-code");
    expect(screen.getByText("b")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Refunds/ }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("refunds", undefined, {}));
    await user.selectOptions(screen.getByLabelText("Period"), "7d");
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith("refunds", undefined, expect.objectContaining({ from: expect.any(String) })));
  });

  it("orders: open ones can be cancelled after a confirm; a row shows the items", async () => {
    const checkouts = vi.fn().mockResolvedValue([{ id: "co1", status: "open", reference: "Order 9", currency: "USD", total: 1200, terminal_id: "t1", expires_at: null, created_at: "2026-10-16T09:00:00Z", items: [{ id: "i1", product_id: "pr1", name: "Latte", unit_price: 450, discount: 50, net_price: 400, quantity: 3, refunded_quantity: 0, pending_refund_quantity: 0, refundable_quantity: 3 }] }]);
    const cancelCheckout = vi.fn().mockResolvedValue({ checkout: {} });
    const { user } = await signIn(fakeApi({ checkouts, cancelCheckout }));
    await user.click(await navLink("Orders"));
    const row = await screen.findByRole("row", { name: /Order 9/ });
    expect(row).toHaveTextContent("3 items");
    await user.click(row);
    expect(screen.getByText(/3 × Latte/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel Order" }));
    expect(cancelCheckout).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm Cancel" }));
    expect(cancelCheckout).toHaveBeenCalledWith("co1");
  });
});

describe("catalog", () => {
  it("shows products with discounts and stock, filters by category and name, and adds a product (numeric-only fields, price in cents)", async () => {
    const createProduct = vi.fn().mockResolvedValue({ ...PRODUCT, id: "pr2", name: "Muffin" });
    const { user } = await signIn(fakeApi({ categories: vi.fn().mockResolvedValue([CATEGORY]), products: vi.fn().mockResolvedValue([PRODUCT, { ...PRODUCT, id: "pr3", name: "Bagel", category_id: null, discount: 0, stock: null }]), createProduct }));
    await user.click(await navLink("Catalog"));
    const row = await screen.findByRole("row", { name: /Latte/ });
    expect(row).toHaveTextContent("$4.00");
    expect(row).toHaveTextContent("Drinks");
    expect(screen.getByRole("row", { name: /Bagel/ })).toHaveTextContent("Untracked");
    await user.click(within(screen.getByRole("complementary", { name: "Categories" })).getByRole("button", { name: /^Drinks/ }));
    expect(screen.queryByRole("row", { name: /Bagel/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add Product" }));
    const dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getByLabelText("Name"), "Muffin");
    await user.type(within(dlg).getByLabelText("Price (USD)"), "3a.5x0");
    expect(within(dlg).getByLabelText("Price (USD)")).toHaveValue("3.50");
    await user.type(within(dlg).getByLabelText("Stock"), "1x2");
    expect(within(dlg).getByLabelText("Stock")).toHaveValue("12");
    await user.click(within(dlg).getByRole("button", { name: "Add Product" }));
    expect(createProduct).toHaveBeenCalledWith({ name: "Muffin", price: 350, discount: 0, category_id: "c1", stock: 12, active: true });
  });

  it("a product that was sold can't be deleted and the page says to deactivate it", async () => {
    const deleteProduct = vi.fn().mockRejectedValue(new ApiError(409, "product_in_use"));
    const { user } = await signIn(fakeApi({ categories: vi.fn().mockResolvedValue([]), products: vi.fn().mockResolvedValue([PRODUCT]), deleteProduct }));
    await user.click(await navLink("Catalog"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm Delete" }));
    expect(await screen.findByText(/Deactivate it instead/)).toBeInTheDocument();
  });
});

describe("business details and payout bank", () => {
  it("saves the details (the tax id is write-only) and the payout bank takes digits only and shows only the last four", async () => {
    const saveProfile = vi.fn().mockResolvedValue({});
    const saveBank = vi.fn().mockResolvedValue({ id: "b1", last4: "6789", status: "active", created_at: "2026-10-16T00:00:00Z" });
    const { user } = await signIn(fakeApi({
      profile: vi.fn().mockResolvedValue({ legal_name: "Nero LLC", display_name: "Cafe Nero", tax_id_last4: "6789", address: null, city: "Albany", state: null, post_code: null, country: "US", website: null }),
      bank: vi.fn().mockResolvedValue(null), saveProfile, saveBank,
    }));
    await user.click(within(await screen.findByRole("banner")).getByRole("link", { name: "Cafe Nero" }));
    const form = await screen.findByRole("form", { name: "Business details" });
    expect(within(form).getByLabelText("Legal name")).toHaveValue("Nero LLC");
    expect(within(form).getByLabelText("Tax ID")).toHaveAttribute("placeholder", expect.stringContaining("6789"));
    await user.type(within(form).getByLabelText("Website"), "nero.example");
    await user.click(within(form).getByRole("button", { name: "Save Details" }));
    expect(await within(form).findByText("The website must start with https://")).toBeInTheDocument();
    await user.clear(within(form).getByLabelText("Website"));
    await user.type(within(form).getByLabelText("Website"), "https://nero.example");
    await user.click(within(form).getByRole("button", { name: "Save Details" }));
    expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ legal_name: "Nero LLC", city: "Albany", website: "https://nero.example" }));
    expect(saveProfile.mock.calls[0]![0]).not.toHaveProperty("tax_id");
    await user.click(screen.getByRole("button", { name: "Add Bank" }));
    const dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getByLabelText("Routing number"), "11a0000000");
    await user.type(within(dlg).getByLabelText("Account number"), "00-0123456789");
    expect(within(dlg).getByLabelText("Routing number")).toHaveValue("110000000");
    await user.click(within(dlg).getByRole("button", { name: "Save Bank" }));
    expect(saveBank).toHaveBeenCalledWith({ routing_number: "110000000", account_number: "000123456789" });
  });
});

describe("overview", () => {
  const tx = (all: number, pay: number, ref: number) => ({ counts: { all, payments: all, refunds: 0, pending: 0 }, totals: { payments: { count: all, volume: pay }, refunds: { count: 0, volume: ref } }, transactions: [], next_cursor: null });

  it("has three large cards (profile, today, catalog) and four small ones, each linking to its page; all from one request", async () => {
    const overview = vi.fn().mockResolvedValue({ balance: 125000, balance_pending: 0, terminals: { count: 2, paired: 1 }, pending_refunds: { count: 0, amount: 0 }, staff: { count: 1, writers: 1 }, open_orders: 2, city: "Brooklyn", state: "NY", categories: 2, products: 3, best_seller: { name: "Latte", sold_today: 5 }, today: { transactions: 7 }, yesterday: { net: 45000 } });
    const api = fakeApi({ overview });
    const { user } = await signIn(api);
    const profile = await screen.findByRole("article", { name: "Profile" });
    expect(profile).toHaveTextContent("Cafe Nero");
    expect(profile).toHaveTextContent("@nero");
    expect(profile).toHaveTextContent("Brooklyn • NY");
    const today = screen.getByRole("article", { name: "Today" });
    expect(today).toHaveTextContent("$1,250.00");
    expect(today).toHaveTextContent("7 transactions");
    expect(today).toHaveTextContent("Yesterday");
    expect(today).toHaveTextContent("$450.00");                 // yesterday: payments less refunds
    const catalog = screen.getByRole("article", { name: "Catalog" });
    expect(catalog).toHaveTextContent("3");
    expect(catalog).toHaveTextContent("2 categories");
    expect(catalog).toHaveTextContent("Today's Best Seller");
    expect(catalog).toHaveTextContent("Latte");
    expect(overview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("article", { name: "Terminals" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "Staff" })).toHaveTextContent("1 can approve refunds");
    expect(screen.getByRole("article", { name: "Orders" })).toHaveTextContent("2");
    await user.click(within(today).getByRole("link", { name: "Today" }));
    expect(window.location.pathname).toBe("/transactions");
  });

  it("clicking the profile picture opens the crop window; saving uploads a 256 x 256 JPEG", async () => {
    const uploadPhoto = vi.fn().mockResolvedValue({ photo: "https://x/p.jpg" });
    const bmp = { width: 800, height: 600, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bmp));
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() }) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string) { cb(new Blob(["jpeg"], { type })); };
    const { user } = await signIn(fakeApi({ uploadPhoto }));
    await screen.findByRole("article", { name: "Profile" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.upload(screen.getByLabelText("Profile picture"), new File(["x"], "me.png", { type: "image/png" }));
    const dlg = await screen.findByRole("dialog", { name: "Profile Picture" });
    expect(within(dlg).getByLabelText("Zoom")).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByRole("button", { name: "Save Picture" })).toBeEnabled());
    await user.click(within(dlg).getByRole("button", { name: "Save Picture" }));
    await waitFor(() => expect(uploadPhoto).toHaveBeenCalled());
    expect((uploadPhoto.mock.calls[0]![0] as Blob).type).toBe("image/jpeg");
    vi.unstubAllGlobals();
  });

  it("refuses a file that is not an image", async () => {
    await signIn(fakeApi());
    await screen.findByRole("article", { name: "Profile" });
    const input = screen.getByLabelText("Profile picture");
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["x"], "doc.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Choose a PNG, JPEG or WebP image.")).toBeInTheDocument();
  });
});
