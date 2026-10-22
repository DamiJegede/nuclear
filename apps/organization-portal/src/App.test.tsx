import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App";
import { Login } from "./views/Login";
import { ApiError, type Account, type Api, type Program, type Session } from "./api";
import { parseCsv, readCreditCsv, readFixedCsv } from "./csv";
import { fit } from "./format";
import { reportCsv } from "./report";
import * as token from "./token";

const SESSION: Session = { account_id: "o1", device_id: "d1", session_token: "tok-1", session_expires_at: "2027-01-01T00:00:00Z" };
const ACCOUNT: Account = { account_id: "o1", type: "O", handle: null, name: "Acme Corp", email: "hr@acme.test", phone: null, photo: null, status: "active" };
const OVERVIEW = { balance: 100000, employees: { total: 3, claimed: 1, unclaimed: 2 }, held: 7500, last_run: { id: "b1", rows: 3, total: 10000, sent: 2500, held: 7500, created_at: "2026-10-18T10:00:00Z" } };
const PROGRAM_FLEX: Program = { mode: "flexible", chosen: true, cadence: null, day_of_month: null, weekday: null, start_date: null, next_run_date: null, fixed: { employees: 0, total: 0 }, balance: 100000, funded: true };
const PROGRAM_FIXED: Program = { ...PROGRAM_FLEX, mode: "fixed", cadence: "monthly", day_of_month: 15, next_run_date: "2026-11-15", fixed: { employees: 3, total: 16000 } };
const RUN = { id: "0198b2b2-0000-7000-8000-000000000002", rows: 2, total: 7500, sent: 0, held: 7500, source: "csv" as const, status: "credited" as const, run_date: "2026-10-19", created_at: "2026-10-19T10:00:00Z" };

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    logout: vi.fn().mockResolvedValue(null),
    account: vi.fn().mockResolvedValue(ACCOUNT),
    overview: vi.fn().mockResolvedValue(OVERVIEW),
    employees: vi.fn().mockResolvedValue([
      { id: "e1", employee_id: "E001", name: "Eve One", email: "eve@example.com", balance: 0, claimed: true, reminded_at: null, created_at: "2026-10-18T10:00:00Z" },
      { id: "e2", employee_id: "E002", name: "Sam Two", email: "sam@example.com", balance: 5000, claimed: false, reminded_at: null, created_at: "2026-10-18T10:00:00Z" },
    ]),
    runs: vi.fn().mockResolvedValue([RUN]),
    run: vi.fn().mockResolvedValue({
      run: RUN, summary: { claimed: 1, unclaimed: 1, still_held: 5000 },
      rows: [
        { employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500, mode: "held", transaction_id: "t0", claimed: true, balance: 0, reminded_at: null, removed: false },
        { employee_id: "E002", name: "=Sam Two", email: "sam@example.com", amount: 5000, mode: "held", transaction_id: "t1", claimed: false, balance: 5000, reminded_at: "2026-10-19T10:00:00Z", removed: false },
      ],
    }),
    runBenefits: vi.fn().mockResolvedValue({ run: RUN, emails: { sent: 2, failed: 0, not_configured: 0 } }),
    profile: vi.fn().mockResolvedValue({ legal_name: "Acme Corporation Inc", display_name: "Acme Corp", tax_id_last4: "6789", address: "1 Main St", city: "Brooklyn", state: "NY", post_code: "11201", country: "US", website: "https://acme.test" }),
    saveProfile: vi.fn().mockResolvedValue({}),
    documents: vi.fn().mockResolvedValue([{ id: "d1", type: "business_document", created_at: "2026-10-19T10:00:00Z" }]),
    uploadDocument: vi.fn().mockResolvedValue({}),
    devices: vi.fn().mockResolvedValue([]),
    revokeDevice: vi.fn().mockResolvedValue(null),
    apiKey: vi.fn().mockResolvedValue(null),
    generateApiKey: vi.fn().mockResolvedValue({ key: { hint: "9xYz", name: "Default", created_at: "2026-10-20T10:00:00Z", last_used_at: null }, token: "nk_org_TESTTOKEN9xYz" }),
    revokeApiKey: vi.fn().mockResolvedValue(null),
    program: vi.fn().mockResolvedValue(PROGRAM_FLEX),
    setProgram: vi.fn().mockImplementation(async (input: any) => ({ ...PROGRAM_FLEX, ...input, chosen: true })),
    bulkEmployees: vi.fn().mockImplementation(async (ids: string[], op: any) => ({ action: op.action, count: ids.length })),
    uploadFixedBenefits: vi.fn().mockResolvedValue({ employees: [], fixed: { employees: 2, total: 7500 } }),
    setFixedBenefit: vi.fn().mockResolvedValue({ fixed_benefit: null }),
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
  it("reads the fixed-benefits file: dollars to cents, 0 or empty clears, every problem listed", () => {
    const ok = readFixedCsv("fixed_benefit,email,name,employee_id\n\"$1,250.50\",a@x.co,Ann,E1\n,b@x.co,Bo,E2\n0,c@x.co,Cy,E3\n");
    expect(ok.errors).toEqual([]);
    expect(ok.rows.map((r) => [r.employee_id, r.fixed_benefit])).toEqual([["E1", 125050], ["E2", 0], ["E3", 0]]);
    expect([ok.total, ok.clears]).toEqual([125050, 2]);
    const bad = readFixedCsv("employee_id,name,email,fixed_benefit\nE 1,A,a@x.co,5\nE2,,b@x.co,5\nE3,C,nope,5\nE4,D,d@x.co,abc\nE4,D,d@x.co,5\nE5,E,e@x.co,200000\n");
    expect(bad.rows).toEqual([]);
    expect(bad.errors.join("\n")).toMatch(/Line 2.*employee_id/);
    expect(bad.errors.join("\n")).toMatch(/Line 6.*more than once/);
    expect(bad.errors.join("\n")).toMatch(/Line 7.*\$100,000/);
    expect(readFixedCsv("employee_id,name,email\nE1,A,a@x.co\n").errors[0]).toMatch(/Missing: fixed_benefit/);
  });

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

  it("an employee with credit held can be removed: the window says the credit stays theirs", async () => {
    const api = fakeApi();
    const user = await open(api, "/employees");
    await screen.findByText("Sam Two");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    const dialog = screen.getByRole("dialog", { name: "Remove Employee" });
    expect(dialog).toHaveTextContent("$50.00 of credit is held for them. It stays theirs: they can still claim it with their link.");
    expect(within(dialog).getByRole("button", { name: "Confirm Remove" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Confirm Remove" }));
    await waitFor(() => expect(api.removeEmployee).toHaveBeenCalledWith("e2"));
  });

  it("says so when the employee no longer exists", async () => {
    const api = fakeApi({ removeEmployee: vi.fn().mockRejectedValue(new ApiError(404, "not_found")) });
    const user = await open(api, "/employees");
    await screen.findByText("Sam Two");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await user.click(within(screen.getByRole("dialog", { name: "Remove Employee" })).getByRole("button", { name: "Confirm Remove" }));
    expect(await screen.findByText(/no longer exist/)).toBeInTheDocument();
  });

  it("previews a CSV, asks for confirmation, and runs it as one benefits run", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\nE002,Sam Two,sam@example.com,50.00\n"));
    expect(await screen.findByRole("button", { name: "Run Benefits" })).toBeEnabled();
    expect(screen.getAllByText("$75.00").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Run Benefits" }));
    expect(api.runBenefits).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Run Benefits" })).getByRole("button", { name: "Confirm Run" }));
    expect(await screen.findByText(/Crediting 2 employees/)).toBeInTheDocument();
    const running = screen.getByRole("dialog", { name: "Running Benefits" });
    expect(within(running).queryAllByRole("button")).toEqual([]);
    await waitFor(() => expect(api.runBenefits).toHaveBeenCalledWith(
      [{ employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500 }, { employee_id: "E002", name: "Sam Two", email: "sam@example.com", amount: 5000 }],
      expect.any(String)));
    const report = await screen.findByRole("dialog", { name: "Run Complete" }, { timeout: 5000 });
    expect(report).toHaveTextContent("$75.00 was credited to 2 employees");
    expect(report).not.toHaveTextContent(/email/i);
    expect(report).not.toHaveTextContent(/held/i);
    await user.click(within(report).getByRole("button", { name: "View Run" }));
    expect(await screen.findByRole("heading", { name: "Run" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/benefits/0198b2b2-0000-7000-8000-000000000002");
  });

  it("blocks a run the wallet cannot cover", async () => {
    const api = fakeApi({ overview: vi.fn().mockResolvedValue({ ...OVERVIEW, balance: 1000 }) });
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    expect(await screen.findByText(/short for this file/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Benefits" })).toBeDisabled();
  });

  it("shows each problem in a bad file and offers no run button", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE1,A,nope,5\n"));
    expect(await screen.findByText(/Line 2.*valid email/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Benefits" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Run Benefits" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Upload a CSV" })).toBeInTheDocument();
  });

  it("fails the duplicate check when an email repeats", async () => {
    const user = await open(fakeApi(), "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE1,A,a@x.co,5\nE2,B,a@x.co,5\n"));
    expect(await screen.findByText(/a@x\.co appears more than once/)).toBeInTheDocument();
    expect(screen.getByText("No Duplicate Employees").closest("li")).toHaveClass("fail");
    expect(screen.getByRole("button", { name: "Run Benefits" })).toBeDisabled();
  });

  it("explains when the server refuses because the balance changed", async () => {
    const api = fakeApi({ runBenefits: vi.fn().mockRejectedValue(new ApiError(422, "insufficient_balance", { required: 7500, available: 2000 })) });
    const user = await open(api, "/benefits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    await user.click(await screen.findByRole("button", { name: "Run Benefits" }));
    await user.click(within(screen.getByRole("dialog", { name: "Run Benefits" })).getByRole("button", { name: "Confirm Run" }));
    const report = await screen.findByRole("dialog", { name: "Benefits Not Run" });
    expect(report).toHaveTextContent("Your wallet has $20.00, and this file needs $75.00");
    expect(report).toHaveTextContent("Nothing was sent and nothing was charged.");
  });

  it("opens a run on its own page and filters by claim status", async () => {
    const api = fakeApi();
    const user = await open(api, "/benefits");
    await user.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByRole("heading", { name: "Run" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/benefits/0198b2b2-0000-7000-8000-000000000002");
    expect(api.run).toHaveBeenCalledWith("0198b2b2-0000-7000-8000-000000000002");
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
    expect(name).toBe("benefit-run-2026-10-19-not-claimed.csv");
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
    expect(screen.getByText("Use the Benefits API to grant benefits to your employees directly from your payroll, HR or rewards systems.")).toBeInTheDocument();
    expect(screen.getByText("Create and remove employees, credit a whole batch in one call, look people up by employee ID and check your wallet balance.")).toBeInTheDocument();
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

  it("asks a new organization to choose Fixed or Flexible Benefits, and cannot be dismissed until it does", async () => {
    const api = fakeApi({ program: vi.fn().mockResolvedValue({ ...PROGRAM_FLEX, chosen: false }) });
    const user = await open(api);
    const modal = await screen.findByRole("dialog", { name: "How do you want to give benefits?" });
    expect(within(modal).getByText("Fixed Benefits")).toBeInTheDocument();
    expect(within(modal).getByText(/Give each employee a set amount on a regular schedule/)).toBeInTheDocument();
    expect(within(modal).getByText("Flexible Benefits")).toBeInTheDocument();
    expect(within(modal).getByText(/Decide when and how much/)).toBeInTheDocument();
    expect(within(modal).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "How do you want to give benefits?" })).toBeInTheDocument();
    await user.click(within(modal).getByRole("button", { name: /Flexible Benefits/ }));
    await waitFor(() => expect(api.setProgram).toHaveBeenCalledWith({ mode: "flexible" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("choosing Fixed opens the schedule window: monthly day 1-28, weekly and biweekly weekdays", async () => {
    const api = fakeApi({ program: vi.fn().mockResolvedValue({ ...PROGRAM_FLEX, chosen: false }) });
    const user = await open(api);
    await user.click(await screen.findByRole("button", { name: /Fixed Benefits/ }));
    const sched = await screen.findByRole("dialog", { name: "Payment Schedule" });
    const day = within(sched).getByLabelText("Day of the month") as HTMLSelectElement;
    expect([...day.options].map((o) => o.textContent)).toEqual(Array.from({ length: 28 }, (_, i) => `${i + 1}${[11, 12, 13].includes(i + 1) ? "th" : ["th", "st", "nd", "rd"][(i + 1) % 10] ?? "th"}`));
    await user.selectOptions(day, "15");
    await user.click(within(sched).getByRole("button", { name: "Save Schedule" }));
    await waitFor(() => expect(api.setProgram).toHaveBeenCalledWith({ mode: "fixed", cadence: "monthly", day_of_month: 15 }));
  });

  it("weekly and biweekly ask for a weekday", async () => {
    const api = fakeApi({ program: vi.fn().mockResolvedValue({ ...PROGRAM_FLEX, chosen: false }) });
    const user = await open(api);
    await user.click(await screen.findByRole("button", { name: /Fixed Benefits/ }));
    const sched = await screen.findByRole("dialog", { name: "Payment Schedule" });
    await user.selectOptions(within(sched).getByLabelText("How often"), "biweekly");
    expect((within(sched).getByLabelText("Weekday") as HTMLSelectElement).options.length).toBe(7);
    await user.selectOptions(within(sched).getByLabelText("Weekday"), "3");
    expect(within(sched).queryByLabelText("Day of the month")).not.toBeInTheDocument();
    await user.click(within(sched).getByRole("button", { name: "Save Schedule" }));
    await waitFor(() => expect(api.setProgram).toHaveBeenCalledWith({ mode: "fixed", cadence: "biweekly", weekday: 3 }));
  });

  it("shows the program on the Benefits page: schedule, next payment, who is covered, and funding", async () => {
    const api = fakeApi({ program: vi.fn().mockResolvedValue(PROGRAM_FIXED) });
    const user = await open(api, "/benefits");
    const card = await screen.findByLabelText("Benefits program");
    expect(card).toHaveTextContent("Every month on the 15th");
    expect(card).toHaveTextContent("Sunday, November 15");
    expect(card).toHaveTextContent("3 employees • $160.00 each payment");
    expect(card).toHaveTextContent("Your wallet covers the next payment.");
    await user.click(within(card).getByRole("button", { name: "Edit Schedule" }));
    expect(await screen.findByRole("dialog", { name: "Payment Schedule" })).toBeInTheDocument();     // opens on its own
    expect((screen.getByLabelText("Day of the month") as HTMLSelectElement).value).toBe("15");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(card).getByRole("button", { name: "Change Mode" }));
    const modal = await screen.findByRole("dialog", { name: "How do you want to give benefits?" });
    expect(within(modal).getAllByText("current")).toHaveLength(1);
    await user.click(within(modal).getByRole("button", { name: "Cancel" }));
  });

  it("warns when the wallet will not cover the next payment, and when nobody has a fixed benefit yet", async () => {
    await open(fakeApi({ program: vi.fn().mockResolvedValue({ ...PROGRAM_FIXED, balance: 5000, funded: false }) }), "/benefits");
    expect(await screen.findByText(/Your wallet is \$110\.00 short for the next payment/)).toBeInTheDocument();
  });

  it("a flexible organization sees a flexible program and no fixed-benefit tools", async () => {
    const user = await open(fakeApi(), "/employees");
    await screen.findByText("Sam Two");
    expect(screen.queryByRole("button", { name: "Upload Fixed Benefits" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fixed Benefit")).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("link", { name: "Benefits" }));
    expect(await screen.findByLabelText("Benefits program")).toHaveTextContent("flexible");
  });

  it("Fixed mode adds a Fixed Benefit column, an upload and a per-employee edit", async () => {
    const api = fakeApi({
      program: vi.fn().mockResolvedValue(PROGRAM_FIXED),
      employees: vi.fn().mockResolvedValue([
        { id: "e1", employee_id: "E001", name: "Eve One", email: "eve@example.com", balance: 0, claimed: true, reminded_at: null, created_at: "2026-10-18T10:00:00Z", fixed_benefit: 5000 },
        { id: "e2", employee_id: "E002", name: "Sam Two", email: "sam@example.com", balance: 5000, claimed: false, reminded_at: null, created_at: "2026-10-18T10:00:00Z", fixed_benefit: null },
      ]),
    });
    const user = await open(api, "/employees");
    expect(await screen.findByText("Fixed Benefit")).toBeInTheDocument();
    expect(screen.getAllByText("$50.00").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Edit fixed benefit for Sam Two" }));
    await user.type(within(screen.getByRole("dialog", { name: "Fixed Benefit" })).getByLabelText("Amount (USD)"), "25.5");
    await user.click(within(screen.getByRole("dialog", { name: "Fixed Benefit" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setFixedBenefit).toHaveBeenCalledWith("e2", 2550));
    await user.click(screen.getByRole("button", { name: "Edit fixed benefit for Eve One" }));
    await user.clear(within(screen.getByRole("dialog", { name: "Fixed Benefit" })).getByLabelText("Amount (USD)"));
    await user.click(within(screen.getByRole("dialog", { name: "Fixed Benefit" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setFixedBenefit).toHaveBeenCalledWith("e1", null));
    await user.click(screen.getByRole("button", { name: "Upload Fixed Benefits" }));
    const up = screen.getByRole("dialog", { name: "Upload Fixed Benefits" });
    expect(within(up).getByRole("button", { name: "Save Fixed Benefits" })).toBeDisabled();
    await user.upload(within(up).getByLabelText("Fixed benefits file"), csvFile("employee_id,name,email,fixed_benefit\nE001,Eve One,eve@example.com,50\nE002,Sam Two,sam@example.com,25.50\nE003,Zed,zed@example.com,0\n"));
    expect(await within(up).findByText(/3 employees, \$75\.50 per payment, 1 cleared/)).toBeInTheDocument();
    await user.click(within(up).getByRole("button", { name: "Save Fixed Benefits" }));
    await waitFor(() => expect(api.uploadFixedBenefits).toHaveBeenCalledWith([
      { employee_id: "E001", name: "Eve One", email: "eve@example.com", fixed_benefit: 5000 },
      { employee_id: "E002", name: "Sam Two", email: "sam@example.com", fixed_benefit: 2550 },
      { employee_id: "E003", name: "Zed", email: "zed@example.com", fixed_benefit: 0 }]));
  });

  describe("mass edit", () => {
    const EMPS = [
      { id: "e1", employee_id: "E001", name: "Eve One", email: "eve@example.com", balance: 0, claimed: true, reminded_at: null, created_at: "2026-10-18T10:00:00Z", fixed_benefit: 5000 },
      { id: "e2", employee_id: "E002", name: "Sam Two", email: "sam@example.com", balance: 5000, claimed: false, reminded_at: null, created_at: "2026-10-18T10:00:00Z", fixed_benefit: null },
      { id: "e3", employee_id: "E003", name: "Zed Three", email: "zed@example.com", balance: 0, claimed: false, reminded_at: null, created_at: "2026-10-18T10:00:00Z", fixed_benefit: null },
    ];
    const setup = (program = PROGRAM_FIXED) => fakeApi({ program: vi.fn().mockResolvedValue(program), employees: vi.fn().mockResolvedValue(EMPS) });

    it("shows an action bar only when rows are checked; the header box selects everyone", async () => {
      const user = await open(setup(), "/employees");
      await screen.findByText("Zed Three");
      expect(screen.queryByRole("toolbar", { name: "Selected employees" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: "Select Eve One" }));
      const bar = screen.getByRole("toolbar", { name: "Selected employees" });
      expect(bar).toHaveTextContent("1 selected");
      expect((screen.getByRole("checkbox", { name: "Select all employees" }) as HTMLInputElement).indeterminate).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: "Select all employees" }));
      expect(bar).toHaveTextContent("3 selected");
      await user.click(within(bar).getByRole("button", { name: "Clear Selection" }));
      expect(screen.queryByRole("toolbar", { name: "Selected employees" })).not.toBeInTheDocument();
    });

    it("sets one fixed benefit for everyone selected", async () => {
      const api = setup();
      const user = await open(api, "/employees");
      await screen.findByText("Zed Three");
      await user.click(screen.getByRole("checkbox", { name: "Select Sam Two" }));
      await user.click(screen.getByRole("checkbox", { name: "Select Zed Three" }));
      await user.click(screen.getByRole("button", { name: "Set Fixed Benefit" }));
      const dialog = screen.getByRole("dialog", { name: "Set Fixed Benefit" });
      await user.type(within(dialog).getByLabelText("Amount (USD)"), "25.5");
      expect(dialog).toHaveTextContent("$25.50 each, $51.00 in total per payment");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.bulkEmployees).toHaveBeenCalledWith(["e2", "e3"], { action: "set_fixed", amount: 2550 }));
      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selected employees" })).not.toBeInTheDocument());
    });

    it("clears fixed benefits after a confirmation", async () => {
      const api = setup();
      const user = await open(api, "/employees");
      await screen.findByText("Zed Three");
      await user.click(screen.getByRole("checkbox", { name: "Select all employees" }));
      await user.click(screen.getByRole("button", { name: "Clear Fixed Benefit" }));
      expect(api.bulkEmployees).not.toHaveBeenCalled();
      await user.click(within(screen.getByRole("dialog", { name: "Clear Fixed Benefit" })).getByRole("button", { name: "Confirm Clear" }));
      await waitFor(() => expect(api.bulkEmployees).toHaveBeenCalledWith(["e1", "e2", "e3"], { action: "clear_fixed" }));
    });

    it("removes everyone selected, including people with credit held, and says that credit stays theirs", async () => {
      const api = setup();
      const user = await open(api, "/employees");
      await screen.findByText("Zed Three");
      await user.click(screen.getByRole("checkbox", { name: "Select Sam Two" }));
      await user.click(screen.getByRole("checkbox", { name: "Select Zed Three" }));
      await user.click(within(screen.getByRole("toolbar", { name: "Selected employees" })).getByRole("button", { name: "Remove" }));
      const dialog = screen.getByRole("dialog", { name: "Remove Employees" });
      expect(dialog).toHaveTextContent("1 of them has $50.00 of credit held. It stays theirs: they can still claim it with their link.");
      expect(within(dialog).getByRole("button", { name: "Confirm Remove" })).toBeEnabled();
      await user.click(within(dialog).getByRole("button", { name: "Confirm Remove" }));
      await waitFor(() => expect(api.bulkEmployees).toHaveBeenCalledWith(["e2", "e3"], { action: "remove" }));
    });

    it("a flexible organization can only remove or clear the selection (no fixed-benefit actions)", async () => {
      const user = await open(setup(PROGRAM_FLEX), "/employees");
      await screen.findByText("Zed Three");
      await user.click(screen.getByRole("checkbox", { name: "Select Zed Three" }));
      const bar = screen.getByRole("toolbar", { name: "Selected employees" });
      expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove", "Clear Selection"]);
    });

    it("says nothing changed when the server refuses", async () => {
      const api = setup();
      api.bulkEmployees = vi.fn().mockRejectedValue(new ApiError(500, "internal_error")) as any;
      const user = await open(api, "/employees");
      await screen.findByText("Zed Three");
      await user.click(screen.getByRole("checkbox", { name: "Select Zed Three" }));
      await user.click(within(screen.getByRole("toolbar", { name: "Selected employees" })).getByRole("button", { name: "Remove" }));
      await user.click(within(screen.getByRole("dialog", { name: "Remove Employees" })).getByRole("button", { name: "Confirm Remove" }));
      expect(await screen.findByText(/Nothing was changed/)).toBeInTheDocument();
      expect(screen.getByRole("toolbar", { name: "Selected employees" })).toBeInTheDocument();     // the selection stays
    });
  });

  it("the run history says where each run came from and whether it was paid", async () => {
    const api = fakeApi({ runs: vi.fn().mockResolvedValue([
      { ...RUN, id: "r1", source: "schedule", status: "credited" }, { ...RUN, id: "r2", source: "schedule", status: "waiting_for_funds" },
      { ...RUN, id: "r3", source: "api", status: "credited" }, { ...RUN, id: "r4", source: "schedule", status: "missed" }]) });
    await open(api, "/benefits");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("Schedule")).toHaveLength(3);
    expect(within(table).getByText("API")).toBeInTheDocument();
    for (const t of ["credited", "waiting for funds", "missed"]) expect(within(table).getAllByText(t).length).toBeGreaterThan(0);
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

describe("email links and forgot password", () => {
  it("asks for a reset link from the sign-in page and gives the same answer either way", async () => {
    window.history.replaceState(null, "", "/");
    const user = userEvent.setup();
    const request = vi.fn().mockResolvedValue({ ok: true });
    render(<Login signIn={vi.fn()} signUp={vi.fn()} notice={null} onSignedIn={vi.fn()} requestPasswordReset={request} />);
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "Me@Example.com");
    await user.click(screen.getByRole("button", { name: "Send Reset Link" }));
    expect(request).toHaveBeenCalledWith("me@example.com");
    expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
  });

  it("opens the reset page from the emailed link, checks the passwords and sends the token", async () => {
    window.history.replaceState(null, "", "/reset-password?token=tok-abc");
    const user = userEvent.setup();
    const confirm = vi.fn().mockResolvedValue({ ok: true });
    render(<App confirmPasswordReset={confirm} />);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New Password"), "short");
    await user.type(screen.getByLabelText("Repeat Password"), "short");
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(await screen.findByText("Use a password of at least 10 characters.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("New Password")); await user.clear(screen.getByLabelText("Repeat Password"));
    await user.type(screen.getByLabelText("New Password"), "a long new password");
    await user.type(screen.getByLabelText("Repeat Password"), "a different one 1");
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Repeat Password"));
    await user.type(screen.getByLabelText("Repeat Password"), "a long new password");
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(confirm).toHaveBeenCalledWith("tok-abc", "a long new password");
    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign In" }));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });

  it("explains a reset link that is no longer valid", async () => {
    window.history.replaceState(null, "", "/reset-password?token=old");
    const user = userEvent.setup();
    render(<App confirmPasswordReset={vi.fn().mockRejectedValue(new ApiError(400, "invalid_token"))} />);
    await user.type(screen.getByLabelText("New Password"), "a long new password");
    await user.type(screen.getByLabelText("Repeat Password"), "a long new password");
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    expect(await screen.findByText(/invalid, already used, or has expired/)).toBeInTheDocument();
  });

  it("confirms the email address from the verify link, and says so when the link is bad", async () => {
    window.history.replaceState(null, "", "/verify-email?token=good");
    const verify = vi.fn().mockResolvedValue({ verified: true });
    const { unmount } = render(<App verifyEmail={verify} />);
    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(verify).toHaveBeenCalledWith("good");
    unmount();
    window.history.replaceState(null, "", "/verify-email?token=bad");
    render(<App verifyEmail={vi.fn().mockRejectedValue(new ApiError(400, "invalid_token"))} />);
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeInTheDocument();
  });

  it("ignores these addresses without a token", () => {
    window.history.replaceState(null, "", "/reset-password");
    render(<App />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
