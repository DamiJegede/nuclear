import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App";
import { ApiError, type Account, type Api, type Session } from "./api";
import { parseCsv, readCreditCsv } from "./csv";

const SESSION: Session = { account_id: "o1", device_id: "d1", session_token: "tok-1", session_expires_at: "2027-01-01T00:00:00Z" };
const ACCOUNT: Account = { account_id: "o1", type: "O", handle: null, name: "Acme Corp", email: "hr@acme.test", phone: null, photo: null, status: "active" };
const OVERVIEW = { balance: 100000, employees: { total: 3, claimed: 1, unclaimed: 2 }, held: 7500, last_batch: { id: "b1", rows: 3, total: 10000, sent: 2500, held: 7500, created_at: "2026-10-18T10:00:00Z" } };
const BATCH = { id: "b2", rows: 2, total: 7500, sent: 0, held: 7500, created_at: "2026-10-19T10:00:00Z" };

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
    batch: vi.fn().mockResolvedValue({ batch: BATCH, rows: [{ employee_id: "E002", name: "Sam Two", email: "sam@example.com", amount: 5000, mode: "held", transaction_id: "t1" }] }),
    runBatch: vi.fn().mockResolvedValue({ batch: BATCH, emails: { sent: 2, failed: 0, not_configured: 0 } }),
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
    expect(r.errors.join("\n")).toMatch(/Line 6.*more than once/);
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
    expect(within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.textContent)).toEqual(["Overview", "Employees", "Credits"]);
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
    const user = await open(api, "/credits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\nE002,Sam Two,sam@example.com,50.00\n"));
    expect(await screen.findByRole("button", { name: "Run Batch" })).toBeEnabled();
    expect(screen.getAllByText("$75.00").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Run Batch" }));
    expect(api.runBatch).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog", { name: "Run Batch" })).getByRole("button", { name: "Confirm Run" }));
    await waitFor(() => expect(api.runBatch).toHaveBeenCalledWith(
      [{ employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500 }, { employee_id: "E002", name: "Sam Two", email: "sam@example.com", amount: 5000 }],
      expect.any(String)));
    expect(await screen.findByText(/Done: \$75\.00 credited to 2 employees/)).toBeInTheDocument();
  });

  it("blocks a batch the wallet cannot cover", async () => {
    const api = fakeApi({ overview: vi.fn().mockResolvedValue({ ...OVERVIEW, balance: 1000 }) });
    const user = await open(api, "/credits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    expect(await screen.findByText(/short for this file/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Batch" })).toBeDisabled();
  });

  it("shows each problem in a bad file and offers no run button", async () => {
    const api = fakeApi();
    const user = await open(api, "/credits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE1,A,nope,5\n"));
    expect(await screen.findByText(/Line 2.*valid email/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Batch" })).not.toBeInTheDocument();
  });

  it("explains when the server refuses because the balance changed", async () => {
    const api = fakeApi({ runBatch: vi.fn().mockRejectedValue(new ApiError(422, "insufficient_balance", { required: 7500, available: 2000 })) });
    const user = await open(api, "/credits");
    await user.upload(await screen.findByLabelText("CSV file"), csvFile("employee_id,name,email,amount\nE001,Eve One,eve@example.com,25.00\n"));
    await user.click(await screen.findByRole("button", { name: "Run Batch" }));
    await user.click(within(screen.getByRole("dialog", { name: "Run Batch" })).getByRole("button", { name: "Confirm Run" }));
    expect(await screen.findByText(/Your wallet has \$20\.00, and this file needs \$75\.00/)).toBeInTheDocument();
  });

  it("opens a batch's details", async () => {
    const user = await open(fakeApi(), "/credits");
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Batch Details" });
    expect(await within(dialog).findByText("Sam Two")).toBeInTheDocument();
    expect(within(dialog).getByText("Held")).toBeInTheDocument();
  });

  it("signs out when the session ends", async () => {
    await open(fakeApi({ overview: vi.fn().mockRejectedValue(new ApiError(401, "unauthorized")) }));
    expect(await screen.findByText("Your session ended. Sign in again.")).toBeInTheDocument();
  });
});
