import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "../types.js";
import { modelRuntimePaths } from "./storage.js";

export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type SettingsRuntime = Pick<ModelRuntime, "getError" | "getAvailableSnapshot" | "getModel" | "getProviders" | "getProvider" | "getProviderAuthStatus" | "isUsingOAuth" | "isUsingSubscription" | "listCredentials" | "login" | "logout">;
export type SettingsRuntimeFactory = (signal?: AbortSignal) => Promise<SettingsRuntime>;

export interface ModelChoice { provider: string; model: string; name: string }
export interface ProviderChoice { id: string; name: string; authTypes: string[]; stored?: boolean; oauthLabel?: string; ambientAuth?: string }
export interface ModelDisplayInfo { contextWindow?: number; authLabel?: string }

const createRuntime: SettingsRuntimeFactory = (signal) => ModelRuntime.create({ ...modelRuntimePaths(), allowModelNetwork: false, signal });

function checkCancellation(signal?: AbortSignal): void {
  // Abort reasons may include provider responses or pasted credentials too.
  if (signal?.aborted) throw new DOMException("Credential operation cancelled.", "AbortError");
}

/** Local Pi catalog and provider-owned credential flows; no model or extension execution. */
export class SettingsService {
  constructor(private readonly runtimeFactory: SettingsRuntimeFactory = createRuntime) {}

  private async runtime(signal?: AbortSignal): Promise<SettingsRuntime> {
    checkCancellation(signal);
    try {
      const runtime = await this.runtimeFactory(signal);
      checkCancellation(signal);
      if (runtime.getError()) throw new Error();
      return runtime;
    } catch {
      checkCancellation(signal);
      throw new Error("Xloom settings could not be loaded; check the local models.json and API-key configuration.");
    }
  }

  async listModels(configured: readonly ModelConfig[] = []): Promise<ModelChoice[]> {
    const runtime = await this.runtime();
    try {
      // Pi's availability snapshot checks local auth without resolving keys or calling providers.
      const choices = new Map(runtime.getAvailableSnapshot().map(({ provider, id, name }) =>
        [`${provider}\0${id}`, { provider, model: id, name }]));
      for (const config of configured) {
        const registered = runtime.getModel(config.provider, config.model);
        const authenticated = config.apiKeyEnv ? Boolean(process.env[config.apiKeyEnv]) : runtime.getProviderAuthStatus(config.provider).configured;
        const identity = `${config.provider}\0${config.model}`;
        // Inline endpoints and explicit environment keys are Xloom overrides, not Pi catalog entries.
        if ((config.api || config.baseUrl || config.apiKeyEnv) && !authenticated) choices.delete(identity);
        if (authenticated && (registered || (config.api && config.baseUrl))) {
          choices.set(identity, { provider: config.provider, model: config.model, name: registered?.name ?? config.model });
        }
      }
      return [...choices.values()]
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    } catch {
      throw new Error("Xloom model catalog could not be read.");
    }
  }

  /** Display metadata only: local catalog and auth availability, never resolved credentials or billing claims. */
  async describeModel(config: ModelConfig, signal?: AbortSignal): Promise<ModelDisplayInfo> {
    const runtime = await this.runtime(signal);
    try {
      const model = runtime.getModel(config.provider, config.model);
      const contextWindow = config.contextWindow ?? model?.contextWindow;
      const status = runtime.getProviderAuthStatus(config.provider);
      const authLabel = config.apiKeyEnv ? process.env[config.apiKeyEnv] ? "API Key" : "未配置认证"
        : runtime.isUsingSubscription(config.provider) ? "Subscription"
        : runtime.isUsingOAuth(config.provider) ? "OAuth"
        : status.configured ? "API Key" : "未配置认证";
      return { ...(Number.isSafeInteger(contextWindow) && contextWindow! > 0 ? { contextWindow } : {}), authLabel };
    } catch {
      checkCancellation(signal);
      throw new Error("Xloom model display metadata could not be read.");
    }
  }

  async listProviders(mode: "login" | "logout" = "login"): Promise<ProviderChoice[]> {
    const runtime = await this.runtime();
    try {
      if (mode === "logout") {
        return (await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
          .map(({ providerId, type }) => ({ id: providerId, name: runtime.getProvider(providerId)?.name ?? providerId, authTypes: [type], stored: true }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      return runtime.getProviders().map(({ id, name, auth }) => ({
        id, name, authTypes: [auth.apiKey ? "api_key" : undefined, auth.oauth ? "oauth" : undefined]
          .filter((type): type is string => type !== undefined),
        stored: runtime.getProviderAuthStatus(id).source === "stored",
        ...(auth.oauth?.loginLabel ? { oauthLabel: auth.oauth.loginLabel } : {}),
        ...(auth.apiKey && !auth.apiKey.login ? { ambientAuth: auth.apiKey.name } : {}),
      })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw new Error("Xloom provider catalog could not be read.");
    }
  }

  async login(provider: string, interaction: AuthInteraction, type: AuthType = "oauth"): Promise<void> {
    const runtime = await this.runtime(interaction.signal);
    let supported: boolean;
    try {
      const auth = runtime.getProvider(provider)?.auth;
      supported = Boolean((type === "oauth" ? auth?.oauth : auth?.apiKey)?.login);
    }
    catch { throw new Error("Xloom provider configuration could not be read."); }
    if (!supported) throw new Error("This Xloom provider does not support the requested authentication method; use /login to select a supported method.");
    try {
      // Pi owns the full provider flow and replaces the provider's one stored credential.
      await runtime.login(provider, type, interaction);
    } catch (error) {
      checkCancellation(interaction.signal);
      if (error instanceof CredentialSynchronizationError) {
        throw new Error("Credentials were saved, but Xloom could not refresh its local state; restart Xloom and check /model.");
      }
      throw new Error("Xloom authentication did not complete; retry /login with the provider's supported method.");
    }
  }

  async logout(provider: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.runtime(signal);
    try { await runtime.logout(provider, { signal }); }
    catch (error) {
      checkCancellation(signal);
      if (error instanceof CredentialSynchronizationError) {
        throw new Error("Stored credentials were removed, but Xloom could not refresh its local state; restart Xloom.");
      }
      throw new Error("Xloom could not remove the stored credential; check the local credential storage.");
    }
  }
}
