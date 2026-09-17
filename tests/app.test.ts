import { projectDirectory, workspaceLockPath } from "../src/paths.js";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { AppController, type AppOptions } from "../src/app.js";
import { CHAT_GOAL, defaultConfig, loadConfig, saveNewConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { currentTaskId, readSavedBoard, taskDirectory, WorkspaceLock } from "../src/workspace.js";
import type { ChatRequest } from "../src/runtime/chat.js";
import type { LoopEvent, RunRequest } from "../src/types.js";

const roots: string[] = [];
const apps: AppController[] = [];
const usage = { input: 3, output: 2, cost: 0.01 };
function setup(options: AppOptions = {}, describeModel?: NonNullable<AppOptions["settings"]>["describeModel"]) {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-app-test-")); roots.push(root);
  const configPath = path.join(root, "xloom.json");
  const config = defaultConfig(CHAT_GOAL);
  const chatRequests: ChatRequest[] = [];
  const runRequests: RunRequest[] = [];
  const chat = { send: vi.fn(async (request: ChatRequest) => { chatRequests.push(request); request.onEvent({ mode: "chat", type: "text", text: "Hello" }); return usage; }), reset: vi.fn() };
  const settings = {
    ...(describeModel ? { describeModel } : {}),
    listModels: vi.fn(async () => [{ provider: "fixture", model: "model-a", name: "Model A" }, { provider: "fixture", model: "model-b", name: "Model B" }]),
    listProviders: vi.fn(async () => [{ id: "fixture", name: "Fixture", authTypes: ["api_key", "oauth"] }]),
    saveApiKey: vi.fn(async (_provider: string, _key: string, _signal?: AbortSignal) => {}),
    login: vi.fn(async (_provider: string, _interaction: AuthInteraction) => {}), logout: vi.fn(async (_provider: string, _signal?: AbortSignal) => {}),
  };
  const runner = { run: vi.fn(async (request: RunRequest) => { runRequests.push(request); return { output: { summary: "No executable plan proposed by this fixture" }, usage }; }) };
  saveNewConfig(configPath, config);
  const app = new AppController(root, configPath, config, { chat, settings, runner, ...options }); apps.push(app);
  const events: LoopEvent[] = []; app.subscribe(event => events.push(event));
  return { root, configPath, config, app, chat, settings, runner, chatRequests, runRequests, events };
}

afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("saved task navigation", () => {
  it("retains cache usage when an injected chat implementation returns per-reply totals", async () => {
    const chat = { send: async () => ({ input: 100, output: 10, cost: 0, cacheRead: 75, cacheInput: 100 }), reset() {} };
    const { app } = setup({ chat });
    await app.chat("First local fixture reply");
    await app.chat("Second local fixture reply");
    expect(app.getSessionInfo().usage).toEqual({ input: 200, output: 20, cost: 0, cacheRead: 150, cacheInput: 200 });
  });

  it("passes Chrome configuration into Chat and keeps explicit disconnect state across reset and application close", async () => {
    const test = setup(); test.config.chrome = { enabled: false, channel: "beta" };
    await test.app.close();
    const configured = new AppController(test.root, test.configPath, test.config, { chat: test.chat, settings: test.settings, runner: test.runner }); apps.push(configured);
    await configured.chat("Use configured tools");
    expect(test.chatRequests[0]?.chrome).toEqual(test.config.chrome);
    await configured.chromeControl("disconnect"); configured.resetChat(); await configured.close();
    const reopened = new AppController(test.root, test.configPath, test.config, { chat: test.chat, settings: test.settings, runner: test.runner }); apps.push(reopened);
    expect(await reopened.chromeControl("status")).toEqual({ bridgeRunning: false, manuallyDisconnected: true });
    await reopened.chromeControl("connect");
    expect(await reopened.chromeControl("status")).toEqual({ bridgeRunning: false, manuallyDisconnected: false });
    await expect(test.app.chromeControl("status")).rejects.toThrow("已关闭");
  });

  it.each(["paused", "error"])("retains an idle task's %s diagnosis through app close and reopen", async status => {
    const test = setup();
    if (status === "error") test.runner.run.mockRejectedValue(new Error("Synthetic original checksum failure"));
    await test.app.runGoal("Preserve the final run diagnosis");
    const before = test.app.snapshot(); expect(before.status).toBe(status);
    await test.app.close();
    expect(readSavedBoard(test.root)).toEqual(before);
    const reopened = new AppController(test.root, test.configPath, test.config, { chat: test.chat, settings: test.settings, runner: test.runner }); apps.push(reopened);
    expect(reopened.snapshot()).toMatchObject({ status: "idle", hints: [], facts: [], steps: [] });
    reopened.openTask(currentTaskId(test.root)!);
    expect(reopened.snapshot()).toEqual(before);
  });

  it.each(["run", "manual-meta"])("still cancels and saves active %s work when closing", async mode => {
    const test = setup(), started = Promise.withResolvers<void>();
    if (mode === "manual-meta") await test.app.runGoal("Pause before a manual review");
    test.runner.run.mockImplementation(request => new Promise((_resolve, reject) => {
      started.resolve(); request.signal.addEventListener("abort", () => reject(new Error("Synthetic stopped request")), { once: true });
    }));
    let running: Promise<void>;
    if (mode === "manual-meta") { test.app.requestMetacog(); running = test.app.waitForIdle(); }
    else running = test.app.runGoal("Interrupt active fixture");
    await started.promise;
    await test.app.close(); await running;
    expect(readSavedBoard(test.root).status).toBe("stopped");
    expect(existsSync(workspaceLockPath(test.root))).toBe(false);
  });

  it("lists and explicitly opens historical tasks without running a model, clearing the in-memory selection on restart", async () => {
    const test = setup();
    await test.app.runGoal("First synthetic research");
    const first = currentTaskId(test.root)!;
    test.app.hint("Retain this finding context");
    await test.app.runGoal("Second synthetic research");
    const second = currentTaskId(test.root)!;
    const before = readSavedBoard(test.root);
    const calls = test.runRequests.length;
    expect(test.app.listTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first, selected: false, goal: "First synthetic research" }),
      expect.objectContaining({ id: second, selected: true }),
    ]));
    expect(readSavedBoard(test.root)).toEqual(before);
    test.app.openTask(first);
    test.app.openTask(first);
    expect(test.runRequests).toHaveLength(calls);
    expect(test.app.snapshot().hints[0]?.content).toBe("Retain this finding context");
    expect(test.app.storagePaths().task).toBe(taskDirectory(test.root, first));
    expect(test.app.getSessionInfo().mode).toBe("run");
    expect(currentTaskId(test.root)).toBe(first);
    expect(() => test.app.openTask("../outside")).toThrow("找不到");
    expect(currentTaskId(test.root)).toBe(first);
    await test.app.close();
    const reopened = new AppController(test.root, test.configPath, test.config, { chat: test.chat, settings: test.settings, runner: test.runner }); apps.push(reopened);
    expect(reopened.snapshot().config.goal).toBe(CHAT_GOAL);
    expect(reopened.snapshot().hints).toEqual([]);
    expect(reopened.storagePaths().task).toBeUndefined();
    expect(reopened.listTasks().every(task => !task.selected)).toBe(true);
    reopened.openTask(first);
    expect(reopened.snapshot().hints[0]?.content).toBe("Retain this finding context");
    expect(readSavedBoard(test.root, second).hints).toEqual([]);
    expect(test.runRequests).toHaveLength(calls);
  });

  it("can select the retained legacy task explicitly", async () => {
    const test = setup();
    const legacy = new BlackboardStore(test.root, defaultConfig("Legacy research")); legacy.close();
    await test.app.runGoal("New research");
    expect(test.app.listTasks().some(task => task.id === "@legacy")).toBe(true);
    test.app.openTask("@legacy");
    expect(currentTaskId(test.root)).toBeUndefined();
    expect(test.app.snapshot().config.goal).toBe("Legacy research");
    expect(test.app.listTasks().find(task => task.id === "@legacy")?.selected).toBe(true);
  });
});

describe("session header metadata", () => {
  it("caches optional metadata and discards a stale result after a model change", async () => {
    const requests: { signal?: AbortSignal; resolve: (value: { contextWindow: number; authLabel: string }) => void }[] = [];
    const describe = vi.fn((_config, signal) => new Promise<{ contextWindow: number; authLabel: string }>(resolve => { requests.push({ signal, resolve }); }));
    const test = setup({}, describe);
    expect(test.app.getSessionInfo()).toMatchObject({ workspace: test.root, modelName: test.config.models.chat?.model ?? test.config.models.execute.model });
    expect(test.app.getSessionInfo().contextWindow).toBeUndefined();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await test.app.selectModel("fixture", "model-a", "all");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal?.aborted).toBe(true);
    requests[1]!.resolve({ contextWindow: 200_000, authLabel: "OAuth" });
    await vi.waitFor(() => expect(test.app.getSessionInfo()).toMatchObject({ model: "fixture/model-a", contextWindow: 200_000, authLabel: "OAuth" }));
    requests[0]!.resolve({ contextWindow: 1_000_000, authLabel: "API Key" });
    await Promise.resolve();
    for (let index = 0; index < 10; index++) expect(test.app.getSessionInfo().contextWindow).toBe(200_000);
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it("refreshes authentication metadata after saving credentials and ignores completion after close", async () => {
    let resolve!: (value: { contextWindow: number; authLabel: string }) => void;
    let signal: AbortSignal | undefined;
    const describe = vi.fn((_config, currentSignal) => { signal = currentSignal; return new Promise<{ contextWindow: number; authLabel: string }>(done => { resolve = done; }); });
    const test = setup({}, describe);
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(1));
    resolve({ contextWindow: 128_000, authLabel: "未配置认证" });
    await vi.waitFor(() => expect(test.app.getSessionInfo().authLabel).toBe("未配置认证"));
    await test.app.saveApiKey(test.config.models.execute.provider, "synthetic-key");
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
    await test.app.close();
    expect(signal?.aborted).toBe(true);
    const count = test.events.length;
    resolve({ contextWindow: 1_000_000, authLabel: "API Key" });
    await Promise.resolve();
    expect(test.events).toHaveLength(count);
  });

  it.each([false, true])("keeps chat operational when optional metadata fails (synchronous=%s)", async synchronous => {
    const test = setup({}, () => {
      if (synchronous) throw new Error("unavailable metadata");
      return Promise.reject(new Error("unavailable metadata"));
    });
    await test.app.chat("hello");
    expect(test.app.getSessionInfo()).toMatchObject({ mode: "chat", status: "idle", usage });
    expect(test.app.getSessionInfo().contextWindow).toBeUndefined();
    expect(test.events.some(event => event.type === "notice")).toBe(false);
  });

  it("tracks the actual agent model through handoffs and returns to the chat model", async () => {
    const test = setup();
    await test.app.selectModel("fixture", "model-a", "all");
    await test.app.selectModel("fixture", "model-b", "execute");
    const observed: { mode: string; model: string }[] = [];
    test.runner.run.mockImplementation(async request => {
      observed.push({ mode: request.mode, model: test.app.getSessionInfo().model });
      if (request.mode === "execute") {
        test.app.pause();
        return { output: { summary: "Synthetic execution cancelled", result: "no_progress" }, usage };
      }
      return { output: { summary: "Synthetic plan", steps: [{ goalId: "G0", from: [], description: "Inspect fixture", successSignal: "Saved fixture", evidencePlan: "Synthetic local evidence", priority: 50 }] }, usage };
    });
    await test.app.runGoal("header role fixture");
    expect(observed).toEqual([{ mode: "decide", model: "fixture/model-a" }, { mode: "execute", model: "fixture/model-b" }]);
    await test.app.chat("hello");
    expect(test.app.getSessionInfo().model).toBe("fixture/model-a");
  });
});

describe("chat / red-team application boundary", () => {
  it("defaults to chat without creating an empty task database", async () => {
    const test = setup();
    expect(test.app.getSessionInfo()).toMatchObject({ mode: "chat", busy: false, status: "idle" });
    await test.app.chat("private normal conversation");
    expect(test.chatRequests).toHaveLength(1);
    expect(test.runRequests).toHaveLength(0);
    expect(test.app.snapshot().hints).toEqual([]);
    expect(test.app.getSessionInfo().usage).toEqual(usage);
    expect(existsSync(path.join(projectDirectory(test.root), "blackboard.sqlite"))).toBe(false);
    expect(() => test.app.start()).toThrow(/\/run/);
  });

  it("starts a fresh task for /run and never forwards chat or old task state", async () => {
    const test = setup();
    await test.app.chat("PRIVATE CHAT MUST NOT ENTER TASK");
    await test.app.runGoal("first authorized fixture goal");
    const firstId = currentTaskId(test.root)!;
    const first = readSavedBoard(test.root);
    expect(first).toMatchObject({ status: "paused", hints: [], facts: [], config: { goal: "first authorized fixture goal", scope: "first authorized fixture goal", context: "" } });
    expect(JSON.stringify(test.runRequests)).not.toContain("PRIVATE CHAT");
    expect(test.runRequests.every(request => request.workspace === test.root && request.blackboardPath?.includes(firstId))).toBe(true);
    test.app.hint("OLD TASK PRIVATE HINT");
    await test.app.runGoal("second fixture goal");
    const secondId = currentTaskId(test.root)!;
    expect(secondId).not.toBe(firstId);
    expect(readSavedBoard(test.root, firstId).hints[0]?.content).toBe("OLD TASK PRIVATE HINT");
    expect(readSavedBoard(test.root).hints).toEqual([]);
    expect(readSavedBoard(test.root).config.goal).toBe("second fixture goal");
    expect(readdirSync(path.join(projectDirectory(test.root), "tasks"))).toHaveLength(2);
    expect(loadConfig(test.configPath).goal).toBe(CHAT_GOAL);
  });

  it("ordinary chat never becomes a Hint, including after a red-team task", async () => {
    const test = setup(); await test.app.runGoal("fixture");
    const before = readSavedBoard(test.root);
    await test.app.chat("not a hint");
    expect(test.app.getSessionInfo().mode).toBe("chat");
    expect(readSavedBoard(test.root)).toEqual(before);
    test.app.resetChat();
    expect(test.chat.reset).toHaveBeenCalledOnce();
    expect(test.app.getSessionInfo().usage).toEqual({ input: 0, output: 0, cost: 0 });
    expect(readSavedBoard(test.root)).toEqual(before);
  });

  it("starts with an empty board and requires an explicit open before continuing a saved task", async () => {
    const test = setup(); await test.app.runGoal("recover fixture goal");
    const id = currentTaskId(test.root)!;
    await test.app.close();
    const reopened = new AppController(test.root, test.configPath, loadConfig(test.configPath), { runner: test.runner, chat: test.chat, settings: test.settings }); apps.push(reopened);
    expect(reopened.getSessionInfo().mode).toBe("chat");
    expect(reopened.snapshot().config.goal).toBe(CHAT_GOAL);
    expect(() => reopened.start()).toThrow(/\/run/);
    reopened.openTask(id);
    await reopened.start();
    expect(currentTaskId(test.root)).toBe(id);
    expect(reopened.snapshot().status).toBe("paused");
  });

  it("uses unlimited workspace time settings for a saved task and for later chat and runs", async () => {
    const test = setup();
    await test.app.close();
    const legacy = defaultConfig("saved fixture goal");
    legacy.limits.stepTimeoutSeconds = 180;
    legacy.limits.maxMinutes = 5;
    const store = new BlackboardStore(test.root, legacy);
    store.hint("preserved fixture context");
    store.setStatus("paused", "Run time limit reached");
    const before = store.snapshot();
    store.close();
    const app = new AppController(test.root, test.configPath, loadConfig(test.configPath), { runner: test.runner, chat: test.chat, settings: test.settings });
    apps.push(app);
    expect(test.runner.run).not.toHaveBeenCalled();
    expect(app.snapshot()).toMatchObject({ status: "idle", hints: [] });
    app.openTask("@legacy");
    expect(app.snapshot()).toMatchObject({ status: "paused", goals: before.goals, hints: before.hints, usage: before.usage });
    expect(app.snapshot().config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.start();
    expect(test.runRequests[0]!.snapshot.config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.chat("model identity");
    expect(test.chatRequests[0]!.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.runGoal("new fixture goal");
    expect(test.runRequests.at(-1)!.snapshot.config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
  });

  it("preserves a legacy root blackboard and keeps newly requested tasks separate", async () => {
    const test = setup(); await test.app.close();
    const store = new BlackboardStore(test.root, defaultConfig("legacy fixture goal")); store.hint("legacy hint"); store.close();
    const oldFile = path.join(projectDirectory(test.root), "blackboard.sqlite");
    const app = new AppController(test.root, test.configPath, test.config, { runner: test.runner, chat: test.chat, settings: test.settings }); apps.push(app);
    expect(app.snapshot().config.goal).toBe(CHAT_GOAL);
    expect(app.snapshot().hints).toEqual([]);
    await app.runGoal("new fixture goal");
    expect(existsSync(oldFile)).toBe(true);
    const old = new BlackboardStore(test.root, defaultConfig("legacy fixture goal"));
    expect(old.snapshot().hints[0]?.content).toBe("legacy hint"); old.close();
  });

  it.each(["not JSON", '{"taskId":"missing-task"}', '{"taskId":"../outside"}'])("starts cleanly even with an unreadable old task and pointer %s", async pointer => {
    const test = setup();
    await test.app.runGoal("OLD_TASK_GOAL");
    const id = currentTaskId(test.root)!;
    await test.app.close();
    const file = path.join(taskDirectory(test.root, id), "blackboard.sqlite");
    writeFileSync(file, "corrupt old database");
    const pointerFile = path.join(projectDirectory(test.root), "current-task.json");
    writeFileSync(pointerFile, pointer);
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, runner: test.runner }); apps.push(app);
    expect(app.snapshot()).toMatchObject({ status: "idle", goals: [], facts: [], hints: [], evidence: [] });
    expect(app.chatHistory()).toMatchObject({ messages: [], usage: { input: 0, output: 0, cost: 0 } });
    expect(app.storagePaths().task).toBeUndefined();
    expect(app.listTasks()).toContainEqual(expect.objectContaining({ id, selected: false, error: expect.any(String) }));
    expect(readFileSync(file, "utf8")).toBe("corrupt old database");
    expect(readFileSync(pointerFile, "utf8")).toBe(pointer);
  });

  it("starts the configured goal in a different task directory on every application launch", async () => {
    const test = setup(); await test.app.close();
    const config = defaultConfig("Configured fresh goal");
    config.context = "Explicit configured context";
    const legacy = new BlackboardStore(test.root, config); legacy.hint("LEGACY_PRIVATE_HINT"); legacy.close();
    const ids: string[] = [];
    for (let launch = 0; launch < 2; launch++) {
      const app = new AppController(test.root, test.configPath, config, { settings: test.settings, runner: test.runner }); apps.push(app);
      expect(app.snapshot().hints).toEqual([]);
      await app.start();
      ids.push(currentTaskId(test.root)!);
      expect(app.snapshot().config.context).toBe(config.context);
      expect(app.snapshot().hints).toEqual([]);
      app.hint("PREVIOUS_LAUNCH_HINT");
      await app.close();
    }
    expect(ids[0]).toMatch(/^task-/); expect(ids[1]).not.toBe(ids[0]);
    expect(JSON.stringify(test.runRequests)).not.toContain("LEGACY_PRIVATE_HINT");
    expect(JSON.stringify(test.runRequests)).not.toContain("PREVIOUS_LAUNCH_HINT");
    expect(readSavedBoard(test.root, null).hints[0]?.content).toBe("LEGACY_PRIVATE_HINT");
  });

  it("rejects empty goals before switching or creating tasks", () => {
    const test = setup();
    expect(() => test.app.runGoal(" ")).toThrow();
    expect(currentTaskId(test.root)).toBeUndefined();
    expect(existsSync(path.join(projectDirectory(test.root), "tasks"))).toBe(false);
  });

  it("requires explicit task context for hints and metacognition", () => {
    const test = setup();
    expect(() => test.app.hint("hint")).toThrow(/\/run/);
    expect(() => test.app.requestMetacog()).toThrow(/\/run/);
  });

  it("blocks switching while chatting, cancels, and settles before closing", async () => {
    let signal: AbortSignal | undefined;
    const test = setup({ chat: { reset: vi.fn(), send: request => new Promise((_, reject) => { signal = request.signal; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }) } });
    const running = test.app.chat("wait");
    const settled = expect(running).rejects.toThrow("cancelled");
    await Promise.resolve();
    expect(() => test.app.runGoal("not yet")).toThrow(/pause/);
    expect(() => test.app.selectModel("fixture", "model-a")).toThrow(/pause/);
    expect(() => test.app.resetChat()).toThrow(/pause/);
    test.app.pause(); await settled; await test.app.waitForIdle();
    expect(signal?.aborted).toBe(true);
    expect(test.app.getSessionInfo()).toMatchObject({ busy: false, status: "paused" });
  });

  it("cancels a queued operation before it reaches the chat backend", async () => {
    const test = setup(); const running = test.app.chat("queued"); const settled = expect(running).rejects.toThrow();
    test.app.stop(); await settled;
    expect(test.chat.send).not.toHaveBeenCalled();
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("accounts for partial chat usage without fabricating research findings", async () => {
    const test = setup({ chat: { reset: vi.fn(), send: async () => { throw Object.assign(new Error("provider failure"), { usage }); } } });
    await expect(test.app.chat("fixture")).rejects.toThrow("provider failure");
    expect(test.app.getSessionInfo()).toMatchObject({ status: "error", usage });
    expect(test.app.snapshot().findings).toEqual([]);
  });

  it("closes an application with a task exactly once, including repeated cleanup", async () => {
    const test = setup(); await test.app.runGoal("close fixture");
    const store = (test.app as unknown as { store: BlackboardStore }).store;
    const closeStore = vi.spyOn(store, "close");
    await test.app.close();
    await test.app.close();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(test.chat.reset).toHaveBeenCalledOnce();
    expect(existsSync(workspaceLockPath(test.root))).toBe(false);
    expect(existsSync(path.join(store.dataDir, "controller.lock"))).toBe(false);
  });
});

describe("application model settings", () => {
  it("applies current Chrome settings when reopening an existing task", async () => {
    const test = setup(); await test.app.runGoal("Existing Chrome task");
    const taskId = currentTaskId(test.root)!;
    await test.app.runGoal("Another task before reopening");
    test.config.chrome = { enabled: false, channel: "beta" };
    await test.app.close();
    const reopened = new AppController(test.root, test.configPath, test.config, { runner: test.runner, chat: test.chat, settings: test.settings }); apps.push(reopened);
    expect(reopened.snapshot().config.chrome).toEqual(test.config.chrome);
    reopened.openTask(taskId);
    expect(reopened.snapshot().config.chrome).toEqual(test.config.chrome);
  });
  it("selects models per role, persists no keys, and applies to paused tasks", async () => {
    const test = setup(); await test.app.runGoal("fixture");
    await test.app.selectModel("fixture", "model-a", "all");
    await test.app.selectModel("fixture", "model-b", "decide");
    const models = loadConfig(test.configPath).models;
    expect(models.chat?.model).toBe("model-a"); expect(models.execute.model).toBe("model-a"); expect(models.decide.model).toBe("model-b");
    expect(readSavedBoard(test.root).config.models).toEqual(models);
    expect(test.chat.reset).toHaveBeenCalledTimes(2);
    await test.app.chat("chat model"); expect(test.chatRequests[0]?.model.model).toBe("model-a");
  });

  it("rejects unknown models without modifying configuration", async () => {
    const test = setup(); const before = readFileSync(test.configPath, "utf8");
    await expect(test.app.selectModel("unknown", "missing")).rejects.toThrow(/Xloom/);
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
  });

  it("does not reinsert an unauthenticated current model into the chooser or save it as a selection", async () => {
    const test = setup();
    test.settings.listModels.mockResolvedValue([]);
    const current = test.config.models.execute;
    const before = readFileSync(test.configPath, "utf8");
    expect(await test.app.getModels()).toEqual([]);
    await expect(test.app.selectModel(current.provider, current.model)).rejects.toThrow(/apikey/);
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });

  it("passes a secret only to Pi settings, never the model, config or events", async () => {
    const test = setup(); await test.app.selectModel("fixture", "model-a");
    const key = "TEST_SECRET_NOT_A_REAL_KEY";
    await test.app.saveApiKey("fixture", key);
    expect(test.settings.saveApiKey).toHaveBeenCalledWith("fixture", key, expect.any(AbortSignal));
    expect(readFileSync(test.configPath, "utf8")).not.toContain(key);
    expect(JSON.stringify(test.events)).not.toContain(key);
    expect(test.chat.send).not.toHaveBeenCalled(); expect(test.runner.run).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "cancelled", "late completion"] as const)("resets chat history and application usage only after successful logout (%s)", async outcome => {
    const messages: { role: "user"; text: string }[] = [];
    const used = { ...usage, cacheRead: 1, cacheInput: 3 };
    const emptyUsage = { input: 0, output: 0, cost: 0 };
    const chat = {
      send: async (request: ChatRequest) => { messages.push({ role: "user", text: request.text }); return used; },
      reset: vi.fn(() => { messages.splice(0); }),
      history: () => ({ id: undefined, file: undefined, usage: messages.length ? used : emptyUsage, pendingToolCalls: [], messages: [...messages] }),
    };
    const test = setup({ chat });
    await test.app.chat("Retain this chat unless logout succeeds");
    const before = test.app.chatHistory();
    expect(test.app.getSessionInfo().usage).toEqual(used);
    expect(before?.messages).toHaveLength(1);
    const backend = Promise.withResolvers<void>();
    test.settings.logout.mockImplementation(() => backend.promise);
    const abort = new AbortController();
    const pending = test.app.logout("fixture", abort.signal);
    const settled = outcome === "success" ? expect(pending).resolves.toBeUndefined() : expect(pending).rejects.toThrow();
    await Promise.resolve();
    expect(test.settings.logout).toHaveBeenCalledWith("fixture", expect.any(AbortSignal));
    if (outcome === "cancelled" || outcome === "late completion") abort.abort();
    if (outcome === "failure" || outcome === "cancelled") backend.reject(new Error("Synthetic logout failure"));
    else backend.resolve();
    await settled;
    expect(test.app.getSessionInfo()).toMatchObject({ busy: false, usage: outcome === "success" ? emptyUsage : used });
    expect(test.app.snapshot().usage).toEqual(outcome === "success" ? emptyUsage : used);
    if (outcome === "success") {
      expect(chat.reset).toHaveBeenCalledOnce();
      expect(test.app.chatHistory()?.messages).toEqual([]);
      await test.app.chat("Start with fresh usage");
      expect(test.app.getSessionInfo().usage).toEqual(used);
    } else {
      expect(chat.reset).not.toHaveBeenCalled();
      expect(test.app.chatHistory()).toEqual(before);
    }
  });

  it("uses saved credentials instead of a stale explicit key environment override", async () => {
    const test = setup(); await test.app.close();
    test.config.models.execute = { provider: "fixture", model: "model-a", apiKeyEnv: "OLD_KEY_ENV" };
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.saveApiKey("fixture", "fixture-key");
    expect(loadConfig(test.configPath).models.execute.apiKeyEnv).toBeUndefined();
  });

  it.each(["apikey", "login"] as const)("uses replacement credentials for every role on the next request through /%s", async command => {
    const test = setup(); await test.app.close();
    test.chat.reset.mockClear();
    const selected = { provider: "fixture", model: "model-a", apiKeyEnv: "OLD_KEY_ENV" };
    test.config.models = { chat: selected, decide: selected, execute: selected };
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.chat("Before replacement");
    if (command === "apikey") await app.saveApiKey("fixture", "replacement-key");
    else {
      await app.login("fixture", { prompt: async () => "replacement-key", notify() {} }, "api_key");
      expect(test.settings.login).toHaveBeenCalledWith("fixture", expect.objectContaining({ signal: expect.any(AbortSignal) }), "api_key");
    }
    expect(test.chat.reset).toHaveBeenCalledOnce();
    for (const model of Object.values(loadConfig(test.configPath).models)) expect(model?.apiKeyEnv).toBeUndefined();
    await app.chat("After replacement");
    expect(test.chatRequests.at(-1)?.model).toEqual({ provider: "fixture", model: "model-a" });
    expect(readFileSync(test.configPath, "utf8")).not.toContain("replacement-key");
    expect(JSON.stringify(test.events)).not.toContain("replacement-key");
  });

  it("uses Pi model defaults without imposing a maxTokens override or inheriting another model's settings", async () => {
    const test = setup(); await test.app.close();
    test.config.models.execute = { provider: "fixture", model: "old-inline", api: "anthropic-messages", baseUrl: "https://fixture.invalid/v1", apiKeyEnv: "OLD_KEY_ENV", maxTokens: 8192, contextWindow: 64000 };
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.selectModel("fixture", "model-a", "all");
    const expected = { provider: "fixture", model: "model-a" };
    expect(loadConfig(test.configPath).models).toEqual({ chat: expected, decide: expected, execute: expected });
    await app.chat("respect provider defaults");
    expect(test.chatRequests[0]?.model).toEqual(expected);
  });

  it("includes a configured inline alias in the chooser and preserves its endpoint on selection", async () => {
    const test = setup(); await test.app.close();
    const alias = { provider: "fixture-inline", model: "private-alias", api: "anthropic-messages", baseUrl: "https://fixture.invalid/api", apiKeyEnv: "ALIAS_KEY_ENV", maxTokens: 2048 };
    test.config.models.execute = alias;
    test.settings.listModels.mockResolvedValue([{ provider: alias.provider, model: alias.model, name: alias.model }]);
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    expect(await app.getModels()).toContainEqual({ provider: alias.provider, model: alias.model, name: alias.model });
    expect(test.settings.listModels).toHaveBeenCalledWith(expect.arrayContaining([alias]));
    await app.selectModel(alias.provider, alias.model, "all");
    expect(loadConfig(test.configPath).models).toEqual({ chat: alias, decide: alias, execute: alias });
    expect((await app.getModels()).filter(model => model.provider === alias.provider && model.model === alias.model)).toHaveLength(1);
  });

  it("retains the explicit credential override that makes a catalog model selectable", async () => {
    const test = setup(); await test.app.close();
    const selected = { provider: "fixture", model: "model-a", apiKeyEnv: "MODEL_KEY_ENV" };
    test.config.models.execute = selected;
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.selectModel(selected.provider, selected.model);
    expect(loadConfig(test.configPath).models).toEqual({ chat: selected, decide: selected, execute: selected });
    await app.chat("Use the selected provider credential");
    expect(test.chatRequests[0]?.model).toEqual(selected);
  });

  it.each(["model", "apikey", "logout"] as const)("does not start an already-cancelled %s setting operation", async kind => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    const abort = new AbortController(); abort.abort();
    const pending = kind === "model" ? test.app.selectModel("fixture", "model-a", "all", abort.signal)
      : kind === "apikey" ? test.app.saveApiKey("fixture", "synthetic-key", abort.signal) : test.app.logout("fixture", abort.signal);
    await expect(pending).rejects.toThrow();
    expect(test.settings.listModels).not.toHaveBeenCalled();
    expect(test.settings.saveApiKey).not.toHaveBeenCalled();
    expect(test.settings.logout).not.toHaveBeenCalled();
    expect(test.chat.reset).not.toHaveBeenCalled();
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("does not persist a model selection cancelled during catalog loading", async () => {
    const test = setup(); await test.app.runGoal("cancel model fixture");
    const before = readFileSync(test.configPath, "utf8");
    const boardBefore = readSavedBoard(test.root);
    let release!: (models: Awaited<ReturnType<typeof test.settings.listModels>>) => void;
    test.settings.listModels.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = test.app.selectModel("fixture", "model-a", "all", abort.signal);
    const settled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort();
    release([{ provider: "fixture", model: "model-a", name: "Model A" }]);
    await settled;
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(readSavedBoard(test.root)).toEqual(boardBefore);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });

  it.each(["apikey", "logout"] as const)("propagates an in-flight %s cancellation without committing or resetting chat", async kind => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    let received: AbortSignal | undefined;
    let committed = false;
    const cancelAwareOperation = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      received = signal;
      signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      // A cancelled backend never reaches its persistence step.
      if (!signal) { committed = true; resolve(); }
    });
    test.settings.saveApiKey.mockImplementation((_provider, _key, signal) => cancelAwareOperation(signal));
    test.settings.logout.mockImplementation((_provider, signal) => cancelAwareOperation(signal));
    const abort = new AbortController();
    const pending = kind === "apikey" ? test.app.saveApiKey("fixture", "synthetic-key", abort.signal) : test.app.logout("fixture", abort.signal);
    const settled = expect(pending).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(received).toBeDefined());
    abort.abort(); await settled;
    expect(received?.aborted).toBe(true);
    expect(committed).toBe(false);
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.chat.reset).not.toHaveBeenCalled();
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("rechecks API-key cancellation before clearing environment overrides even if a backend resolves late", async () => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    let release!: () => void;
    test.settings.saveApiKey.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = test.app.saveApiKey("fixture", "synthetic-key", abort.signal);
    const settled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort(); release(); await settled;
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });

  it("restores disk and memory settings when the paused blackboard update fails", async () => {
    const test = setup(); await test.app.runGoal("settings rollback fixture");
    const before = readFileSync(test.configPath, "utf8");
    const boardBefore = readSavedBoard(test.root);
    const selectedBefore = test.app.getSessionInfo().model;
    const store = (test.app as unknown as { store: BlackboardStore }).store;
    vi.spyOn(store, "updateModels").mockImplementation(() => { throw new Error("synthetic SQLite failure"); });
    await expect(test.app.selectModel("fixture", "model-a")).rejects.toThrow("配置已恢复");
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(readSavedBoard(test.root)).toEqual(boardBefore);
    expect(test.app.getSessionInfo().model).toBe(selectedBefore);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });
});

describe("workspace ownership", () => {
  for (const status of ["paused", "error"] as const) {
    it.each(["model", "apikey", "login", "logout"] as const)(`closes a pending %s setting without overwriting the task's ${status} diagnosis`, async kind => {
      const test = setup();
      if (status === "error") test.runner.run.mockRejectedValue(new Error("Synthetic original task failure"));
      await test.app.runGoal("Preserve the task while cancelling a setting");
      const before = test.app.snapshot(), started = Promise.withResolvers<AbortSignal | undefined>(), release = Promise.withResolvers<void>();
      const configure = async (signal?: AbortSignal) => { started.resolve(signal); await release.promise; signal?.throwIfAborted(); };
      test.settings.listModels.mockImplementation(async () => { await configure(); return [{ provider: "fixture", model: "model-a", name: "Model A" }]; });
      test.settings.saveApiKey.mockImplementation((_provider, _key, signal) => configure(signal));
      test.settings.login.mockImplementation((_provider, interaction) => configure(interaction.signal));
      test.settings.logout.mockImplementation((_provider, signal) => configure(signal));
      const pending = kind === "model" ? test.app.selectModel("fixture", "model-a")
        : kind === "apikey" ? test.app.saveApiKey("fixture", "synthetic-key")
        : kind === "login" ? test.app.login("fixture", { notify() {}, async prompt() { return "synthetic-answer"; } }) : test.app.logout("fixture");
      const settled = expect(pending).rejects.toThrow();
      const signal = await started.promise;
      const closing = test.app.close();
      let closed = false; void closing.then(() => { closed = true; });
      await Promise.resolve();
      const closedBeforeRelease = closed;
      release.resolve(); await settled; await closing;
      expect(closedBeforeRelease).toBe(false);
      if (kind !== "model") expect(signal?.aborted).toBe(true);
      expect(before.status).toBe(status);
      expect(readSavedBoard(test.root)).toEqual(before);
      expect(existsSync(workspaceLockPath(test.root))).toBe(false);
      const reopened = new AppController(test.root, test.configPath, test.config, { chat: test.chat, settings: test.settings, runner: test.runner }); apps.push(reopened);
      expect(reopened.getSessionInfo()).toMatchObject({ mode: "chat", busy: false, status: "idle", usage: { input: 0, output: 0, cost: 0 } });
      expect(reopened.snapshot()).toMatchObject({ facts: [], steps: [], hints: [] });
      expect(reopened.storagePaths().task).toBeUndefined();
    });
  }

  it("concurrent close callers wait for the same cleanup and cannot start new work", async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const test = setup({ chat: { reset: vi.fn(), send: request => new Promise(resolve => { signal = request.signal; release = () => resolve(usage); }) } });
    await test.app.runGoal("Preserve this task while closing an active chat");
    const before = test.app.snapshot();
    const running = test.app.chat("pending fixture");
    await Promise.resolve();
    const first = test.app.close();
    const second = test.app.close();
    expect(second).toBe(first);
    expect(signal?.aborted).toBe(true);
    let closed = false;
    void first.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => test.app.chat("after close")).toThrow(/已关闭/);
    release(); await running; await Promise.all([first, second]);
    expect(closed).toBe(true);
    expect(existsSync(workspaceLockPath(test.root))).toBe(false);
    expect(readSavedBoard(test.root)).toEqual(before);
  });

  it("keeps one live application per workspace and releases its own lock", async () => {
    const test = setup();
    expect(() => new WorkspaceLock(test.root)).toThrow(/Another xloom session/);
    await test.app.close();
    const lock = new WorkspaceLock(test.root); lock.close();
    expect(existsSync(workspaceLockPath(test.root))).toBe(false);
  });

  it("rejects malformed task pointers without reading outside the workspace", async () => {
    const test = setup(); await test.app.close();
    writeFileSync(path.join(projectDirectory(test.root), "current-task.json"), JSON.stringify({ taskId: "../../outside" }));
    expect(() => readSavedBoard(test.root)).toThrow(/Invalid task ID/);
    const app = new AppController(test.root, test.configPath, test.config); apps.push(app);
    expect(app.snapshot().hints).toEqual([]);
    expect(() => app.openTask("../../outside")).toThrow("找不到");
    await app.close();
    expect(existsSync(workspaceLockPath(test.root))).toBe(false);
  });

  it("recovers a stale session under the recovery guard and releases that guard", async () => {
    const test = setup(); await test.app.close();
    const file = workspaceLockPath(test.root);
    writeFileSync(file, JSON.stringify({ pid: 123456789, token: "stale-owner" }));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 123456789) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return realKill(pid, signal);
    });
    const lock = new WorkspaceLock(test.root);
    try {
      const owner = JSON.parse(readFileSync(file, "utf8"));
      expect(owner.pid).toBe(process.pid); expect(owner.token).not.toBe("stale-owner");
      expect(existsSync(`${file}.recovery`)).toBe(false);
      const activeContents = readFileSync(file, "utf8");
      expect(() => new WorkspaceLock(test.root)).toThrow("Another xloom session");
      expect(readFileSync(file, "utf8")).toBe(activeContents);
      expect(existsSync(`${file}.recovery`)).toBe(false);
    } finally { lock.close(); }
    expect(existsSync(file)).toBe(false);
  });

  it("does not inspect or remove an owner when another recovery guard exists", async () => {
    const test = setup(); await test.app.close();
    const file = workspaceLockPath(test.root);
    const content = JSON.stringify({ pid: 123456789, token: "existing-owner" });
    writeFileSync(file, content); writeFileSync(`${file}.recovery`, "other-recovery-owner");
    const kill = vi.spyOn(process, "kill");
    expect(() => new WorkspaceLock(test.root)).toThrow("Another process is checking");
    expect(kill).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readFileSync(`${file}.recovery`, "utf8")).toBe("other-recovery-owner");
  });

  it("never removes a replacement session lock when closing an older owner", async () => {
    const test = setup(); await test.app.close();
    const lock = new WorkspaceLock(test.root);
    const file = workspaceLockPath(test.root);
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement-owner" });
    writeFileSync(file, replacement);
    lock.close();
    expect(readFileSync(file, "utf8")).toBe(replacement);
  });
});
