import { modelRuntimePaths } from "../src/runtime/storage.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, InMemoryModelsStore, type AssistantMessage, type Credential } from "@earendil-works/pi-ai";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listModels, resolveModel, modelThinkingLevel } from "../src/runtime/models.js";
import { defaultConfig } from "../src/config.js";

const realCreate = ModelRuntime.create.bind(ModelRuntime);
const selection = { provider: "anthropic", model: "claude-sonnet-4-6" };
let directory: string;
let runtime: ModelRuntime;
let configureRuntime: ((value: ModelRuntime) => void) | undefined;
const signal = () => new AbortController().signal;
const saveAuth = (credentials: Record<string, Credential>) => writeFile(join(directory, "auth.json"), JSON.stringify(credentials));
const saveModels = (providers: Record<string, unknown>) => writeFile(join(directory, "models.json"), JSON.stringify({ providers }));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xloom-models-test-"));
  vi.stubEnv("XLOOM_HOME", directory);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "PI_OFFLINE", "XLOOM_TEST_KEY"]) vi.stubEnv(name, undefined);
  configureRuntime = undefined;
  // Exercise Pi's real config/auth code, but never a user credential store or a network catalog.
  vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
    runtime = await realCreate({ ...options, refreshOnCreate: false, modelsStore: new InMemoryModelsStore() });
    vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
    configureRuntime?.(runtime);
    return runtime;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Pi model resolution", () => {
  it("defaults new tasks and omitted settings to the highest supported thinking level", async () => {
    expect(defaultConfig("fixture").models.decide.thinking).toBe("max");
    vi.stubEnv("XLOOM_TEST_KEY", "synthetic-key");
    const result = await resolveModel({ provider: "custom", model: "custom-model", api: "anthropic-messages",
      baseUrl: "https://example.invalid/v1", apiKeyEnv: "XLOOM_TEST_KEY" }, signal());
    expect(result.model.reasoning).toBe(true);
    expect(modelThinkingLevel(result.model)).toBe("high");
    expect(modelThinkingLevel({ ...result.model, thinkingLevelMap: { max: "max" } })).toBe("max");
    expect(modelThinkingLevel({ ...result.model, reasoning: false })).toBe("off");
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    result.streamFn(result.model, { messages: [] });
    expect(stream.mock.calls[0]?.[2]?.reasoning).toBe("high");
  });

  it.each([undefined, "max", "off"] as const)("serializes actual Anthropic thinking fields for an inline endpoint (%s)", async thinking => {
    vi.stubEnv("XLOOM_TEST_KEY", "synthetic-key");
    const result = await resolveModel({ provider: "opencode-go", model: "deepseek-flash", api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go", apiKeyEnv: "XLOOM_TEST_KEY", thinking }, signal());
    let payload: Record<string, unknown> | undefined;
    const network = vi.fn(() => { throw new Error("Network must not run in serialization test"); });
    const response = await (await result.streamFn(result.model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
      fetch: network, onPayload: value => { payload = value as Record<string, unknown>; throw new Error("SERIALIZATION_CAPTURE_COMPLETE"); },
    })).result();
    expect(response.errorMessage).toContain("SERIALIZATION_CAPTURE_COMPLETE");
    expect(network).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ model: "deepseek-flash", max_tokens: 16384,
      thinking: thinking === "off" ? { type: "disabled" } : { type: "enabled", budget_tokens: 15360 } });
  });

  it("preserves explicit non-reasoning capabilities without sending unsupported thinking", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "synthetic-key");
    const result = await resolveModel({ provider: "custom", model: "plain", api: "anthropic-messages",
      baseUrl: "https://example.invalid/v1", apiKeyEnv: "XLOOM_TEST_KEY", reasoning: false, thinking: "max" }, signal());
    expect(result.model.reasoning).toBe(false);
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    result.streamFn(result.model, { messages: [] });
    expect(stream.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
  });

  it("uses Pi's static model and an explicit environment override", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "test-model-key");
    const requestSignal = signal();
    const result = await resolveModel({ ...selection, apiKeyEnv: "XLOOM_TEST_KEY", maxTokens: 2048 }, requestSignal);
    expect(ModelRuntime.create).toHaveBeenCalledWith({ ...modelRuntimePaths(), allowModelNetwork: false, signal: requestSignal });
    expect(result.model.id).toBe(selection.model);
    expect(result.model.maxTokens).toBe(2048);
    expect(result.secrets).toContain("test-model-key");
    expect(result.costKnown).toBe(true);
  });

  it("uses Pi's normal environment names without apiKeyEnv", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "standard-provider-key");
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toContain("standard-provider-key");
  });

  it("uses Pi auth.json with Pi's stored-key precedence over the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-environment-key");
    await saveAuth({ anthropic: { type: "api_key", key: "stored-test-key" } });
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toContain("stored-test-key");
    expect(result.secrets).not.toContain("unused-environment-key");
  });

  it("accepts header-only provider auth and redacts the bare bearer token too", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "header-only-token");
    const result = await resolveModel(selection, signal());
    expect(result.secrets).toEqual(expect.arrayContaining(["Bearer header-only-token", "header-only-token"]));
  });

  it("delegates stored OAuth refresh and persistence to Pi", async () => {
    await saveAuth({ anthropic: { type: "oauth", access: "old-access", refresh: "fake-refresh", expires: 0 } });
    const refreshed: Credential = { type: "oauth", access: "refreshed-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 };
    let refresh!: ReturnType<typeof vi.fn>;
    configureRuntime = (value) => {
      const oauth = value.getProvider("anthropic")!.auth.oauth!;
      refresh = vi.spyOn(oauth, "refresh").mockResolvedValue(refreshed);
      vi.spyOn(oauth, "toAuth").mockImplementation(async (credential) => ({ apiKey: credential.access }));
    };
    const result = await resolveModel(selection, signal());
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.secrets).toContain("refreshed-access");
    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8")).anthropic).toEqual(refreshed);
  });

  it("keeps the credential list live as Pi reauthenticates between model turns", async () => {
    await saveAuth({ anthropic: { type: "api_key", key: "before-rotation" } });
    const result = await resolveModel(selection, signal());
    const liveSecrets = result.secrets;
    const provider = runtime.getProvider("anthropic")!;
    const message: AssistantMessage = {
      role: "assistant", api: result.model.api, provider: "anthropic", model: selection.model,
      content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const providerStream = vi.spyOn(provider, "streamSimple").mockImplementation(() => {
      const stream = createAssistantMessageEventStream(); stream.end(message); return stream;
    });
    await saveAuth({ anthropic: { type: "api_key", key: "after-rotation", env: { AWS_SECRET_ACCESS_KEY: "scoped-secret", AWS_REGION: "region-not-a-secret" } } });
    const requestSignal = signal();
    const stream = await result.streamFn(result.model, { messages: [] }, { signal: requestSignal, reasoning: "high" });
    expect(await stream.result()).toEqual(message);
    expect(providerStream).toHaveBeenCalledWith(expect.objectContaining({ id: selection.model }), { messages: [] }, expect.objectContaining({ apiKey: "after-rotation", signal: requestSignal, reasoning: "high" }));
    expect(providerStream.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
    expect(result.secrets).toBe(liveSecrets);
    expect(liveSecrets).toEqual(expect.arrayContaining(["before-rotation", "after-rotation", "scoped-secret"]));
    expect(liveSecrets).not.toContain("region-not-a-secret");
  });

  it("does not replace OAuth with a resolved API key in stream options", async () => {
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockResolvedValue({ auth: { apiKey: "oauth-token", baseUrl: "https://tenant.invalid" }, source: "OAuth" });
    const result = await resolveModel(selection, signal());
    const fakeStream = createAssistantMessageEventStream();
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(fakeStream);
    result.streamFn(result.model, { messages: [] });
    expect(stream).toHaveBeenCalledWith(result.model, { messages: [] }, expect.objectContaining({ apiKey: undefined }));
  });

  it.each([undefined, 2048])("only sends an application output-token override when explicitly set (%s)", async maxTokens => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
    const result = await resolveModel({ ...selection, ...(maxTokens === undefined ? {} : { maxTokens }) }, signal());
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    result.streamFn(result.model, { messages: [] });
    if (maxTokens === undefined) expect(stream.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
    else expect(stream.mock.calls[0]?.[2]?.maxTokens).toBe(maxTokens);
    // Pi's finite capacity metadata is still valid; unlimited task usage does
    // not imply a physically infinite model context or response.
    expect(result.model.maxTokens).toBeGreaterThan(0);
    expect(result.model.contextWindow).toBeGreaterThan(0);
  });

  it("adds the active Agent session header to OpenCode Go while preserving unrelated headers", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const result = await resolveModel({ provider: "opencode-go", model: "deepseek-flash", api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go", apiKeyEnv: "XLOOM_TEST_KEY" }, signal());
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    const headers = { "x-user-header": "preserve-me", "X-OpenCode-Session": "obsolete-session" };
    result.streamFn(result.model, { messages: [] }, { sessionId: "chat-stable-id", headers });
    result.streamFn(result.model, { messages: [] }, { sessionId: "chat-stable-id", headers });
    result.streamFn(result.model, { messages: [] }, { sessionId: "next-agent-run", headers });
    expect(stream.mock.calls.map(call => call[2]?.headers)).toEqual([
      { "x-user-header": "preserve-me", "x-opencode-session": "chat-stable-id" },
      { "x-user-header": "preserve-me", "x-opencode-session": "chat-stable-id" },
      { "x-user-header": "preserve-me", "x-opencode-session": "next-agent-run" },
    ]);
    expect(headers).toEqual({ "x-user-header": "preserve-me", "X-OpenCode-Session": "obsolete-session" });
    expect(result.model).toMatchObject({ id: "deepseek-flash", api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" });
  });

  it.each(["https://opencode.ai/zen/go/", "https://opencode.ai/zen/go/v1"])("uses a stable resolver-local fallback session for %s", async baseUrl => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const config = { provider: "opencode-go", model: "deepseek-flash", api: "anthropic-messages" as const, baseUrl, apiKeyEnv: "XLOOM_TEST_KEY" };
    const result = await resolveModel(config, signal());
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    result.streamFn(result.model, { messages: [] });
    result.streamFn(result.model, { messages: [] }, { headers: { "x-extra": "retained" } });
    const first = stream.mock.calls[0]?.[2]?.headers?.["x-opencode-session"];
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(stream.mock.calls[1]?.[2]?.headers).toEqual({ "x-extra": "retained", "x-opencode-session": first });
    const independent = await resolveModel(config, signal());
    const otherStream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    independent.streamFn(independent.model, { messages: [] });
    expect(otherStream.mock.calls[0]?.[2]?.headers?.["x-opencode-session"]).not.toBe(first);
  });

  it.each([
    ["custom-go", "https://opencode.ai/zen/go"],
    ["opencode-go", "https://proxy.example.invalid/zen/go"],
    ["opencode-go", "https://opencode.ai.example.invalid/zen/go"],
    ["opencode-go", "https://opencode.ai/zen/gopher"],
    ["opencode-go", "https://opencode.ai/zen/v1"],
    ["opencode-go", "http://opencode.ai/zen/go"],
    ["opencode-go", "https://opencode.ai:8443/zen/go"],
  ])("does not add the Go header to provider %s at %s", async (provider, baseUrl) => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const result = await resolveModel({ provider, model: "custom-model", api: "anthropic-messages", baseUrl, apiKeyEnv: "XLOOM_TEST_KEY" }, signal());
    const stream = vi.spyOn(runtime, "streamSimple").mockReturnValue(createAssistantMessageEventStream());
    const headers = { "x-custom": "keep" };
    result.streamFn(result.model, { messages: [] }, { sessionId: "unused-session", headers });
    expect(stream.mock.calls[0]?.[2]?.headers).toEqual(headers);
    expect(stream.mock.calls[0]?.[2]?.headers).not.toHaveProperty("x-opencode-session");
  });

  it("does not fall back to an environment key when Pi OAuth refresh fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-environment-key");
    await saveAuth({ anthropic: { type: "oauth", access: "expired-access", refresh: "invalid-refresh", expires: 0 } });
    configureRuntime = (value) => vi.spyOn(value.getProvider("anthropic")!.auth.oauth!, "refresh").mockRejectedValue(new Error("refresh diagnostic with invalid-refresh"));
    await expect(resolveModel(selection, signal())).rejects.toThrow("Xloom could not resolve credentials for anthropic; use /login anthropic to configure authentication.");
  });

  it.each(getApiProviders().map((provider) => provider.api))("routes inline %s through Pi's registry", async (api) => {
    vi.stubEnv("XLOOM_TEST_KEY", "local-placeholder");
    const result = await resolveModel({ provider: "local-test", model: "local", api, baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "XLOOM_TEST_KEY" }, signal());
    expect(result.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(result.model.api).toBe(api);
    expect(result.costKnown).toBe(false);
    expect(runtime.refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: false }));
  });

  it("keeps models.json model metadata, provider headers and custom auth", async () => {
    vi.stubEnv("XLOOM_TEST_KEY", "custom-config-key");
    await saveModels({ "custom-google": {
      api: "google-generative-ai", baseUrl: "https://example.invalid/v1beta", apiKey: "$XLOOM_TEST_KEY", headers: { "x-test-auth": "custom-header-secret" },
      models: [{ id: "custom-gemma", input: ["text", "image"], reasoning: true, thinkingLevelMap: { high: "high", max: "max" }, contextWindow: 262144, maxTokens: 32768,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } });
    const result = await resolveModel({ provider: "custom-google", model: "custom-gemma" }, signal());
    expect(result.model).toMatchObject({ api: "google-generative-ai", input: ["text", "image"], contextWindow: 262144, maxTokens: 32768, thinkingLevelMap: { max: "max" } });
    expect(result.secrets).toEqual(expect.arrayContaining(["custom-config-key", "custom-header-secret"]));
    expect(result.costKnown).toBe(true);
  });

  it("supports models.json custom providers with credentials only in auth.json", async () => {
    await saveModels({ "custom-local": { api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "local", compat: { supportsDeveloperRole: false } }] } });
    await saveAuth({ "custom-local": { type: "api_key", key: "local-placeholder" } });
    const result = await resolveModel({ provider: "custom-local", model: "local" }, signal());
    expect(result.model.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(result.secrets).toContain("local-placeholder");
  });

  it("discovers a missing model only through the selected known Pi provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    configureRuntime = (value) => {
      const original = value.getModel.bind(value);
      let discovered = false;
      vi.spyOn(value, "getModel").mockImplementation((provider, model) => provider === "anthropic" && model === "dynamic-model" && discovered
        ? { ...original("anthropic", selection.model)!, id: "dynamic-model" } : original(provider, model));
      vi.mocked(value.refresh).mockImplementation(async () => { discovered = true; return { aborted: false, errors: new Map() }; });
    };
    const requestSignal = signal();
    const result = await resolveModel({ provider: "anthropic", model: "dynamic-model" }, requestSignal);
    expect(result.model.id).toBe("dynamic-model");
    expect(runtime.refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["anthropic"], allowNetwork: true, signal: requestSignal });
  });

  it("honors PI_OFFLINE when a model is missing", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Unknown Xloom model");
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("reports metadata refresh failures without leaking provider diagnostics", async () => {
    configureRuntime = (value) => vi.mocked(value.refresh).mockResolvedValue({ aborted: false, errors: new Map([["anthropic", new Error("metadata secret-value")]]) });
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Xloom could not refresh the model catalog for anthropic.");
  });

  it("sanitizes thrown catalog and initialization errors before a model is returned", async () => {
    configureRuntime = (value) => vi.mocked(value.refresh).mockRejectedValue(new Error("unsafe key literal"));
    await expect(resolveModel({ provider: "anthropic", model: "unknown" }, signal())).rejects.toThrow("Xloom could not refresh the model catalog for anthropic.");
    vi.mocked(ModelRuntime.create).mockRejectedValueOnce(new Error("unsafe configuration literal"));
    await expect(listModels()).rejects.toThrow("Xloom model runtime could not be initialized; check the local configuration.");
  });

  it("lists the same local built-in and custom registry without resolving auth", async () => {
    await saveModels({ local: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", apiKey: "!must-not-run", models: [{ id: "my-model" }] } });
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockRejectedValue(new Error("must not resolve auth while listing"));
    const listed = await listModels("local");
    expect(listed.map((model) => model.id)).toEqual(["my-model"]);
    expect(runtime.getAuth).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
    expect((await listModels()).some((model) => model.id === selection.model)).toBe(true);
  });

  it("fails early for missing explicit credentials and unknown providers", async () => {
    await expect(resolveModel({ provider: "test", model: "test", apiKeyEnv: "XLOOM_TEST_KEY" }, signal())).rejects.toThrow("Missing model credential");
    expect(ModelRuntime.create).not.toHaveBeenCalled();
    await expect(resolveModel({ provider: "test", model: "test" }, signal())).rejects.toThrow("Unknown Xloom model");
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it.each([
    selection,
    { provider: "opencode", model: "deepseek-v4-flash" },
    { provider: "openai-codex", model: "gpt-5.4" },
  ])("directs missing $provider credentials to its supported Xloom authentication method", async config => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    const guidance = `use /login ${config.provider} to configure authentication`;
    await expect(resolveModel(config, signal())).rejects.toMatchObject({
      message: `Xloom has no credentials configured for ${config.provider}; ${guidance}, then /model to select a model.`,
    });
  });

  it("does not silently fall back if models.json is invalid", async () => {
    await writeFile(join(directory, "models.json"), '{"secret-config-value":');
    await expect(resolveModel(selection, signal())).rejects.toThrow("Xloom model configuration could not be loaded");
  });

  it("rejects APIs not supported by the installed Pi runtime", async () => {
    await expect(resolveModel({ provider: "local", model: "local", api: "not-an-api", baseUrl: "http://localhost/v1" }, signal())).rejects.toThrow("No Xloom API provider registered");
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects incomplete inline models", async () => {
    await expect(resolveModel({ provider: "local", model: "local", api: "openai-completions" }, signal())).rejects.toThrow("Custom models require api and baseUrl");
  });

  it("rejects credentials embedded in a configured URL", async () => {
    for (const baseUrl of ["not-a-url", "https://user:password@example.invalid/v1", "https://example.invalid/v1?api_key=secret", "https://example.invalid/v1#secret", "file:///model"]) {
      await expect(resolveModel({ provider: "test", model: "test", api: "openai-completions", baseUrl }, signal())).rejects.toThrow("without credentials");
    }
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("propagates cancellation before any runtime or credential read", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(resolveModel(selection, controller.signal)).rejects.toThrow();
    await expect(listModels(undefined, controller.signal)).rejects.toThrow();
    expect(ModelRuntime.create).not.toHaveBeenCalled();
  });

  it("propagates cancellation during credential resolution instead of returning a usable model", async () => {
    const controller = new AbortController();
    configureRuntime = (value) => vi.spyOn(value, "getAuth").mockImplementation(async () => {
      controller.abort(); return { auth: { apiKey: "cancelled-key" } };
    });
    await expect(resolveModel(selection, controller.signal)).rejects.toThrow();
  });
});
