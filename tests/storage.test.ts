import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_GOAL, defaultConfig, ensureGlobalSettings, loadConfig, saveNewConfig, workspaceDefaults } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import { DemoRunner } from "../src/demo.js";
import { FileLock } from "../src/lock.js";
import { migrateWorkspace } from "../src/migration.js";
import { atomicJson, ensureProject, evidencePath, projectConfigPath, projectDirectory, workspaceIdentity, xloomHome } from "../src/paths.js";
import { importPiSettings, modelRuntimePaths } from "../src/runtime/storage.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsService } from "../src/runtime/settings.js";
import { resolveModel } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import { currentTaskId, readSavedBoard, selectTask, taskDirectory, WorkspaceLock } from "../src/workspace.js";
import type { BoardSnapshot } from "../src/types.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xloom-storage-test-")));
  roots.push(root);
  return root;
}
function removeTestProject(workspace: string) {
  const directory = projectDirectory(workspace);
  expect(path.dirname(directory)).toBe(path.join(xloomHome(), "projects"));
  expect(path.basename(directory)).toMatch(/^[a-f0-9]{64}$/);
  rmSync(directory, { recursive: true, force: true });
}

async function legacyTask(workspace: string, taskId?: string) {
  const store = new BlackboardStore(workspace, defaultConfig("Synthetic storage migration fixture"), { taskId });
  await new LoopController(store, new DemoRunner()).start();
  const board = store.snapshot();
  const from = store.dataDir;
  store.close();
  const legacy = taskId ? path.join(workspace, ".xloom", "tasks", taskId) : path.join(workspace, ".xloom");
  cpSync(from, legacy, { recursive: true });
  const db = new DatabaseSync(path.join(legacy, "blackboard.sqlite"));
  for (const evidence of board.evidence) {
    evidence.path = path.relative(workspace, path.join(legacy, evidence.path)).replaceAll("\\", "/");
    delete evidence.pathBase;
  }
  db.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board));
  db.close();
  writeFileSync(path.join(legacy, "runs", "private-history.jsonl"), '{"text":"historical transcript, not shared memory"}\n');
  removeTestProject(workspace);
  return { legacy, board };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== realpathSync(tmpdir()) || !path.basename(root).startsWith("xloom-storage-test-")) throw new Error("Unsafe fixture cleanup.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("user storage and workspace identity", () => {
  it("defaults to the OS user directory and rejects a working-directory-dependent home", () => {
    vi.stubEnv("XLOOM_HOME", undefined);
    expect(xloomHome()).toBe(path.join(homedir(), ".xloom"));
    for (const value of ["", "relative-data"]) {
      vi.stubEnv("XLOOM_HOME", value);
      expect(() => xloomHome()).toThrow("absolute");
    }
  });

  it("isolates same-name directories, coalesces filesystem aliases and keeps locks per workspace", () => {
    const root = fixture();
    const a = path.join(root, "a", "same"); const b = path.join(root, "b", "same");
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    const alias = path.join(root, "alias"); symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
    expect(projectDirectory(a)).not.toBe(projectDirectory(b));
    expect(projectDirectory(alias)).toBe(projectDirectory(a));
    if (process.platform === "win32") expect(projectDirectory(a.toUpperCase())).toBe(projectDirectory(a));
    const first = new WorkspaceLock(a); const second = new WorkspaceLock(b);
    try {
      expect(() => new WorkspaceLock(alias)).toThrow("Another xloom session");
      selectTask(a, "task-a"); selectTask(b, "task-b");
      expect(currentTaskId(alias)).toBe("task-a"); expect(currentTaskId(b)).toBe("task-b");
      expect(JSON.parse(readFileSync(path.join(projectDirectory(a), "project.json"), "utf8")).workspace).toBe(realpathSync(a));
      expect(existsSync(path.join(a, ".xloom"))).toBe(false);
      expect(existsSync(path.join(b, ".xloom"))).toBe(false);
    } finally { first.close(); second.close(); }
  });

  it("inherits global model settings without inheriting another research goal", () => {
    vi.stubEnv("XLOOM_HOME", fixture());
    const config = defaultConfig("private task in another workspace");
    config.models.decide.model = "fixture-global-model";
    config.chrome = { enabled: false, channel: "beta" };
    ensureGlobalSettings(config);
    expect(workspaceDefaults(CHAT_GOAL)).toMatchObject({ goal: CHAT_GOAL, scope: CHAT_GOAL, context: "", models: config.models });
    expect(readFileSync(path.join(xloomHome(), "settings.json"), "utf8")).not.toContain(config.goal);
    ensureGlobalSettings(defaultConfig("another task"));
    expect(workspaceDefaults("new goal").models).toEqual(config.models);
    expect(workspaceDefaults("new goal").chrome).toEqual(config.chrome);
  });

  it("rejects a mismatched registry instead of mixing task storage", () => {
    const root = fixture(); ensureProject(root);
    atomicJson(path.join(projectDirectory(root), "project.json"), { version: 1, id: "wrong", workspace: root });
    expect(() => ensureProject(root)).toThrow("registry mismatch");
  });

  it.each(["", "\uFEFF"])("loads global defaults with optional UTF-8 BOM (%j) without rewriting settings", prefix => {
    vi.stubEnv("XLOOM_HOME", fixture());
    const config = defaultConfig("another task");
    const { version, models, limits } = config;
    const file = path.join(xloomHome(), "settings.json");
    const source = prefix + JSON.stringify({ version, models, limits });
    writeFileSync(file, source);
    expect(workspaceDefaults("测试目标")).toMatchObject({ goal: "测试目标", scope: "测试目标", models, limits });
    expect(readFileSync(file, "utf8")).toBe(source);
  });

  it("identifies malformed global configuration without exposing its contents", () => {
    vi.stubEnv("XLOOM_HOME", fixture());
    const file = path.join(xloomHome(), "settings.json");
    writeFileSync(file, '\uFEFF{"private-setting-value"');
    expect(() => workspaceDefaults("test")).toThrow(`Invalid JSON in xloom configuration at ${file}`);
    expect(() => workspaceDefaults("test")).not.toThrow("private-setting-value");
    writeFileSync(file, '\uFEFF{"unexpected":"private-setting-value"}');
    expect(() => workspaceDefaults("test")).toThrow(`Invalid Xloom global settings: ${file}`);
  });
});

describe("verified legacy data migration", () => {
  it("does not recursively import global storage when launched in its parent directory", async () => {
    const root = fixture(); vi.stubEnv("XLOOM_HOME", path.join(root, ".xloom"));
    ensureGlobalSettings(defaultConfig("another workspace's defaults"));
    ensureProject(fixture());
    expect(await migrateWorkspace(root)).toBe(false);
    expect(existsSync(projectDirectory(root))).toBe(false);
    saveNewConfig(path.join(root, "xloom.json"), defaultConfig(CHAT_GOAL));
    expect(await migrateWorkspace(root)).toBe(true);
    expect(loadConfig(projectConfigPath(root)).goal).toBe(CHAT_GOAL);
    expect(existsSync(path.join(projectDirectory(root), "projects"))).toBe(false);
  });

  it("refuses to place migration staging inside the legacy source", async () => {
    const root = fixture(); await legacyTask(root);
    vi.stubEnv("XLOOM_HOME", path.join(root, ".xloom", "nested-home"));
    await expect(migrateWorkspace(root)).rejects.toThrow("cannot be inside");
    expect(existsSync(projectDirectory(root))).toBe(false);
  });

  it("copies root and named tasks, preserves private logs, and reopens evidence after migration", async () => {
    const root = fixture();
    const originalRoot = await legacyTask(root);
    const original = await legacyTask(root, "task-selected");
    const oldDb = path.join(original.legacy, "blackboard.sqlite");
    const before = readFileSync(oldDb);
    atomicJson(path.join(root, ".xloom", "current-task.json"), { taskId: "task-selected" });
    saveNewConfig(path.join(root, "xloom.json"), defaultConfig(CHAT_GOAL));
    expect(await migrateWorkspace(root)).toBe(true);
    expect(currentTaskId(root)).toBe("task-selected");
    expect(loadConfig(projectConfigPath(root)).goal).toBe(CHAT_GOAL);
    expect(readFileSync(oldDb)).toEqual(before);
    expect(readSavedBoard(root).usage).toEqual(original.board.usage);
    expect(readFileSync(path.join(taskDirectory(root, "task-selected"), "runs", "private-history.jsonl"))).toEqual(readFileSync(path.join(original.legacy, "runs", "private-history.jsonl")));
    const copied = readSavedBoard(root);
    expect(copied.evidence[0]).toMatchObject({ pathBase: "task", sha256: original.board.evidence[0]!.sha256 });
    expect(copied.evidence[0]!.path).toMatch(/^evidence\//);
    const data = readFileSync(evidencePath(copied.evidence[0]!, taskDirectory(root, "task-selected"), root));
    expect(createHash("sha256").update(data).digest("hex")).toBe(copied.evidence[0]!.sha256);
    const reopened = new BlackboardStore(root, copied.config, { taskId: "task-selected" });
    try { reopened.verifyEvidence(copied.evidence[0]!); expect(reopened.events().filter(e => e.kind === "storage_migrated")).toHaveLength(1); }
    finally { reopened.close(); }
    const rootStore = new BlackboardStore(root, originalRoot.board.config);
    try { expect(rootStore.snapshot().facts).toEqual(originalRoot.board.facts); } finally { rootStore.close(); }
    const current = readFileSync(path.join(taskDirectory(root, "task-selected"), "blackboard.sqlite"));
    expect(await migrateWorkspace(root)).toBe(false);
    expect(readFileSync(path.join(taskDirectory(root, "task-selected"), "blackboard.sqlite"))).toEqual(current);
  });

  it("refuses a damaged archive without publishing partial data, then retries from the original", async () => {
    const root = fixture(); const original = await legacyTask(root);
    const evidence = path.resolve(root, original.board.evidence[0]!.path);
    const bytes = readFileSync(evidence); writeFileSync(evidence, "damaged fixture");
    await expect(migrateWorkspace(root)).rejects.toThrow("integrity failure");
    expect(existsSync(projectDirectory(root))).toBe(false);
    expect(readdirSync(path.dirname(projectDirectory(root))).some(name => name.startsWith(".migration-"))).toBe(false);
    expect(existsSync(path.join(original.legacy, "blackboard.sqlite"))).toBe(true);
    writeFileSync(evidence, bytes);
    expect(await migrateWorkspace(root)).toBe(true);
  });

  it("blocks migration while an old controller is live and releases all migration locks", async () => {
    const root = fixture(); const original = await legacyTask(root, "task-live");
    const lock = new FileLock(path.join(original.legacy, "controller.lock"));
    try { await expect(migrateWorkspace(root)).rejects.toThrow("Another xloom session"); }
    finally { lock.close(); }
    expect(existsSync(projectDirectory(root))).toBe(false);
    expect(await migrateWorkspace(root)).toBe(true);
  });

  it("includes committed WAL data without copying an inconsistent database file", async () => {
    const root = fixture(); const original = await legacyTask(root);
    const db = new DatabaseSync(path.join(original.legacy, "blackboard.sqlite"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      const board = JSON.parse(String(db.prepare("SELECT value FROM board WHERE id=1").get()!.value)) as BoardSnapshot;
      board.reason = "Latest committed WAL state";
      db.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board));
      expect(await migrateWorkspace(root)).toBe(true);
      expect(readSavedBoard(root).reason).toBe(board.reason);
    } finally { db.close(); }
  });
});

describe("Xloom-owned Pi runtime storage", () => {
  it("reports malformed imported credentials as a Xloom error without exposing their contents", () => {
    vi.stubEnv("XLOOM_HOME", fixture()); const source = fixture();
    writeFileSync(path.join(source, "auth.json"), '{"secret-value":');
    expect(() => importPiSettings(source)).toThrow("Xloom could not import auth.json: invalid JSON. Original files were retained.");
    expect(readFileSync(path.join(source, "auth.json"), "utf8")).toBe('{"secret-value":');
  });

  it("imports once, preserves existing settings and never resurrects logged-out credentials", () => {
    vi.stubEnv("XLOOM_HOME", fixture()); const source = fixture();
    const original = '{"anthropic":{"type":"api_key","key":"fixture-secret"}}';
    writeFileSync(path.join(source, "auth.json"), original);
    writeFileSync(path.join(source, "models.json"), '{"providers":{}}');
    writeFileSync(path.join(source, "models-store.json"), '{}');
    importPiSettings(source);
    expect(readFileSync(path.join(source, "auth.json"), "utf8")).toBe(original);
    expect(readFileSync(modelRuntimePaths().authPath, "utf8")).toBe(original);
    writeFileSync(modelRuntimePaths().authPath, '{}');
    importPiSettings(source);
    expect(readFileSync(modelRuntimePaths().authPath, "utf8")).toBe('{}');
    expect(readFileSync(path.join(xloomHome(), "pi-import.json"), "utf8")).not.toContain("fixture-secret");
  });

  it("keeps an explicit home isolated and injects identical paths into settings and model requests", async () => {
    vi.stubEnv("XLOOM_HOME", fixture());
    const unusedPi = path.join(fixture(), "never-create"); vi.stubEnv("PI_CODING_AGENT_DIR", unusedPi);
    const runtime = vi.spyOn(ModelRuntime, "create").mockRejectedValue(new Error("fixture initialization stop"));
    await expect(new SettingsService().listModels()).rejects.toThrow();
    await expect(resolveModel(defaultConfig("fixture").models.decide, new AbortController().signal)).rejects.toThrow();
    expect(runtime).toHaveBeenCalledTimes(2);
    for (const [options] of runtime.mock.calls) expect(options).toMatchObject(modelRuntimePaths());
    expect(existsSync(unusedPi)).toBe(false);
    expect(existsSync(path.join(xloomHome(), "pi-import.json"))).toBe(false);
  });
});
