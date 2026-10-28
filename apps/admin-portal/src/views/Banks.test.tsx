import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, InstitutionRow, RoutingNumberRow } from "../api";
import { Banks } from "./Banks";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const inst = (o: Partial<InstitutionRow> = {}): InstitutionRow => ({ id: "i1", name: "Test National", icon: null, domain: "testnational.example", aliases: ["test national bank"], created_at: "2026-10-01T12:00:00Z", routing_numbers: 2, accounts: 3, hosts: [], brands: 0, ...o });
const rn = (o: Partial<RoutingNumberRow> = {}): RoutingNumberRow => ({ id: "r1", routing_number: "110000000", directory_name: "TEST NATIONAL BANK, N.A.", institution_id: "i1", institution: "Test National", icon: null, instant: true, networks: ["RTP", "FedNow"], refreshed_at: "2026-10-20T12:00:00Z", created_at: "2026-10-01T12:00:00Z", accounts: 3, ...o });
const instPage = (items: InstitutionRow[], o: object = {}) => ({ institutions: items, next_cursor: null, total: items.length, needs_logo: items.filter((i) => !i.icon && i.accounts > 0).length, unlinked: 1, ...o });
const rnPage = (items: RoutingNumberRow[], o: object = {}) => ({ routing_numbers: items, next_cursor: null, total: items.length, needs_logo: 1, unlinked: items.filter((r) => !r.institution_id).length, ...o });
const api = (over: Partial<Api> = {}) => ({
  institutions: vi.fn().mockResolvedValue(instPage([inst(), inst({ id: "i2", name: "Bigger Bank", icon: "https://x.test/v1/photos/institutions/i2.png", routing_numbers: 1, accounts: 1, domain: null, aliases: [] })])),
  routingNumbers: vi.fn().mockResolvedValue(rnPage([rn(), rn({ id: "r2", routing_number: "021000021", directory_name: null, institution_id: null, institution: null, instant: null, networks: [], accounts: 1 })])),
  createInstitution: vi.fn().mockResolvedValue({ institution: { id: "i3" }, linked: 2 }), updateInstitution: vi.fn().mockResolvedValue({ linked: 0 }), uploadInstitutionIcon: vi.fn().mockResolvedValue(null),
  addRoutingNumber: vi.fn().mockResolvedValue({ routing_number: { id: "r9" } }), linkRoutingNumber: vi.fn().mockResolvedValue(null),
  ...over,
}) as unknown as Api;

describe("Banks: institutions", () => {
  it("lists institutions with their logo, website, routing numbers and accounts, and marks the ones that need a logo", async () => {
    render(<Banks api={api()} canWrite onError={vi.fn()} />);
    const row = await screen.findByRole("row", { name: /Test National/ });
    expect(row).toHaveTextContent("testnational.example");
    expect(row).toHaveTextContent("needs logo");
    const other = screen.getByRole("row", { name: /Bigger Bank/ });
    expect(other.querySelector("img.bank-icon")).toHaveAttribute("src", "https://x.test/v1/photos/institutions/i2.png");
    expect(other).not.toHaveTextContent("needs logo");
  });

  it("the Needs Logo filter asks the API; the tabs carry the counts and the page reports the total for the navigation badge", async () => {
    const institutions = vi.fn().mockResolvedValue(instPage([inst()]));
    const onCount = vi.fn();
    const user = userEvent.setup();
    render(<Banks api={api({ institutions })} canWrite onError={vi.fn()} onCount={onCount} />);
    await user.click(await screen.findByRole("button", { name: /Needs Logo \(1\)/ }));
    await waitFor(() => expect(institutions).toHaveBeenLastCalledWith(expect.objectContaining({ needsLogo: true })));
    expect(onCount).toHaveBeenCalledWith(2);                                   // one needs a logo, one routing number is not linked
    expect(screen.getByRole("tab", { name: /Institutions/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Routing Numbers/ })).toHaveTextContent("1");
  });

  it("adds an institution with aliases and says how many routing numbers it claimed", async () => {
    const createInstitution = vi.fn().mockResolvedValue({ institution: { id: "i3" }, linked: 2 });
    const user = userEvent.setup();
    render(<Banks api={api({ createInstitution })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Add Institution" }));
    const dlg = screen.getByRole("dialog", { name: "Add Institution" });
    await user.type(within(dlg).getByLabelText("Name"), "Chase");
    await user.type(within(dlg).getByLabelText("Website"), "chase.com");
    await user.type(within(dlg).getByLabelText("Aliases"), "jpmorgan chase, chase bank");
    await user.click(within(dlg).getByRole("button", { name: "Save Institution" }));
    await waitFor(() => expect(createInstitution).toHaveBeenCalledWith({ name: "Chase", domain: "chase.com", aliases: ["jpmorgan chase", "chase bank"], hosts: [] }));
    expect(await screen.findByText("2 routing numbers were linked by name.")).toBeInTheDocument();
  });

  it("a brand is given the partner banks it runs on, found by search", async () => {
    const createInstitution = vi.fn().mockResolvedValue({ institution: { id: "i9" }, linked: 0 });
    const institutions = vi.fn().mockImplementation(async (o: { q?: string } = {}) => instPage(o.q ? [inst({ id: "col", name: "Column" }), inst({ id: "mer", name: "Mercury", hosts: [{ id: "col", name: "Column" }] })] : [inst()]));
    const user = userEvent.setup();
    render(<Banks api={api({ createInstitution, institutions })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Add Institution" }));
    const dlg = screen.getByRole("dialog", { name: "Add Institution" });
    await user.type(within(dlg).getByLabelText("Name"), "Brex");
    await user.type(within(dlg).getByLabelText(/Runs on/), "col");
    expect(await within(dlg).findByRole("button", { name: "Add Column" })).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Add Mercury" })).toBeNull();      // a brand cannot be a partner bank
    await user.click(within(dlg).getByRole("button", { name: "Add Column" }));
    await user.click(within(dlg).getByRole("button", { name: "Save Institution" }));
    await waitFor(() => expect(createInstitution).toHaveBeenCalledWith({ name: "Brex", domain: null, aliases: [], hosts: ["col"] }));
  });

  it("a name already used by another institution is explained", async () => {
    const { ApiError } = await import("../api");
    const createInstitution = vi.fn().mockRejectedValue(new ApiError(409, "alias_taken"));
    const user = userEvent.setup();
    render(<Banks api={api({ createInstitution })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Add Institution" }));
    const dlg = screen.getByRole("dialog", { name: "Add Institution" });
    await user.type(within(dlg).getByLabelText("Name"), "Column");
    await user.click(within(dlg).getByRole("button", { name: "Save Institution" }));
    expect(await within(dlg).findByText("That name or alias already belongs to another institution.")).toBeInTheDocument();
  });

  it("choosing a logo fits it into the square and uploads it for that institution", async () => {
    const uploadInstitutionIcon = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 400, height: 100, close: vi.fn() }));
    const ctx = { drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob([new Uint8Array(10)], { type: "image/png" })));
    const user = userEvent.setup();
    render(<Banks api={api({ uploadInstitutionIcon })} canWrite onError={vi.fn()} />);
    await user.click(await screen.findByRole("row", { name: /Test National/ }));
    await user.click(screen.getByRole("button", { name: "Upload logo for Test National" }));
    await user.upload(screen.getByLabelText("Choose a logo"), new File([new Uint8Array(20)], "logo.png", { type: "image/png" }));
    await waitFor(() => expect(uploadInstitutionIcon).toHaveBeenCalledWith("i1", expect.any(Blob)));
    const args = ctx.drawImage.mock.calls[0]!;
    expect(args.slice(1, 5)).toEqual([0, 0, 400, 100]);                       // the whole wide logo, not a crop
    expect(await screen.findByText("Logo saved for Test National.")).toBeInTheDocument();
  });

  it("a role that can only look has no buttons", async () => {
    const user = userEvent.setup();
    render(<Banks api={api()} canWrite={false} onError={vi.fn()} />);
    await user.click(await screen.findByRole("row", { name: /Test National/ }));
    expect(screen.queryByRole("button", { name: /^(Edit|Upload logo|Replace logo|Add Institution)/i })).toBeNull();
    expect(screen.getAllByText("You can look but not change institutions.").length).toBeGreaterThan(0);
  });
});

describe("Banks: routing numbers", () => {
  const openTab = async () => { const user = userEvent.setup(); await user.click(await screen.findByRole("tab", { name: /Routing Numbers/ })); return user; };

  it("lists routing numbers with their institution, the directory's name, instant support and a 'not linked' marker", async () => {
    render(<Banks api={api()} canWrite onError={vi.fn()} />);
    await openTab();
    const row = await screen.findByRole("row", { name: /110000000/ });
    expect(row).toHaveTextContent("Test National");
    expect(row).toHaveTextContent("TEST NATIONAL BANK, N.A.");
    expect(row).toHaveTextContent("Yes · RTP, FedNow");
    const loose = screen.getByRole("row", { name: /021000021/ });
    expect(loose).toHaveTextContent("not linked");
    expect(loose).toHaveTextContent("Unknown");
  });

  it("Not Linked asks the API for the numbers in use that no institution claims", async () => {
    const routingNumbers = vi.fn().mockResolvedValue(rnPage([rn({ id: "r2", institution_id: null, institution: null })]));
    render(<Banks api={api({ routingNumbers })} canWrite onError={vi.fn()} />);
    const user = await openTab();
    await user.click(await screen.findByRole("button", { name: /Not Linked/ }));
    await waitFor(() => expect(routingNumbers).toHaveBeenLastCalledWith(expect.objectContaining({ unlinked: true })));
  });

  it("links a number to an institution chosen from the list, and unlinks it", async () => {
    const linkRoutingNumber = vi.fn().mockResolvedValue(null);
    render(<Banks api={api({ linkRoutingNumber })} canWrite onError={vi.fn()} />);
    const user = await openTab();
    await user.click(await screen.findByRole("row", { name: /021000021/ }));
    await user.click(screen.getByRole("button", { name: "Link 021000021 to an institution" }));
    const dlg = screen.getByRole("dialog", { name: "Link To Institution" });
    await user.selectOptions(await within(dlg).findByLabelText("Institution"), "Bigger Bank");
    await user.click(within(dlg).getByRole("button", { name: "Save Link" }));
    await waitFor(() => expect(linkRoutingNumber).toHaveBeenCalledWith("r2", "i2"));
    await user.click(screen.getByRole("row", { name: /110000000/ }));
    await user.click(screen.getByRole("button", { name: "Unlink 110000000" }));
    await waitFor(() => expect(linkRoutingNumber).toHaveBeenCalledWith("r1", null));
  });

  it("adds a routing number by hand (digits only, 9 of them)", async () => {
    const addRoutingNumber = vi.fn().mockResolvedValue({ routing_number: { id: "r9" } });
    render(<Banks api={api({ addRoutingNumber })} canWrite onError={vi.fn()} />);
    const user = await openTab();
    await user.click(await screen.findByRole("button", { name: "Add Routing Number" }));
    const dlg = screen.getByRole("dialog", { name: "Add Routing Number" });
    await user.type(within(dlg).getByLabelText("Routing number"), "32a2271627x");
    expect(within(dlg).getByRole("button", { name: "Add Routing Number" })).toBeEnabled();
    await user.click(within(dlg).getByRole("button", { name: "Add Routing Number" }));
    await waitFor(() => expect(addRoutingNumber).toHaveBeenCalledWith({ routing_number: "322271627", institution_id: null }));
  });
});
