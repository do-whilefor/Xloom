import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectConfigSchema, formatValidationError } from "./schema.js";
import type { ProjectConfig } from "./types.js";
import { atomicJson, globalConfigPath } from "./paths.js";

export const CHAT_GOAL = "普通聊天；使用 /run 目标启动独立红队任务";

/** A model registry default, not a model availability check or a network call. */
export function defaultConfig(goal: string, scope = goal): ProjectConfig {
  const model = { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "max" as const };
  return projectConfigSchema.parse({
    version: 1,
    title: "xloom",
    goal,
    scope,
    context: "",
    models: { decide: { ...model }, execute: { ...model } },
    limits: {},
  });
}

const globalSettingsSchema = projectConfigSchema.pick({ version: true, models: true, limits: true, chrome: true });

export function workspaceDefaults(goal: string, scope = goal): ProjectConfig {
  return withGlobalSettings(defaultConfig(goal, scope));
}

/** Global runtime settings override legacy project copies, never task scope/context. */
export function withGlobalSettings(config: ProjectConfig): ProjectConfig {
  const file = globalConfigPath();
  if (!existsSync(file)) return projectConfigSchema.parse(config);
  const settings = globalSettingsSchema.safeParse(readConfigJson(file));
  if (!settings.success) throw new Error(`Invalid Xloom global settings: ${file}`);
  return projectConfigSchema.parse({ ...config, ...settings.data, chrome: settings.data.chrome });
}

export function loadRuntimeConfig(file: string, global = true): ProjectConfig {
  const config = loadConfig(file);
  return global ? withGlobalSettings(config) : config;
}

export function saveGlobalSettings(config: ProjectConfig): void {
  const parsed = projectConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Invalid Xloom settings: ${formatValidationError(parsed.error)}`);
  const { version, models, limits, chrome } = parsed.data;
  atomicJson(globalConfigPath(), { version, models, limits, chrome });
}

export function ensureGlobalSettings(config: ProjectConfig): void {
  const file = globalConfigPath();
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const { version, models, limits, chrome } = config;
  try { writeFileSync(file, `${JSON.stringify({ version, models, limits, chrome }, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function readConfigJson(path: string): unknown {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read xloom configuration at ${path}`, { cause: error });
  }
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in xloom configuration at ${path}`);
  }
}

export function loadConfig(path: string): ProjectConfig {
  const parsed = projectConfigSchema.safeParse(readConfigJson(path));
  if (!parsed.success) {
    throw new Error(`Invalid xloom configuration at ${path}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

/** Exclusive creation: initialization must never overwrite an existing project. */
export function saveNewConfig(path: string, config: ProjectConfig): void {
  const parsed = projectConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid xloom configuration: ${formatValidationError(parsed.error)}`);
  }
  writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/** Save non-secret settings atomically. Model keys belong in Pi's credential store. */
export function saveConfig(path: string, config: ProjectConfig): void {
  const parsed = projectConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Invalid xloom configuration: ${formatValidationError(parsed.error)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
