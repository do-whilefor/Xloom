import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "../types.js";
import { modelRuntimePaths } from "./storage.js";

export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type SettingsRuntime = Pick<ModelRuntime, "getError" | "getAvailableSnapshot" | "getModel" | "getProviders" | "getProvider" | "getProviderAuthStatus" | "isUsingOAuth" | "isUsingSubscription" | "login" | "logout">;
export type SettingsRuntimeFactory = (signal?: AbortSignal) => Promise<SettingsRuntime>;

export interface ModelChoice { provider: string; model: string; name: string }
export interface ProviderChoice { id: string; name: string; authTypes: string[] }
export interface ModelDisplayInfo { contextWindow?: number; authLabel?: string }

const createRuntime: SettingsRuntimeFactory = (signal) => ModelRuntime.create({ ...modelRuntimePaths(), allowModelNetwork: false, signal });

function checkCancellation(signal?: AbortSignal): void {
  // Abort reasons may include provider responses or pasted credentials too.
  if (signal?.aborted) throw new DOMException("Credential operation cancelled.", "AbortError");
}

/** Pi auth.json supports commands and environment interpolation; pasted keys are always literals. */
function literalKey(key: string): string {
  const escaped = key.replaceAll("$", () => "$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
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
      throw new Error("Pi settings could not be loaded; check the local models.json and credential configuration.");
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
      throw new Error("Pi model catalog could not be read.");
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
      throw new Error("Pi model display metadata could not be read.");
    }
  }

  async listProviders(): Promise<ProviderChoice[]> {
    const runtime = await this.runtime();
    try {
      return runtime.getProviders().map(({ id, name, auth }) => ({
        id, name, authTypes: [auth.apiKey?.login ? "api_key" : undefined, auth.oauth?.login ? "oauth" : undefined]
          .filter((type): type is string => type !== undefined),
      })).sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      throw new Error("Pi provider catalog could not be read.");
    }
  }

  async saveApiKey(provider: string, key: string, signal?: AbortSignal): Promise<void> {
    checkCancellation(signal);
    const value = key.trim();
    if (!value || /[\r\n\u0000]/u.test(value)) throw new Error("Enter a non-empty, single-line API key.");
    const runtime = await this.runtime(signal);
    let supported: boolean;
    try { supported = Boolean(runtime.getProvider(provider)?.auth.apiKey?.login); }
    catch { throw new Error("Pi provider configuration could not be read."); }
    if (!supported) throw new Error("This Pi provider does not support API-key setup; select another provider or use its Pi login flow.");
    let supplied = false;
    let needsMoreInput = false;
    try {
      await runtime.login(provider, "api_key", {
        signal,
        prompt: async (prompt) => {
          checkCancellation(signal);
          checkCancellation(prompt.signal);
          // /apikey supplies a Bedrock bearer token, so no AWS-profile prompt is needed.
          if (provider === "amazon-bedrock" && !supplied && prompt.type === "select" && prompt.options.some(option => option.id === "bearer-token")) return "bearer-token";
          if (prompt.type !== "secret" || supplied) {
            needsMoreInput = true;
            throw new Error("Additional provider configuration required.");
          }
          supplied = true;
          return literalKey(value);
        },
        // API-key setup must never echo a key or provider response into the transcript.
        notify: () => {},
      });
    } catch (error) {
      checkCancellation(signal);
      if (needsMoreInput) throw new Error("This provider requires additional setup; configure its credentials through Pi first.");
      if (error instanceof CredentialSynchronizationError) {
        throw new Error("The credential was saved, but Pi could not refresh its local state; restart and check the provider configuration.");
      }
      throw new Error("Pi could not save the API key; check the local credential storage and provider configuration.");
    }
  }

  async login(provider: string, interaction: AuthInteraction): Promise<void> {
    const runtime = await this.runtime(interaction.signal);
    let supported: boolean;
    try { supported = Boolean(runtime.getProvider(provider)?.auth.oauth?.login); }
    catch { throw new Error("Pi provider configuration could not be read."); }
    if (!supported) throw new Error("This Pi provider has no browser/subscription login; use API-key setup if available.");
    try {
      // Subscription auth is Pi OAuth too. Callbacks remain owned by the TUI.
      await runtime.login(provider, "oauth", interaction);
    } catch (error) {
      checkCancellation(interaction.signal);
      if (error instanceof CredentialSynchronizationError) {
        throw new Error("Login credentials were saved, but Pi could not refresh its local state; restart and check the provider configuration.");
      }
      throw new Error("Pi login did not complete; retry the login flow or check the provider configuration.");
    }
  }

  async logout(provider: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.runtime(signal);
    try { await runtime.logout(provider, { signal }); }
    catch (error) {
      checkCancellation(signal);
      if (error instanceof CredentialSynchronizationError) {
        throw new Error("Stored credentials were removed, but Pi could not refresh its local state; restart the application.");
      }
      throw new Error("Pi could not remove the stored credential; check the local credential storage.");
    }
  }
}
