import { ApiError, createApi } from "./api";

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("api client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the bearer token and returns the parsed body", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { models: [{ id: "m1" }] }));
    const models = await createApi("sekret", "https://api.test/").models();
    expect(models).toEqual([{ id: "m1" }]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/admin/tag-models");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sekret");
  });

  it("posts JSON for creates", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(201, { model: { id: "m2", name: "X" } }));
    await createApi("t", "https://api.test").createModel({ type: "band", name: "X", price: 2999, quantity: 5, limited: false, status: "pending" });
    const init = f.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ price: 2999, status: "pending" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("maps HTTP errors to ApiError with the server's code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(401, { error: "unauthorized" }));
    await expect(createApi("bad", "https://api.test").stats()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("copes with a non-JSON error page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(502, "<html>Bad gateway</html>"));
    await expect(createApi("t", "https://api.test").stats()).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("reports an unreachable API as status 0", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const err = await createApi("t", "https://api.test").stats().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it("never puts the token in the URL", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, {}));
    await createApi("sekret-token", "https://api.test").stats();
    expect(String(f.mock.calls[0]![0])).not.toContain("sekret-token");
  });
});
