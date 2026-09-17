import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryModelsStore, type AuthInteraction, type Credential } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsService, type SettingsRuntime } from "../src/runtime/settings.js";
import { resolveModel } from "../src/runtime/models.js";

let directory: string;
let service: SettingsService;
let configure: ((runtime: ModelRuntime) => void) | undefined;
const unrelated: Credential = { type: "oauth", access: "unrelated-test-access", refresh: "unrelated-test-refresh", expires: Date.now() + 3_600_000 };
const readAuth = async () => JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
const createRuntime = async (signal?: AbortSignal) => {
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, signal });
  configure?.(runtime);
  return runtime;
};
const apiLogin = (settings: SettingsService, provider: string, key: string, signal?: AbortSignal) => settings.login(provider, {
  signal, notify() {}, prompt: async prompt => prompt.type === "select" ? "bearer-token" : key,
}, "api_key");
const interaction = (): AuthInteraction => ({ prompt: vi.fn(async () => "test-code"), notify: vi.fn() });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "xloom-settings-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENCODE_API_KEY", "DEEPSEEK_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"]) vi.stubEnv(name, undefined);
  configure = undefined;
  service = new SettingsService(createRuntime);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Pi settings service", () => {
  it("reads local alias capacity without resolving command-backed credentials or making a network request", async () => {
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { "fixture-alias": { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      apiKey: "!header-must-not-execute-this-credential-command", models: [{ id: "local-model", contextWindow: 1_048_576, maxTokens: 8192 }] } } }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Header must not use the network"));
    let getAuth!: ReturnType<typeof vi.spyOn>;
    const metadata = new SettingsService(async signal => {
      const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath,
        modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, signal });
      getAuth = vi.spyOn(runtime, "getAuth");
      return runtime;
    });
    expect(await metadata.describeModel({ provider: "fixture-alias", model: "local-model" })).toEqual({ contextWindow: 1_048_576, authLabel: "API Key" });
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors explicit context and environment credentials over a stored subscription", async () => {
    configure = runtime => {
      vi.spyOn(runtime, "isUsingSubscription").mockReturnValue(true);
      vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(true);
    };
    vi.stubEnv("HEADER_FIXTURE_KEY", "synthetic-private-key");
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias", contextWindow: 200_000, apiKeyEnv: "HEADER_FIXTURE_KEY" }))
      .toEqual({ contextWindow: 200_000, authLabel: "API Key" });
    vi.stubEnv("HEADER_FIXTURE_KEY", undefined);
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias", apiKeyEnv: "HEADER_FIXTURE_KEY" })).toEqual({ authLabel: "未配置认证" });
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias" })).toEqual({ authLabel: "Subscription" });
  });

  it("describes OAuth without claiming subscription billing and tolerates unknown model capacity", async () => {
    configure = runtime => {
      vi.spyOn(runtime, "isUsingSubscription").mockReturnValue(false);
      vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(true);
    };
    expect(await service.describeModel({ provider: "anthropic", model: "missing-alias" })).toEqual({ authLabel: "OAuth" });
  });

  it("cancels optional metadata reads and does not expose configuration errors", async () => {
    const controller = new AbortController(); controller.abort();
    const factory = vi.fn(createRuntime);
    await expect(new SettingsService(factory).describeModel({ provider: "anthropic", model: "missing" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
    const invalid = new SettingsService(async () => { throw new Error("secret-runtime-value"); });
    await expect(invalid.describeModel({ provider: "anthropic", model: "missing" })).rejects.not.toThrow("secret-runtime-value");
  });

  it("lists only configured providers without resolving credentials or contacting the network", async () => {
    await apiLogin(service, "opencode-go", "test-settings-key");
    let getAuth!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => { getAuth = vi.spyOn(runtime, "getAuth"); };
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Catalog must stay local"));
    const choices = await service.listModels();
    expect(choices).toContainEqual({ provider: "opencode-go", model: "deepseek-v4-flash", name: expect.any(String) });
    expect(choices.some(model => ["opencode", "amazon-bedrock", "deepseek"].includes(model.provider))).toBe(false);
    expect(Object.keys(choices[0]).sort()).toEqual(["model", "name", "provider"]);
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes selectable models after saving and removing keys for distinct providers", async () => {
    for (const provider of ["opencode-go", "opencode", "deepseek"]) {
      await apiLogin(service, provider, `synthetic-${provider}-key`);
      expect((await service.listModels()).some(model => model.provider === provider)).toBe(true);
    }
    await service.logout("opencode");
    const models = await service.listModels();
    expect(models.some(model => model.provider === "opencode")).toBe(false);
    expect(models.some(model => model.provider === "opencode-go")).toBe(true);
    expect(models.some(model => model.provider === "deepseek")).toBe(true);
  });

  it("includes authenticated inline aliases and explicit environment models, but not unauthenticated defaults", async () => {
    vi.stubEnv("ALIAS_KEY_ENV", "synthetic-alias-key");
    const alias = { provider: "fixture-inline", model: "private-alias", api: "anthropic-messages", baseUrl: "https://fixture.invalid/api", apiKeyEnv: "ALIAS_KEY_ENV" };
    const choices = await service.listModels([
      alias,
      { provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ALIAS_KEY_ENV" },
      { provider: "amazon-bedrock", model: "minimax.minimax-m2.5" },
      { ...alias, model: "missing-key", apiKeyEnv: "MISSING_ALIAS_KEY_ENV" },
      { ...alias, model: "missing-endpoint", baseUrl: undefined },
    ]);
    expect(choices).toContainEqual({ provider: alias.provider, model: alias.model, name: alias.model });
    expect(choices).toContainEqual({ provider: "anthropic", model: "claude-sonnet-4-6", name: expect.any(String) });
    expect(choices.some(model => ["minimax.minimax-m2.5", "missing-key", "missing-endpoint"].includes(model.model))).toBe(false);
  });

  it("does not offer a model whose explicit key override is missing even when its provider has a stored key", async () => {
    await apiLogin(service, "anthropic", "test-settings-key");
    vi.stubEnv("MISSING_MODEL_KEY", undefined);
    const config = { provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "MISSING_MODEL_KEY" };
    expect((await service.listModels([config])).some(model => model.provider === config.provider && model.model === config.model)).toBe(false);
    expect((await service.listModels()).some(model => model.provider === config.provider && model.model === config.model)).toBe(true);
  });

  it.each(["opencode-go", "opencode", "deepseek", "anthropic", "openai", "google", "amazon-bedrock"])("uses the %s key saved by /login when resolving a selected model in a fresh runtime", async provider => {
    vi.stubEnv("XLOOM_HOME", directory);
    const settings = new SettingsService();
    const key = `synthetic-${provider}-key`;
    await apiLogin(settings, provider, key);
    const choice = (await settings.listModels()).find(model => model.provider === provider)!;
    expect(choice).toBeDefined();
    const selected = await resolveModel(choice, new AbortController().signal);
    expect(selected.model).toMatchObject({ provider, id: choice.model });
    expect(selected.secrets).toContain(key);
  });

  it("keeps environment credentials and command-backed Pi models available without executing the command", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-env-key");
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      apiKey: "!must-not-execute-this-key-command", models: [{ id: "custom-model" }] } } }));
    const local = new SettingsService(signal => ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath,
      modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, signal }));
    const choices = await local.listModels();
    expect(choices.some(model => model.provider === "deepseek")).toBe(true);
    expect(choices).toContainEqual({ provider: "local", model: "custom-model", name: "custom-model" });
  });

  it("lists native auth methods including ambient setup; subscription login is oauth", async () => {
    const providers = await service.listProviders();
    expect(providers).toContainEqual({ id: "opencode-go", name: "OpenCode Go", authTypes: ["api_key"], stored: false });
    expect(providers.find((provider) => provider.id === "anthropic")?.authTypes).toEqual(["api_key", "oauth"]);
    expect(providers.find(provider => provider.id === "openai-codex")?.authTypes).toEqual(["oauth"]);
    expect(providers.find(provider => provider.id === "kimi-coding")?.authTypes).toEqual(["api_key", "oauth"]);
    expect(providers.map(provider => provider.name)).toEqual(providers.map(provider => provider.name).sort((a, b) => a.localeCompare(b)));
  });

  it("persists API keys through real Pi login while retaining other provider credentials", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "other-provider": unrelated }));
    await apiLogin(service, "opencode-go", "test-settings-key");
    expect(await readAuth()).toEqual({ "other-provider": unrelated, "opencode-go": { type: "api_key", key: "test-settings-key" } });
    const fresh = await createRuntime();
    expect((await fresh.getAuth("opencode-go"))?.auth.apiKey).toBe("test-settings-key");
  });

  it("preserves Pi credential expressions without custom key rewriting", async () => {
    vi.stubEnv("XLOOM_TEST_NATIVE_KEY", "resolved-native-key");
    await apiLogin(service, "opencode-go", "${XLOOM_TEST_NATIVE_KEY}");
    expect((await readAuth())["opencode-go"].key).toBe("${XLOOM_TEST_NATIVE_KEY}");
    expect((await (await createRuntime()).getAuth("opencode-go"))?.auth.apiKey).toBe("resolved-native-key");
  });

  it("replaces only the selected provider credential on API-key save", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ anthropic: unrelated, "opencode-go": { type: "api_key", key: "old-test-key" } }));
    await apiLogin(service, "opencode-go", "new-test-key");
    expect((await readAuth()).anthropic).toEqual(unrelated);
    expect((await readAuth())["opencode-go"].key).toBe("new-test-key");
  });

  it("replaces the old key without backups and reuses the new key in existing and fresh runtimes through /login", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "OLD_AMBIENT_KEY");
    await writeFile(join(directory, "auth.json"), JSON.stringify({ anthropic: unrelated,
      "opencode-go": { type: "api_key", key: "OLD_PERSISTED_KEY" } }));
    const existing = await createRuntime();
    expect((await existing.getAuth("opencode-go"))?.auth.apiKey).toBe("OLD_PERSISTED_KEY");
    await service.login("opencode-go", { ...interaction(), prompt: async () => "NEW_PERSISTED_KEY" }, "api_key");
    expect(await readAuth()).toEqual({ anthropic: unrelated, "opencode-go": { type: "api_key", key: "NEW_PERSISTED_KEY" } });
    expect(await readdir(directory)).toEqual(["auth.json"]);
    expect((await existing.getAuth("opencode-go"))?.auth.apiKey).toBe("NEW_PERSISTED_KEY");
    expect((await (await createRuntime()).getAuth("opencode-go"))?.auth.apiKey).toBe("NEW_PERSISTED_KEY");
    expect((await service.listProviders()).find(provider => provider.id === "opencode-go")?.stored).toBe(true);
  });

  it.each(["anthropic", "kimi-coding"])("discards an old OAuth credential when %s is switched to an API key", async provider => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ [provider]: unrelated }));
    await service.login(provider, { ...interaction(), prompt: async () => "new-key" }, "api_key");
    expect(await readAuth()).toEqual({ [provider]: { type: "api_key", key: "new-key" } });
    expect(await readdir(directory)).toEqual(["auth.json"]);
  });

  it("supports the native provider-owned API-key options", async () => {
    const key = "native-bedrock-key";
    const prompt = vi.fn(async (prompt: { type: string }) => prompt.type === "select" ? "bearer-token" : key);
    await service.login("amazon-bedrock", { ...interaction(), prompt }, "api_key");
    expect(prompt.mock.calls.map(([prompt]) => prompt.type)).toEqual(["select", "secret"]);
    expect((await (await createRuntime()).getAuth("amazon-bedrock"))?.auth.apiKey).toBe(key);
  });

  it.each(["cancelled", "failed"])("retains the old key when replacement is %s before persistence", async outcome => {
    await apiLogin(service, "opencode-go", "old-retained-key");
    const control = new AbortController();
    await expect(service.login("opencode-go", { ...interaction(), signal: control.signal, prompt: async () => {
      if (outcome === "cancelled") control.abort();
      throw new Error("provider cancelled or failed");
    } }, "api_key")).rejects.toThrow();
    expect((await readAuth())["opencode-go"]).toEqual({ type: "api_key", key: "old-retained-key" });
  });

  it.each(["openai-codex", "kimi-coding"])("stores a %s account login and makes its models selectable", async provider => {
    configure = runtime => {
      vi.spyOn(runtime.getProvider(provider)!.auth.oauth!, "login").mockResolvedValue(unrelated as Extract<Credential, { type: "oauth" }>);
    };
    await service.login(provider, interaction());
    expect((await readAuth())[provider]).toEqual(unrelated);
    expect((await service.listModels()).some(model => model.provider === provider)).toBe(true);
    await service.logout(provider);
    expect((await readAuth())[provider]).toBeUndefined();
  });

  it("uses the actual provider OAuth flow and delegates all callbacks", async () => {
    const callbacks = interaction();
    configure = (runtime) => {
      vi.spyOn(runtime.getProvider("anthropic")!.auth.oauth!, "login").mockImplementation(async (passed) => {
        passed.notify({ type: "auth_url", url: "https://login.example.invalid/authorize" });
        expect(await passed.prompt({ type: "manual_code", message: "Paste callback code" })).toBe("test-code");
        return { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000 };
      });
    };
    await service.login("anthropic", callbacks);
    expect(callbacks.notify).toHaveBeenCalledWith({ type: "auth_url", url: "https://login.example.invalid/authorize" });
    expect((await readAuth()).anthropic).toMatchObject({ type: "oauth", access: "test-access", refresh: "test-refresh" });
  });

  it("does not call API-key login as a substitute for browser login", async () => {
    let login!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => { login = vi.spyOn(runtime, "login"); };
    await expect(service.login("opencode-go", interaction())).rejects.toThrow("This Xloom provider does not support the requested authentication method; use /login to select a supported method.");
    expect(login).not.toHaveBeenCalled();
  });

  it("removes only the selected provider and does not clear environment credentials", async () => {
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "other-provider": unrelated, "opencode-go": { type: "api_key", key: "stored-test-key" } }));
    vi.stubEnv("OPENCODE_API_KEY", "ambient-test-key");
    await service.logout("opencode-go");
    expect(await readAuth()).toEqual({ "other-provider": unrelated });
    expect(process.env.OPENCODE_API_KEY).toBe("ambient-test-key");
  });

  it("passes API-key interactions to Pi unchanged, including provider-owned additional prompts", async () => {
    const callbacks = interaction();
    callbacks.prompt = vi.fn(async prompt => prompt.type === "secret" ? "  ${NATIVE_KEY}  " : "account-id");
    configure = runtime => {
      vi.spyOn(runtime.getProvider("opencode-go")!.auth.apiKey!, "login").mockImplementation(async passed => {
        expect(await passed.prompt({ type: "secret", message: "API key" })).toBe("  ${NATIVE_KEY}  ");
        expect(await passed.prompt({ type: "text", message: "Account id" })).toBe("account-id");
        return { type: "api_key", key: "provider-result" };
      });
      const login = runtime.login.bind(runtime);
      vi.spyOn(runtime, "login").mockImplementation(async (provider, type, interaction) => {
        expect(interaction).toBe(callbacks);
        await login(provider, type, interaction);
      });
    };
    await service.login("opencode-go", callbacks, "api_key");
    expect((await readAuth())["opencode-go"].key).toBe("provider-result");
  });

  it("lists stored credentials for logout even when their provider no longer exists", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "ambient-only-key");
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "removed-provider": unrelated }));
    expect(await service.listProviders("logout")).toEqual([{ id: "removed-provider", name: "removed-provider", authTypes: ["oauth"], stored: true }]);
  });

  it("exposes native ambient setup and provider-specific login labels", async () => {
    configure = runtime => {
      const providers = runtime.getProviders().map(provider => provider.id === "openai"
        ? { ...provider, auth: { ...provider.auth, apiKey: { ...provider.auth.apiKey!, login: undefined } } }
        : provider.id === "anthropic" ? { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!, loginLabel: "Native account label" } } } : provider);
      vi.spyOn(runtime, "getProviders").mockReturnValue(providers);
    };
    const providers = await service.listProviders();
    expect(providers.find(provider => provider.id === "openai")).toMatchObject({ authTypes: ["api_key"], ambientAuth: expect.any(String) });
    expect(providers.find(provider => provider.id === "anthropic")?.oauthLabel).toBe("Native account label");
  });

  it("does not echo arbitrary provider names for unsupported credential setup", async () => {
    await expect(apiLogin(service, "fake-secret-provider-id", "test-key")).rejects.toThrow("This Xloom provider does not support the requested authentication method; use /login to select a supported method.");
    await expect(service.login("fake-secret-provider-id", interaction())).rejects.not.toThrow("fake-secret-provider-id");
  });

  it("discards raw runtime errors and validation details", async () => {
    const failed = new SettingsService(async () => { throw new Error("secret-runtime-token"); });
    await expect(failed.listModels()).rejects.toThrow("Xloom settings could not be loaded");
    await expect(failed.listProviders()).rejects.not.toThrow("secret-runtime-token");
    const invalid = new SettingsService(async () => ({ getError: () => "secret-config-token" } as SettingsRuntime));
    await expect(invalid.listModels()).rejects.not.toThrow("secret-config-token");
  });

  it("discards raw provider login and logout errors without attaching a cause", async () => {
    configure = (runtime) => {
      vi.spyOn(runtime, "login").mockRejectedValue(new Error("secret-provider-response"));
      vi.spyOn(runtime, "logout").mockRejectedValue(new Error("secret-provider-response"));
    };
    for (const operation of [() => apiLogin(service, "opencode-go", "test-key"), () => service.login("anthropic", interaction()), () => service.logout("opencode-go")]) {
      const error = await operation().catch((value) => value as Error);
      expect(String(error)).not.toContain("secret-provider-response");
      expect(String(error)).toContain("Xloom");
      expect(String(error)).not.toMatch(/\bPi\b|login flow/);
      expect(error.cause).toBeUndefined();
    }
  });

  it("sanitizes cancellation reasons and avoids starting an already-cancelled login", async () => {
    const controller = new AbortController(); controller.abort("secret-cancellation-reason");
    const factory = vi.fn(createRuntime); const cancelled = new SettingsService(factory);
    await expect(apiLogin(cancelled, "opencode-go", "test-key", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    await expect(cancelled.login("anthropic", { ...interaction(), signal: controller.signal })).rejects.not.toThrow("secret-cancellation-reason");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not create a runtime for already-cancelled logout or expose the cancellation reason", async () => {
    const controller = new AbortController(); controller.abort("secret-logout-cancellation");
    const factory = vi.fn(createRuntime);
    await expect(new SettingsService(factory).logout("opencode-go", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes cancellation into Pi logout and sanitizes a mid-operation abort", async () => {
    const controller = new AbortController();
    let logout!: ReturnType<typeof vi.spyOn>;
    configure = (runtime) => {
      logout = vi.spyOn(runtime, "logout").mockImplementation(async (_provider, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort("secret-logout-response");
        throw controller.signal.reason;
      });
    };
    await expect(service.logout("opencode-go", controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Credential operation cancelled." });
    expect(logout).toHaveBeenCalledWith("opencode-go", { signal: controller.signal });
  });

  it("reports a saved credential separately from a synchronization failure without leaking its value", async () => {
    configure = (runtime) => {
      vi.spyOn(runtime, "login").mockRejectedValue(new CredentialSynchronizationError("opencode-go", "login", { type: "api_key", key: "secret-saved-key" }, { cause: new Error("secret-sync-error") }));
    };
    await expect(apiLogin(service, "opencode-go", "test-key")).rejects.toThrow("Credentials were saved");
    await expect(apiLogin(service, "opencode-go", "test-key")).rejects.not.toThrow("secret-");
  });
});
