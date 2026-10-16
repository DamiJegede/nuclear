import { ApiError, completeMfa, createApi, isChallenge, signIn } from "./api";

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

  it("signs in with a JSON body and no Authorization header", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { session_token: "s", admin: { access_id: "a", name: "A" }, must_change_access_token: false }));
    const r = await signIn("JANE.DOE", "tok tok tok tok", "https://api.test");
    expect(isChallenge(r)).toBe(false);
    expect((r as { session_token: string }).session_token).toBe("s");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/admin/login");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ access_id: "JANE.DOE", access_token: "tok tok tok tok" });
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("recognises an MFA challenge instead of a session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { mfa_required: true, mfa_token: "t".repeat(30), expires_in: 300 }));
    const r = await signIn("a", "b", "https://api.test");
    expect(isChallenge(r)).toBe(true);
  });

  it("finishes the second step with the challenge token and a code, still without a bearer header", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { session_token: "s", admin: { access_id: "a", name: "A" }, must_change_access_token: false, mfa_enabled: true }));
    await completeMfa("challenge", "123456", "https://api.test");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.test/v1/admin/login/mfa");
    expect(JSON.parse(init!.body as string)).toEqual({ mfa_token: "challenge", code: "123456" });
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("calls the enrollment endpoints with the session token", async () => {
    const f = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, { secret: "S", otpauth_uri: "otpauth://x" }))
      .mockResolvedValueOnce(reply(200, { recovery_codes: ["a-b"] }))
      .mockResolvedValueOnce(reply(200, { recovery_codes: ["c-d"] }));
    const api = createApi("sess", "https://api.test");
    expect(await api.mfaSetup()).toEqual({ secret: "S", otpauth_uri: "otpauth://x" });
    expect(await api.mfaEnable("123456")).toEqual(["a-b"]);
    expect(await api.newRecoveryCodes("654321")).toEqual(["c-d"]);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://api.test/v1/admin/mfa/setup", "https://api.test/v1/admin/mfa/enable", "https://api.test/v1/admin/mfa/recovery-codes"]);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer sess");
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ code: "123456" });
  });

  it("maps a refused sign-in to ApiError 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(401, { error: "invalid_credentials" }));
    await expect(signIn("a", "b", "https://api.test")).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
  });

  it("signs out with a POST", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const api = createApi("t", "https://api.test");
    await api.logout();
    expect(f.mock.calls[0]![0]).toBe("https://api.test/v1/admin/logout");
    expect(f.mock.calls[0]![1]!.method).toBe("POST");
  });

  it("never puts the token in the URL", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, {}));
    await createApi("sekret-token", "https://api.test").stats();
    expect(String(f.mock.calls[0]![0])).not.toContain("sekret-token");
  });
});
