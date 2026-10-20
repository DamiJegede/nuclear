import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App";
import { ApiError, type Account, type Api, type Session } from "./api";
import { parseCsv, readCreditCsv } from "./csv";
import { fit } from "./format";
import { reportCsv } from "./report";
import * as token from "./token";

const SESSION: Session = { account_id: "o1", device_id: "d1", session_token: "tok-1", session_expires_at: "2027-01-01T00:00:00Z" };
const ACCOUNT: Account = { account_id: "o1", type: "O", handle: null, name: "Acme Corp", email: "hr@acme.test", phone: null, photo: null, status: "active" };
const OVERVIEW = { balance: 100000, employees: { total: 3, claimed: 1, unclaimed: 2 }, held: 7500, last_batch: { id: "b1", rows: 3, total: 10000, sent: 2500, held: 7500, created_at: "2026-10-18T10:00:00Z" } };
const BATCH = { id: "0198b2b2-0000-7000-8000-000000000002", rows: 2, total: 7500, sent: 0, held: 7500, created_at: "2026-10-19T10:00:00Z" };

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    logout: vi.fn().mockResolvedValue(null),
    account: vi.fn().mockResolvedValue(ACCOUNT),
    overview: vi.fn().mockResolvedValue(OVERVIEW),
    employees: vi.fn().mockResolvedValue([
      { id: "e1", employee_id: "E001", name: "Eve One", email: "eve@example.com", balance: 0, claimed: true, reminded_at: null, created_at: "2026-10-18T10:00:00Z" },
      { id: "e2", employee_id: "E002", name: "Sam Two", email: "sam@example.com", balance: 5000, claimed: false, reminded_at: null, created_at: "2026-10-18T10:00:00Z" },
    ]),
    batches: vi.fn().mockResolvedValue([BATCH]),
    batch: vi.fn().mockResolvedValue({
      batch: BATCH, summary: { claimed: 1, unclaimed: 1, still_held: 5000 },
      rows: [
        { employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500, mode: "held", transaction_id: "t0", claimed: true, balance: 0, reminded_at: null, removed: false },
        { employee_id: "E002", name: "=Sam Two", email: "sam@example.com", amount: 5000, mode: "held", transaction_id: "t1", claimed: false, balance: 5000, reminded_at: "2026-10-19T10:00:00Z", removed: false },
      ],
    }),
    runBatch: vi.fn().mockResolvedValue({ batch: BATCH, emails: { sent: 2, failed: 0, not_configured: 0 } }),
    profile: vi.fn().mockResolvedValue({ legal_name: "Acme Corporation Inc", display_name: "Acme Corp", tax_id_last4: "6789", address: "1 Main St", city: "Brooklyn", state: "NY", post_code: "11201", country: "US", website: "https://acme.test" }),
    saveProfile: vi.fn().mockResolvedValue({}),
    documents: vi.fn().mockResolvedValue([{ id: "d1", type: "business_document", created_at: "2026-10-19T10:00:00Z" }]),
    uploadDocument: vi.fn().mockResolvedValue({}),
    devices: vi.fn().mockResolvedValue([]),
    revokeDevice: vi.fn().mockResolvedValue(null),
    apiKey: vi.fn().mockResolvedValue(null),
    generateApiKey: vi.fn().mockResolvedValue({ key: { hint: "9xYz", name: "Default", created_at: "2026-10-20T10:00:00Z", last_used_at: null }, token: "nk_org_TESTTOKEN9xYz" }),
    revokeApiKey: vi.fn().mockResolvedValue(null),
    removeEmployee: vi.fn().mockResolvedValue(null),
    addFunds: vi.fn().mockResolvedValue({}),
    uploadPhoto: vi.fn(),
    ...over,
  } as Api;
}

async function open(api: Api, path = "/") {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  render(<App makeApi={() => api} signIn={vi.fn().mockResolvedValue(SESSION)} signUp={vi.fn().mockResolvedValue(SESSION)} />);
  await user.type(screen.getByLabelText("Email"), "HR@Acme.test");
  await user.type(screen.getByLabelText("Password"), "correct horse battery");
  await user.click(screen.getByRole("button", { name: "Sign In" }));
  return user;
}
const csvFile = (text: string) => new File([text], "credits.csv", { type: "text/csv" });

describe("csv", () => {
  it("reads quoted cells, CRLF, a BOM and dollar signs", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    const r = readCreditCsv("Email,amount,NAME,employee_id\nj@x.co,\"$1,250.50\",Jane,E1\n");
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ employee_id: "E1", name: "Jane", email: "j@x.co", amount: 125050 }]);
    expect(r.total).toBe(125050);
  });
  it("lists every problem with its line and credits nothing when there is one", () => {
    const r = readCreditCsv("employee_id,name,email,amount\nE 1,A,a@x.co,5\nE2,,b@x.co,5\nE3,C,nope,5\nE4,D,d@x.co,0\nE4,D,d@x.co,5\nE5,E,e@x.co,200000\n");
    expect(r.rows).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/Line 2.*employee_id/);
    expect(r.errors.join("\n")).toMatch(/Line 3.*name/);
    expect(r.errors.join("\n")).toMatch(/Line 4.*valid email/);
    expect(r.errors.join("\n")).toMatch(/Line 5.*valid amount/);
    expect(r.duplicates.join("\n")).toMatch(/Line 6.*employee_id E4 appears more than once/);
    expect(r.duplicates.join("\n")).toMatch(/Line 6.*d@x\.co appears more than once/);
    expect(r.errors.join("\n")).toMatch(/Line 7.*\$100,000/);
  });
  it("requires the four columns", () => {
    expect(readCreditCsv("name,email\nA,a@x.co\n").errors[0]).toMatch(/Missing: employee_id, amount/);
    expect(readCreditCsv("").errors).toEqual(["The file is empty."]);
  });
});

describe("organization portal", () => {
  it("signs in, keeps the token for this tab and shows the wallet, employees and held money", async () => {
    await open(fakeApi());
    expect(await screen.findByRole("article", { name: "Wallet" })).toHaveTextContent("$1,000.00");
    expect(screen.getByRole("article", { name: "Employees" })).toHaveTextContent("1 claimed • 2 not yet");
    expect(screen.getByRole("article", { name: "Employees" })).toHaveTextContent("$75.00");
    expect(sessionStorage.getItem("nuclear.organization.session")).toBe("tok-1");
    expect(within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Employees", "Benefits", "API"]);
  });

  it("sets a long balance in a smaller size so it stays inside its card", async () => {
    await open(fakeApi({ overview: vi.fn().mockResolvedValue({ ...OVERVIEW, balance: 100000000 }) }));
    const wallet = await screen.findByRole("article", { name: "Wallet" });
    expect(within(wallet).getByText("$1,000,000.00")).toHaveClass("x4");
    expect(fit("$75.00")).toBe("xl");
    expect(fit("$12,345.67")).toBe("x2");
    expect(fit("$1,000,000,000.00")).toBe("x5");
  });

  it("refuses a personal account with a clear message", async () => {
    await open(fakeApi({ account: vi.fn().mockResolvedValue({ ...ACCOUNT, type: "C" }) }));
    expect(await screen.findByRole("heading", { name: "This isn't an organization account" })).toBeInTheDocument();
  });

  it("adds funds with a dollar amount converted to cents", async () => {
    const api = fakeApi();
    const user = await open(api);
    await user.click(await screen.findByRole("button", { name: "Add Funds" }));
    await user.type(screen.getByLabelText("Amount (USD)"), "12a.3.4");
    const dialog = screen.getByRole("dialog", { name: "Add Funds" });
    await user.click(within(dialog).getByRole("button", { name: "Add Funds" }));
    await waitFor(() => expect(api.addFunds).toHaveBeenCalledWith(1234, expect.any(String)));
  });

  it("lists employees and filters by status", async () => {
    const api = fakeApi();
    const user = await open(api, "/employees");
    expect(await screen.findByText("Sam Two")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "unclaimed");
    await waitFor(() => expect(api.employees).toHaveBeenLastCalledWith("", "unclaimed"));
  });

  it("removes an employee after a confirmation", async () => {
    const api = fakeApi();
    const user = await open(api, "/employees");
    await screen.findByText("Eve One");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(api.removeEmployee).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Remove Employee" })).getByRole("button", { name: "Confirm Remove" }));
    await waitFor(() => expect(api.removeEmployee).toHaveBeenCalledWith("e1"));
  });

  it("explains why an employee with held money cannot be removed", async () => {
    const api = fakeApi({ removeEmployee: vi.fn().mockRejectedValue(new ApiError(409, "has_held_balance", { held: 5000 })) });
    const user = await open(api, "/employees");
    await screen.findByText("Sam Two");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    await user.click(within(screen.getByRole("dialog", { name: "Remove Employee" })).getByRole("button", { name: "Confirm Remove" }));
    expect(await screen.findByText(/need to claim it before they can be removed/)).toBeInTheDocument();
  });

  it("previews a CSV, asks for confirmation, and runs it as one batch", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\nE002,Sam Two,sam@example.com,50.00\n"));
    expect(await screen.findByRole("button", { name: "Run Batch" })).toBeEnabled();
    expect(screen.getAllByText("$75.00").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Run Batch" }));
    expect(api.runBatch).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Run Batch" })).getByRole("button", { name: "Confirm Run" }));
    expect(await screen.findByText(/Crediting 2 employees/)).toBeInTheDocument();
    const running = screen.getByRole("dialog", { name: "Running Batch" });
    expect(within(running).queryAllByRole("button")).toEqual([]);
    await waitFor(() => expect(api.runBatch).toHaveBeenCalledWith(
      [{ employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500 }, { employee_id: "E002", name: "Sam Two", email: "sam@example.com", amount: 5000 }],
      expect.any(String)));
    const report = await screen.findByRole("dialog", { name: "Batch Complete" }, { timeout: 5000 });
    expect(report).toHaveTextContent("$75.00 was credited to 2 employees");
    expect(report).not.toHaveTextContent(/email/i);
    expect(report).not.toHaveTextContent(/held/i);
    await user.click(within(report).getByRole("button", { name: "View Batch" }));
    expect(await screen.findByRole("heading", { name: "Batch" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/benefits/0198b2b2-0000-7000-8000-000000000002");
  });

  it("blocks a batch the wallet cannot cover", async () => {
    const api = fakeApi({ overview: vi.fn().mockResolvedValue({ ...OVERVIEW, balance: 1000 }) });
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    expect(await screen.findByText(/short for this file/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Batch" })).toBeDisabled();
  });

  it("shows each problem in a bad file and offers no run button", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE1,A,nope,5\n"));
    expect(await screen.findByText(/Line 2.*valid email/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Batch" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Not Ready" })).toBeInTheDocument();
  });

  it("hides the upload card and shows Ready to Run with three passed checks", async () => {
    const user = await open(fakeApi(), "/benefits");
    expect(await screen.findByRole("heading", { name: "Upload a CSV" })).toBeInTheDocument();
    await user.upload(screen.getByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    expect(await screen.findByRole("heading", { name: "Ready to Run" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Upload a CSV" })).not.toBeInTheDocument();
    const checks = within(screen.getByRole("list", { name: "Checks" })).getAllByRole("listitem");
    expect(checks.map((c) => c.textContent)).toEqual(["✓Formatting OK", "✓Sufficient Balance", "✓No Duplicate Employees"]);
    expect(screen.getByRole("button", { name: "Run Batch" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Upload a CSV" })).toBeInTheDocument();
  });

  it("fails the duplicate check when an email repeats", async () => {
    const user = await open(fakeApi(), "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE1,A,a@x.co,5\nE2,B,a@x.co,5\n"));
    expect(await screen.findByText(/a@x\.co appears more than once/)).toBeInTheDocument();
    expect(screen.getByText("No Duplicate Employees").closest("li")).toHaveClass("fail");
    expect(screen.getByRole("button", { name: "Run Batch" })).toBeDisabled();
  });

  it("explains when the server refuses because the balance changed", async () => {
    const api = fakeApi({ runBatch: vi.fn().mockRejectedValue(new ApiError(422, "insufficient_balance", { required: 7500, available: 2000 })) });
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    await user.click(await screen.findByRole("button", { name: "Run Batch" }));
    await user.click(within(screen.getByRole("dialog", { name: "Run Batch" })).getByRole("button", { name: "Confirm Run" }));
    const report = await screen.findByRole("dialog", { name: "Batch Not Run" });
    expect(report).toHaveTextContent("Your wallet has $20.00, and this file needs $75.00");
    expect(report).toHaveTextContent("Nothing was sent and nothing was charged.");
  });

  it("opens a batch on its own page and filters by claim status", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByRole("heading", { name: "Batch" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/benefits/0198b2b2-0000-7000-8000-000000000002");
    expect(api.batch).toHaveBeenCalledWith("0198b2b2-0000-7000-8000-000000000002");
    expect(await screen.findByText("Eve One")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Not claimed" })).toHaveTextContent("$50.00 still held");
    await user.click(screen.getByRole("tab", { name: "Not Claimed (1)" }));
    expect(screen.queryByText("Eve One")).not.toBeInTheDocument();
    expect(screen.getByText("=Sam Two")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Claimed (1)" }));
    expect(screen.getByText("Eve One")).toBeInTheDocument();
    expect(screen.queryByText("=Sam Two")).not.toBeInTheDocument();
  });

  it("downloads the report for the chosen view", async () => {
    const dl = vi.spyOn(token, "downloadText").mockReturnValue(true);
    const user = await open(fakeApi(), "/benefits/0198b2b2-0000-7000-8000-000000000002");
    await user.click(await screen.findByRole("tab", { name: "Not Claimed (1)" }));
    await user.click(screen.getByRole("button", { name: "Download Not Claimed Report" }));
    expect(dl).toHaveBeenCalledTimes(1);
    const [name, text] = dl.mock.calls[0]!;
    expect(name).toBe("benefit-batch-2026-10-19-not-claimed.csv");
    expect(text).toBe("employee_id,name,email,amount,credited_as,status,still_held,last_reminded\nE002,'=Sam Two,sam@example.com,50.00,held,not claimed,50.00,2026-10-19\n");
    dl.mockRestore();
  });

  it("builds the full report with quoting and every column", () => {
    const csv = reportCsv([{ employee_id: "E1", name: 'Lee, "Bo"', email: "b@x.co", amount: 12345, mode: "sent", transaction_id: "t", claimed: true, balance: 0, reminded_at: null, removed: false }]);
    expect(csv).toBe('employee_id,name,email,amount,credited_as,status,still_held,last_reminded\nE1,"Lee, ""Bo""",b@x.co,123.45,sent,claimed,0.00,\n');
  });

  it("shows the organization profile: details, documents and sessions, read-only until Edit", async () => {
    const api = fakeApi();
    const user = await open(api, "/profile");
    await screen.findByText("Document 1");
    const facts = await screen.findByLabelText("Organization details");
    expect(facts).toHaveTextContent("Acme Corporation Inc");
    expect(facts).toHaveTextContent("•••• 6789");
    expect(facts).toHaveTextContent("Brooklyn");
    expect(screen.getByRole("heading", { name: "Organization Documents" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Legal name/ })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("heading", { name: "Organization Details" }).closest(".card") as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Legal name")).toHaveValue("Acme Corporation Inc");
  });

  it("shows empty details with an Edit button when no profile has been saved yet", async () => {
    const user = await open(fakeApi({ profile: vi.fn().mockResolvedValue(null) }), "/profile");
    const facts = await screen.findByLabelText("Organization details");
    expect(facts).toHaveTextContent("Legal name—");
    await user.click(within(screen.getByRole("heading", { name: "Organization Details" }).closest(".card") as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Legal name")).toHaveValue("");
    expect(screen.getByLabelText("Country")).toHaveValue("US");
  });

  it("saves the details with a trimmed, upper-cased country and keeps the tax ID when left blank", async () => {
    const api = fakeApi();
    const user = await open(api, "/profile");
    await screen.findByLabelText("Organization details");
    await user.click(within(screen.getByRole("heading", { name: "Organization Details" }).closest(".card") as HTMLElement).getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("City")); await user.type(screen.getByLabelText("City"), "  Queens ");
    await user.click(screen.getByRole("button", { name: "Save Details" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ legal_name: "Acme Corporation Inc", city: "Queens", country: "US" })));
    expect(vi.mocked(api.saveProfile).mock.calls[0]![0]).not.toHaveProperty("tax_id");
  });

  it("uploads a document from the profile and keeps the old /credits address working", async () => {
    const api = fakeApi();
    const user = await open(api, "/profile");
    await screen.findByText("Document 1");
    await user.click(within(screen.getByRole("heading", { name: "Organization Documents" }).closest(".card") as HTMLElement).getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Upload Document" }));
    await user.upload(screen.getByLabelText("Organization document"), new File(["%PDF-1.4"], "w9.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(api.uploadDocument).toHaveBeenCalled());
  });

  it("opens the Benefits page from the old /credits address", async () => {
    await open(fakeApi(), "/credits");
    expect(await screen.findByRole("heading", { name: "Benefits" })).toBeInTheDocument();
  });

  it("generates an API key, shows it once (masked, with copy and download), then only its hint", async () => {
    const api = fakeApi();
    const user = await open(api, "/api");
    expect(await screen.findByText("No key yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate API Key" }));
    await user.click(within(screen.getByRole("dialog", { name: "Generate API Key" })).getByRole("button", { name: "Generate Key" }));
    const once = await screen.findByRole("dialog", { name: "Your API Key" });
    expect(once).toHaveTextContent("only time");
    expect(once).not.toHaveTextContent("nk_org_TESTTOKEN9xYz");               // masked
    expect(within(once).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    await user.click(within(once).getByRole("button", { name: "Reveal" }));      // the person can reveal it while it is on screen
    expect(once).toHaveTextContent("nk_org_TESTTOKEN9xYz");
    await user.click(within(once).getByRole("button", { name: "Hide" }));
    expect(once).not.toHaveTextContent("nk_org_TESTTOKEN9xYz");
    expect(within(once).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(within(once).getByRole("button", { name: "Done" })).toBeDisabled();
    await user.click(within(once).getByLabelText("I have saved it"));
    await user.click(within(once).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("nk_org_••••••••9xYz")).toBeInTheDocument();
    expect(screen.queryByText(/TESTTOKEN/)).not.toBeInTheDocument();
  });

  it("rotates and revokes only after a confirmation, and documents the three endpoints", async () => {
    const api = fakeApi({ apiKey: vi.fn().mockResolvedValue({ hint: "abcd", name: "Default", created_at: "2026-10-19T10:00:00Z", last_used_at: null }) });
    const user = await open(api, "/api");
    expect(await screen.findByText("nk_org_••••••••abcd")).toBeInTheDocument();
    expect(screen.getByText(/Use the Benefits API to grant benefits to your employees directly from/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Basics" })).toBeInTheDocument();
    const links = within(screen.getByRole("navigation", { name: "Documentation" })).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Basics", "POST /employees", "POST /employees/get", "POST /credits", "POST /employees/remove", "GET /balance", "Errors"]);
    for (const l of links) expect(document.querySelector(l.getAttribute("href")!)).not.toBeNull();    // each link jumps to a card
    expect(screen.getByText(/Keep it secret and NEVER put it in a browser or an app/)).toBeInTheDocument();
    for (const card of ["Create or update employees", "Get employees", "Credit benefits", "Remove employees", "Get balance"]) expect(document.querySelector(`[aria-label="${card}"]`)).not.toBeNull();
    expect(screen.getAllByText(/Idempotency-Key/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Revoke Key" }));
    expect(api.revokeApiKey).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Revoke API Key" })).getByRole("button", { name: "Confirm Revoke" }));
    await waitFor(() => expect(api.revokeApiKey).toHaveBeenCalled());
    expect(await screen.findByText("No key yet.")).toBeInTheDocument();
  });

  it("has no refresh button on any page", async () => {
    await open(fakeApi(), "/employees");
    await screen.findByText("Sam Two");
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("signs out when the session ends", async () => {
    await open(fakeApi({ overview: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) }));
    expect(await screen.findByText("Your session ended. Sign in again.")).toBeInTheDocument();
  });
});
