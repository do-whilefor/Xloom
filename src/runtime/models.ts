import { randomUUID } from "node:crypto";
import type { Model, Api, AuthResult } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, type ModelRuntimeAuthOverrides } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelConfig } from "../types.js";
import { modelRuntimePaths } from "./storage.js";

export interface ResolvedModel {
  model: Model<Api>;
  streamFn: StreamFn;
  /** Live collection: Pi may refresh OAuth or resolve command-backed keys between turns. */
  secrets?: string[];
  costKnown?: boolean;
}
export type ModelResolver = (config: ModelConfig, signal: AbortSignal) => Promise<ResolvedModel>;

/** `max` means the highest level advertised by Pi for this model, not a literal
 * effort string to send to every provider. Capability is independent of off/on. */
export function modelThinkingLevel(model: Model<Api>, requested: ModelConfig["thinking"] = "max") {
  return clampThinkingLevel(model, requested);
}

function checkConfiguration(runtime: ModelRuntime): void {
  // Pi's detailed validation errors can contain configured header/key literals.
  if (runtime.getError()) throw new Error("Xloom model configuration could not be loaded; check the local models.json and API-key configuration.");
}

async function createRuntime(signal?: AbortSignal): Promise<ModelRuntime> {
  signal?.throwIfAborted();
  // Pi owns auth.json, models.json, environment lookup, cached catalogs and OAuth refresh.
  const runtime = await piOperation(() => ModelRuntime.create({ ...modelRuntimePaths(), allowModelNetwork: false, signal }), signal,
    "Xloom model runtime could not be initialized; check the local configuration.");
  signal?.throwIfAborted();
  checkConfiguration(runtime);
  return runtime;
}

/** Local catalogs only. Pi checks configured auth availability, without OAuth refresh or key commands. */
export async function listModels(provider?: string, signal?: AbortSignal): Promise<readonly Model<Api>[]> {
  const runtime = await createRuntime(signal);
  return runtime.getModels(provider);
}

async function piOperation<T>(operation: () => Promise<T> | T, signal: AbortSignal | undefined, error: string): Promise<T> {
  try { return await operation(); } catch {
    signal?.throwIfAborted();
    throw new Error(error);
  }
}

function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("Model baseUrl must be an HTTP(S) URL without credentials or query parameters."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Model baseUrl must be an HTTP(S) URL without credentials or query parameters.");
  }
}

function requiresOpenCodeSession(model: Model<Api>): boolean {
  if (model.provider !== "opencode-go") return false;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === "https://opencode.ai" && /^\/zen\/go(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

function credentialSetup(provider: string): string {
  return `use /login ${provider} to configure authentication`;
}

function trackCredentials(runtime: ModelRuntime, secrets: string[]): void {
  const remember = (auth: AuthResult | undefined) => {
    const values = [auth?.auth.apiKey, ...Object.values(auth?.auth.headers ?? {}),
      ...Object.entries(auth?.env ?? {}).filter(([name]) => /key|token|secret|credential/i.test(name)).map(([, value]) => value)];
    for (const value of values) {
      if (typeof value !== "string" || !value.length) continue;
      for (const secret of [value, /^Bearer\s+(.+)$/i.exec(value)?.[1]]) {
        if (secret && !secrets.includes(secret)) secrets.push(secret);
      }
    }
    return auth;
  };
  const original = runtime.getAuth.bind(runtime);
  // Observe Pi's request-time auth; do not freeze a resolved token into stream options.
  runtime.getAuth = async (providerOrModel: string | Model<Api>, overrides?: ModelRuntimeAuthOverrides) => {
    const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    return remember(await piOperation(
      () => typeof providerOrModel === "string" ? original(providerOrModel, overrides) : original(providerOrModel, overrides),
      overrides?.signal, `Xloom could not resolve credentials for ${provider}; ${credentialSetup(provider)}.`));
  };
}

export const resolveModel: ModelResolver = async (config, signal) => {
  signal.throwIfAborted();
  const explicitKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !explicitKey) throw new Error(`Xloom: Missing model credential environment variable: ${config.apiKeyEnv}; ${credentialSetup(config.provider)}.`);
  if (config.baseUrl) validateBaseUrl(config.baseUrl);
  if (config.api && !getApiProvider(config.api)) throw new Error(`No Xloom API provider registered for api: ${config.api}`);
  const runtime = await createRuntime(signal);
  let registered = runtime.getModel(config.provider, config.model);

  if (config.api || config.baseUrl) {
    const api = config.api ?? registered?.api;
    const baseUrl = config.baseUrl ?? registered?.baseUrl;
    if (!api || !baseUrl) throw new Error("Custom models require api and baseUrl, or an existing Xloom model supplying these defaults.");
    // Legacy inline settings are an in-memory Pi provider overlay, not another API implementation.
    await piOperation(() => runtime.registerProvider(config.provider, {
      api, baseUrl,
      models: [{
        ...(registered ?? {}), id: config.model, name: registered?.name ?? config.model, api, baseUrl,
        // Inline endpoints opt into reasoning by default. Known non-reasoning
        // models retain their metadata; an explicit capability override wins.
        reasoning: config.reasoning ?? registered?.reasoning ?? true,
        input: registered?.input ?? ["text"],
        contextWindow: config.contextWindow ?? registered?.contextWindow ?? 128_000,
        maxTokens: config.maxTokens ?? registered?.maxTokens ?? 16_384,
        cost: registered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    }), signal, `Xloom could not configure the inline provider ${config.provider}.`);
    await piOperation(() => runtime.refresh({ allowNetwork: false, signal }), signal, `Xloom could not refresh the inline provider ${config.provider}.`);
    signal.throwIfAborted();
    checkConfiguration(runtime);
    registered = runtime.getModel(config.provider, config.model);
  } else if (!registered && runtime.getProvider(config.provider) && process.env.PI_OFFLINE === undefined) {
    // Dynamic Pi providers may have no static catalog. Only that known provider may discover models.
    if (explicitKey) await piOperation(() => runtime.setRuntimeApiKey(config.provider, explicitKey, { signal }), signal,
      `Xloom could not configure credentials for ${config.provider}; ${credentialSetup(config.provider)}.`);
    const result = await piOperation(() => runtime.refresh({ providers: [config.provider], allowNetwork: true, signal }), signal,
      `Xloom could not refresh the model catalog for ${config.provider}.`);
    signal.throwIfAborted();
    if (result.errors.has(config.provider)) throw new Error(`Xloom could not refresh the model catalog for ${config.provider}.`);
    checkConfiguration(runtime);
    registered = runtime.getModel(config.provider, config.model);
  }
  if (!registered) throw new Error(`Unknown Xloom model ${config.provider}/${config.model}; configure a provider with /login, then use /model to select a model.`);

  const secrets = explicitKey ? [explicitKey] : [];
  trackCredentials(runtime, secrets);
  const model: Model<Api> = { ...registered, reasoning: config.reasoning ?? registered.reasoning,
    contextWindow: config.contextWindow ?? registered.contextWindow, maxTokens: config.maxTokens ?? registered.maxTokens };
  const auth = await runtime.getAuth(model, { apiKey: explicitKey, signal });
  signal.throwIfAborted();
  if (!auth) throw new Error(`Xloom has no credentials configured for ${config.provider}; ${credentialSetup(config.provider)}, then /model to select a model.`);
  const builtin = builtinModels().getModel(config.provider, config.model);
  const costKnown = !config.baseUrl && (builtin?.baseUrl === model.baseUrl || (!builtin && Object.values(model.cost).some((value) => typeof value === "number" && value > 0)));
  const fallbackSessionId = randomUUID();
  return {
    model, secrets, costKnown,
    streamFn: (selected, context, options) => runtime.streamSimple(selected, context, {
      ...options,
      // Covers direct calls and context summaries as well as the Agent loop.
      reasoning: (() => {
        const level = modelThinkingLevel(selected, options?.reasoning ?? config.thinking);
        return level === "off" ? undefined : level;
      })(),
      // Go requires a session header that Pi 0.84.4 does not supply itself.
      // Agent session IDs stay stable across chat turns; direct calls get a local fallback.
      ...(requiresOpenCodeSession(selected) ? { headers: {
        ...Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([key]) => key.toLowerCase() !== "x-opencode-session")),
        "x-opencode-session": options?.sessionId || fallbackSessionId,
      } } : {}),
      // Leave per-response sizing to Pi/provider defaults unless the user
      // explicitly configures an override. Model capacity is not a run budget.
      apiKey: explicitKey,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    }),
  };
};
