import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { CHAT_GOAL, saveConfig } from "./config.js";
import { LoopController } from "./controller.js";
import { BlackboardStore } from "./store.js";
import { ChatSession, type ChatRequest } from "./runtime/chat.js";
import { PiRunner } from "./runtime/pi-runner.js";
import { SettingsService, type ModelDisplayInfo } from "./runtime/settings.js";
import { projectConfigSchema, usageSchema } from "./schema.js";
import { addUsage } from "./usage.js";
import { listTasks, readSavedBoard, selectTask, WorkspaceLock } from "./workspace.js";
import { ensureProject, projectDirectory, xloomHome } from "./paths.js";
import type { AgentRole, AgentRunner, BoardSnapshot, LoopEvent, ModelConfig, ProjectConfig, Usage } from "./types.js";

export interface AppOptions {
  runner?: AgentRunner;
  chat?: { send(request: ChatRequest): Promise<Usage>; reset(): void; close?(): void; getUsage?(): Usage; history?(): ReturnType<ChatSession["history"]> };
  settings?: Pick<SettingsService, "listModels" | "listProviders" | "saveApiKey" | "login" | "logout"> & Partial<Pick<SettingsService, "describeModel">>;
}

/** Chat owns its history. A red-team task owns a separate blackboard, never that history. */
export class AppController {
  readonly workspace: string;
  private config: ProjectConfig;
  private readonly lock: WorkspaceLock;
  private readonly runner: AgentRunner;
  private readonly chatSession: NonNullable<AppOptions["chat"]>;
  private readonly settings: NonNullable<AppOptions["settings"]>;
  private store?: BlackboardStore;
  private loop?: LoopController;
  private detachLoop?: () => void;
  private listeners = new Set<(event: LoopEvent) => void>();
  private active?: Promise<void>;
  private cancellation?: AbortController;
  private mode: "chat" | "run" = "chat";
  private activeRole: AgentRole = "decide";
  private displayInfo?: { key: string; value: ModelDisplayInfo };
  private displayRequest?: AbortController;
  private displayKey?: string;
  private chatUsage: Usage = { input: 0, output: 0, cost: 0 };
  private chatStatus = "idle";
  private closed = false;
  private closing?: Promise<void>;

  constructor(workspace: string, private readonly configPath: string, config: ProjectConfig, options: AppOptions = {}) {
    this.workspace = realpathSync(workspace);
    ensureProject(this.workspace);
    this.config = projectConfigSchema.parse(config);
    this.runner = options.runner ?? new PiRunner();
    this.chatSession = options.chat ?? new ChatSession({ storageDirectory: path.join(projectDirectory(this.workspace), "chats") });
    this.settings = options.settings ?? new SettingsService();
    this.lock = new WorkspaceLock(this.workspace);
    this.refreshDisplayInfo();
  }

  private attach(store: BlackboardStore): void {
    this.detachLoop?.();
    this.store?.close();
    this.store = store;
    this.loop = new LoopController(store, this.runner);
    this.detachLoop = this.loop.subscribe(event => {
      if (event.type === "handoff" && event.handoff) {
        this.activeRole = event.handoff.role;
        this.refreshDisplayInfo();
      }
      this.emit(event);
    });
  }

  snapshot(): BoardSnapshot {
    return this.store?.snapshot() ?? {
      revision: 0, config: structuredClone(this.config), status: "idle", outcome: null, reason: "普通聊天；/run 目标启动独立任务",
      goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [], usage: { ...this.chatUsage },
      completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1, elapsedMs: 0,
    };
  }
  private selectedModel(): ModelConfig { return this.mode === "chat" ? this.config.models.chat ?? this.config.models.execute : this.config.models[this.activeRole]; }
  private refreshDisplayInfo(force = false): void {
    if (this.closed || !this.settings.describeModel) return;
    const selected = this.selectedModel();
    const key = JSON.stringify(selected);
    if (!force && key === this.displayKey) return;
    this.displayKey = key;
    this.displayInfo = undefined;
    this.displayRequest?.abort();
    const request = new AbortController();
    this.displayRequest = request;
    void Promise.resolve().then(() => { request.signal.throwIfAborted(); return this.settings.describeModel!(selected, request.signal); }).then(value => {
      if (this.closed || request.signal.aborted || this.displayRequest !== request) return;
      this.displayInfo = { key, value };
      this.emit({ type: "session" });
    }).catch(() => { /* Header metadata is optional; failures must not prevent chat or task execution. */ });
  }
  getSessionInfo() {
    const selected = this.selectedModel();
    const display = this.displayInfo?.key === JSON.stringify(selected) ? this.displayInfo.value : undefined;
    return { mode: this.mode, busy: !!this.active, model: `${selected.provider}/${selected.model}`, modelName: selected.model,
      workspace: this.workspace, contextWindow: selected.contextWindow ?? display?.contextWindow, authLabel: display?.authLabel,
      status: this.mode === "chat" ? this.chatStatus : this.store?.snapshot().status ?? "idle", usage: this.mode === "chat" ? { ...this.chatUsage } : this.store?.snapshot().usage };
  }
  subscribe(listener: (event: LoopEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LoopEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* Isolate rendering from state. */ } } }
  private idle(): void {
    if (this.closed) throw new Error("当前 xloom 会话已关闭。");
    if (this.active) throw new Error("当前调用尚未结束。请先 /pause，等待停止后再切换模式、模型或凭据。");
  }

  private perform(mode: "chat" | "run", operation: (signal: AbortSignal) => Promise<void>, externalSignal?: AbortSignal): Promise<void> {
    this.idle();
    this.mode = mode;
    this.refreshDisplayInfo();
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    const signal = externalSignal ? AbortSignal.any([cancellation.signal, externalSignal]) : cancellation.signal;
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).finally(() => {
      if (this.active === task) { this.active = undefined; this.cancellation = undefined; }
      this.emit({ type: "session" });
    });
    this.active = task;
    this.emit({ type: "session" });
    return task;
  }
  private addChatUsage(value: unknown): void {
    if (this.chatSession.getUsage) { this.chatUsage = this.chatSession.getUsage(); return; }
    const result = usageSchema.safeParse(value);
    if (result.success) addUsage(this.chatUsage, result.data);
  }
  chat(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    return this.perform("chat", async signal => {
      this.chatStatus = "running";
      try {
        this.addChatUsage(await this.chatSession.send({ text, workspace: this.workspace, model: this.config.models.chat ?? this.config.models.execute, limits: this.config.limits, chrome: this.config.chrome, signal, onEvent: runtime => this.emit({ type: "runtime", runtime }) }));
        this.chatStatus = "idle";
      } catch (error) {
        if (error && typeof error === "object" && "usage" in error) this.addChatUsage(error.usage);
        this.chatStatus = signal.aborted ? "paused" : "error";
        throw error;
      }
    });
  }
  resetChat(): void { this.idle(); this.chatSession.reset(); this.chatUsage = { input: 0, output: 0, cost: 0 }; this.chatStatus = "idle"; this.mode = "chat"; this.refreshDisplayInfo(); this.emit({ type: "session" }); }
  chatHistory() { return this.chatSession.history?.(); }
  async chromeControl(action: "status" | "disconnect" | "connect") {
    if (this.closed) throw new Error("当前 xloom 会话已关闭。");
    const { controlChrome } = await import("./runtime/chrome-daemon.js");
    return controlChrome({ workspace: this.workspace, config: this.config.chrome, artifactsDirectory: projectDirectory(this.workspace) }, action);
  }

  listTasks() {
    const selected = this.store ? this.store.dataDir === projectDirectory(this.workspace) ? "@legacy" : path.basename(this.store.dataDir) : null;
    return listTasks(this.workspace, selected);
  }
  storagePaths() {
    return { workspace: this.workspace, home: xloomHome(), project: projectDirectory(this.workspace), config: this.configPath,
      task: this.store?.dataDir, chats: path.join(projectDirectory(this.workspace), "chats") };
  }
  openTask(id: string): void {
    this.idle();
    const task = this.listTasks().find(item => item.id === id);
    if (!task || task.error) throw new Error(task?.error ?? "找不到该任务；使用 /tasks 查看完整 ID。");
    if (this.store?.dataDir !== task.directory) {
      const taskId = id === "@legacy" ? undefined : id;
      const saved = readSavedBoard(this.workspace, taskId ?? null);
      const store = new BlackboardStore(this.workspace, { ...saved.config, models: this.config.models, limits: this.config.limits, chrome: this.config.chrome }, { taskId });
      try { selectTask(this.workspace, taskId ?? null); } catch (error) { store.close(); throw error; }
      this.attach(store);
    }
    this.mode = "run";
    this.activeRole = "decide";
    this.refreshDisplayInfo();
    this.emit({ type: "board", snapshot: this.snapshot() });
    this.emit({ type: "session" });
  }

  runGoal(goal: string): Promise<void> {
    this.idle();
    this.activeRole = "decide";
    const config = projectConfigSchema.parse({ ...this.config, goal: goal.trim(), scope: goal.trim(), context: "" });
    this.createTask(config);
    return this.perform("run", async () => this.loop!.start());
  }
  private createTask(config: ProjectConfig): void {
    const taskId = `task-${randomUUID()}`;
    const store = new BlackboardStore(this.workspace, config, { taskId });
    try { selectTask(this.workspace, taskId); } catch (error) { store.close(); throw error; }
    this.attach(store);
    this.emit({ type: "board", snapshot: store.snapshot() });
  }
  start(): Promise<void> {
    this.idle();
    this.activeRole = "decide";
    if (!this.loop) {
      if (this.config.goal === CHAT_GOAL) throw new Error("尚无红队任务，请输入 /run 目标。");
      this.createTask(this.config);
    }
    return this.perform("run", async () => this.loop!.start());
  }
  pause(): void { this.cancellation?.abort(); if (this.mode === "run") this.loop?.pause(); this.emit({ type: "session" }); }
  stop(): void { this.cancellation?.abort(); if (this.mode === "run") this.loop?.stop(); this.emit({ type: "session" }); }
  hint(content: string): void { if (!this.loop) throw new Error("尚无黑板，请先 /run 目标。"); this.loop.hint(content); }
  requestMetacog(): void {
    if (!this.loop) throw new Error("尚无红队任务，请先 /run 目标。");
    if (this.active) {
      if (this.mode !== "run") throw new Error("聊天尚未结束，请先 /pause。");
      this.loop.requestMetacog();
    } else {
      void this.perform("run", async () => { this.loop!.requestMetacog(); await this.loop!.waitForIdle(); }).catch(error => this.emit({ type: "notice", message: error instanceof Error ? error.message : String(error) }));
    }
  }
  async waitForIdle(): Promise<void> { await this.active?.catch(() => undefined); await this.loop?.waitForIdle(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.displayRequest?.abort();
    this.cancellation?.abort();
    this.closing = Promise.resolve().then(async () => {
      // Chat and settings cancellation must retain an idle task's diagnosis.
      try {
        if (this.active && this.mode === "run" && this.store?.snapshot().status === "running") this.stop();
        await this.waitForIdle();
      }
      finally {
        try { if (this.chatSession.close) this.chatSession.close(); else this.chatSession.reset(); this.detachLoop?.(); this.store?.close(); }
        finally { this.lock.close(); }
      }
    });
    return this.closing;
  }

  async getModels() {
    return this.settings.listModels(Object.values(this.config.models).filter((model): model is ModelConfig => Boolean(model)));
  }
  getProviders() { return this.settings.listProviders(); }
  private persistModels(models: ProjectConfig["models"]): void {
    const config = projectConfigSchema.parse({ ...this.config, models });
    saveConfig(this.configPath, config);
    try { this.store?.updateModels(config.models); }
    catch {
      try { saveConfig(this.configPath, this.config); }
      catch { throw new Error("模型配置已保存，但当前黑板同步失败且无法恢复配置。请退出并重启 xloom 后核对模型设置。"); }
      throw new Error("模型设置未应用：当前黑板更新失败，配置已恢复。请检查本地存储后重试。");
    }
    this.config = config;
    this.chatSession.reset();
    this.chatUsage = { input: 0, output: 0, cost: 0 };
    this.refreshDisplayInfo(true);
    this.emit({ type: "session" });
  }
  selectModel(provider: string, model: string, role: "all" | "chat" | "decide" | "execute" = "all", signal?: AbortSignal): Promise<void> {
    return this.perform(this.mode, async signal => {
      const models = await this.getModels();
      signal.throwIfAborted();
      if (!models.some(item => item.provider === provider && item.model === model)) throw new Error("模型不在 Xloom 已接入目录中。请先使用 /login 登录或 /apikey 配置对应供应商，再使用 /model 选择模型。");
      const next = structuredClone(this.config.models);
      // Keep this model's explicit endpoint/credential overrides; other choices
      // use Pi defaults instead of inheriting another model's endpoint/limits.
      const configured = Object.values(this.config.models).find(item => item?.provider === provider && item.model === model && (item.api || item.baseUrl || item.apiKeyEnv));
      for (const target of role === "all" ? ["chat", "decide", "execute"] as const : [role]) next[target] = configured ? { ...configured } : { provider, model };
      this.persistModels(next);
    }, signal);
  }
  private useStoredCredential(provider: string): void {
    const models = structuredClone(this.config.models);
    for (const model of Object.values(models)) if (model?.provider === provider) delete model.apiKeyEnv;
    this.persistModels(models);
  }
  saveApiKey(provider: string, key: string, externalSignal?: AbortSignal): Promise<void> {
    return this.perform(this.mode, async signal => { await this.settings.saveApiKey(provider, key, signal); signal.throwIfAborted(); this.useStoredCredential(provider); }, externalSignal);
  }
  login(provider: string, interaction: AuthInteraction, type: AuthType = "oauth"): Promise<void> {
    return this.perform(this.mode, async signal => {
      const combined = interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal;
      await this.settings.login(provider, { ...interaction, signal: combined }, type);
      combined.throwIfAborted();
      this.useStoredCredential(provider);
    });
  }
  logout(provider: string, externalSignal?: AbortSignal): Promise<void> {
    return this.perform(this.mode, async signal => {
      await this.settings.logout(provider, signal);
      signal.throwIfAborted();
      this.chatSession.reset();
      this.chatUsage = { input: 0, output: 0, cost: 0 };
      this.refreshDisplayInfo(true);
    }, externalSignal);
  }
}
