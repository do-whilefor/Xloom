import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { visibleWidth, type Editor, type Terminal, type TuiAltScreen } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent } from "../src/types.js";
import { runTui } from "../src/ui/index.js";
import { EventFeed, plainText, statusLine, type UiController } from "../src/ui/model.js";
import { SettingsDialogs, SettingsPanel } from "../src/ui/settings-dialog.js";
import { WORK_PULSE_INTERVAL_MS } from "../src/ui/feed-view.js";

class MemoryTerminal implements Terminal {
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  columns = 90;
  rows = 26;
  kittyProtocolActive = false;
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}
const cleanup: (() => Promise<void>)[] = [];
const fixtureWorkspace = "C:\\xloom-fixture";
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function launch(options: { now?: () => number; restoredReason?: string } = {}) {
  const board: BoardSnapshot = {
    revision: 0, status: "idle", outcome: null, reason: "", completedSteps: 0, noProgressCount: 0,
    lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 0, output: 0, cost: 0 },
    config: { version: 1, title: "xloom", goal: "stored task", scope: "localhost", context: "",
      models: { decide: { provider: "test", model: "test" }, execute: { provider: "test", model: "test" } },
      limits: { maxNoProgress: 3, maxMinutes: null, maxTokens: null, maxCost: null, maxTurnsPerRun: 5, stepTimeoutSeconds: 60, metacogEvery: 3 } },
    goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [],
  };
  const listeners = new Set<(event: LoopEvent) => void>();
  if (options.restoredReason) { board.status = "stopped"; board.reason = options.restoredReason; }
  const info = { mode: "chat" as "chat" | "run", busy: false, model: "opencode-go/deepseek-v4-flash" };
  const controller = {
    snapshot: vi.fn(() => board),
    subscribe: vi.fn((listener: (event: LoopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    start: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), hint: vi.fn(), requestMetacog: vi.fn(),
    chat: vi.fn(async (_text: string) => {}), runGoal: vi.fn(async (_text: string) => {}), resetChat: vi.fn(),
    getSessionInfo: vi.fn(() => info),
    getModels: vi.fn(async () => [
      { provider: "anthropic", model: "claude-sonnet-4", name: "Claude Sonnet" },
      { provider: "opencode-go", model: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ]),
    getProviders: vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", authTypes: ["api_key", "oauth"] },
      { id: "opencode-go", name: "OpenCode Go", authTypes: ["api_key"] },
    ]),
    selectModel: vi.fn(async (_provider: string, _model: string, _role?: string, _signal?: AbortSignal) => {}), saveApiKey: vi.fn(async (_provider: string, _key: string, _signal?: AbortSignal) => {}),
    login: vi.fn(async (_provider: string, _interaction: AuthInteraction) => {}), logout: vi.fn(async (_provider: string, _signal?: AbortSignal) => {}),
  } satisfies UiController;
  const terminal = new MemoryTerminal();
  const clipboard = { readText: vi.fn(async () => "PRIVATE_CLIPBOARD_KEY"), writeText: vi.fn(async () => true) };
  let controls!: { editor: Editor; tui: TuiAltScreen };
  const session = runTui(controller, terminal, { clipboard, workspace: fixtureWorkspace, now: options.now, onReady: value => { controls = value; } });
  const submit = (text: string): void => { controls.editor.setText(text); terminal.input("\r"); };
  const close = async (): Promise<void> => {
    if (!terminal.stopped) {
      if (controls.tui.hasOverlay()) { terminal.input("\x1b"); await vi.waitFor(() => expect(controls.tui.hasOverlay()).toBe(false)); }
      submit("/exit");
    }
    await session;
  };
  cleanup.push(close);
  const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { ...controls, board, info, controller, terminal, clipboard, submit, close, settled, session, listeners };
}

// Auth remains a supported Pi adapter. Test its dialog directly now that the
// TUI no longer exposes login/logout slash commands.
function launchAuthDialogs() {
  const app = launch();
  const print = vi.fn();
  const dialogs = new SettingsDialogs(app.controller, app.tui, app.clipboard, print);
  const pending = new Set<Promise<void>>();
  const openAuth = (command: "login" | "logout", provider: string): void => {
    const task = dialogs.open(command, provider);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  cleanup.push(async () => { dialogs.cancel(); await Promise.allSettled([...pending]); await dialogs.waitForIdle(); });
  return { ...app, openAuth, print };
}

describe("ordinary chat and dual-agent task UI", () => {
  it("leaves two blank screen rows before the flush-left first user message", async () => {
    const app = launch();
    app.submit("你是什么模型？");
    await app.settled();
    app.terminal.output = "";
    app.tui.renderNow(true);
    const rows = new Map([...app.terminal.output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)]
      .map(match => [Number(match[1]), plainText(match[2]!).trimEnd()]));
    expect(rows.get(3)).toContain(fixtureWorkspace);
    expect(rows.get(4)).toBe("");
    expect(rows.get(5)).toBe("");
    expect(rows.get(6)).toBe("❯ 你是什么模型？");
  });

  it("renders live tokens in a narrow footer and replaces pending tokens with committed usage once", async () => {
    const app = launch();
    app.terminal.columns = 62;
    const usage = { input: 100, output: 20, cost: 3, cacheRead: 50 };
    app.controller.getSessionInfo.mockImplementation(() => ({ ...app.info, usage }));
    const emit = (event: LoopEvent): void => { for (const listener of app.listeners) listener(event); };
    const screen = (): string => { app.terminal.output = ""; app.tui.renderNow(true); return plainText(app.terminal.output); };
    let finish!: () => void;
    app.controller.chat.mockImplementation(async () => { app.info.busy = true; await new Promise<void>(resolve => { finish = resolve; }); });
    app.submit("inspect local tests");
    emit({ type: "runtime", runtime: { type: "usage", mode: "chat", text: "", usage: { input: 40, output: 10, cost: 1, cacheRead: 20 } } });
    expect(screen()).toContain("chat · running · I 140 · O 30 · C 70 · H 50.0%");
    expect(screen()).not.toMatch(/费用|\$/);
    usage.input += 40;
    usage.output += 10;
    usage.cacheRead += 20;
    app.info.busy = false;
    emit({ type: "session" });
    finish();
    await app.settled();
    expect(screen()).toContain("chat · idle · I 140 · O 30 · C 70 · H 50.0%");
    expect(screen()).not.toContain("I 180");
  });

  it("shows chat status without resurrecting the stored task and labels chat runtime distinctly", () => {
    const app = launch();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("chat · idle");
    expect(plainText(app.terminal.output)).not.toContain("stored task");
    expect(statusLine(app.board, app.info)).toContain("deepseek-v4-flash");
    expect(statusLine(app.board, { ...app.info, usage: { input: 7, output: 5, cost: 0.1 } })).toContain("I 7 · O 5");
    expect(statusLine(app.board, { ...app.info, usage: { input: 7, output: 5, cost: 0.1 } })).not.toMatch(/\$|费用/);
    const feed = new EventFeed();
    feed.runtime({ type: "text", mode: "chat", text: "hello" });
    feed.runtime({ type: "tool_start", mode: "chat", toolName: "read", text: "read file" });
    expect(feed.entries.map(entry => entry.label)).toEqual(["Assistant", "Read"]);
    expect(feed.entries.map(entry => entry.kind)).toEqual(["message", "tool"]);
  });

  it("routes normal text, /run goal and /hint independently", async () => {
    const app = launch();
    app.submit("hello model");
    expect(app.controller.chat).toHaveBeenCalledWith("hello model");
    expect(app.controller.hint).not.toHaveBeenCalled();
    await app.settled();
    app.submit("/run https://localhost 对象边界");
    expect(app.controller.runGoal).toHaveBeenCalledWith("https://localhost 对象边界");
    app.submit("/hint account A");
    expect(app.controller.hint).toHaveBeenCalledWith("account A");
    await app.settled();
    app.submit("/new");
    expect(app.controller.resetChat).toHaveBeenCalledOnce();
  });

  it("rejects new messages/settings while busy without converting them to hints", () => {
    const app = launch();
    app.info.busy = true;
    for (const command of ["new chat", "/run new task", "/model"]) app.submit(command);
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.runGoal).not.toHaveBeenCalled();
    expect(app.controller.getModels).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("/pause");
  });

  it("keeps removed commands from opening settings, changing details, or exiting", async () => {
    const app = launch();
    for (const listener of app.listeners) {
      listener({ type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "removed", text: "REMOVED_COMMAND_THOUGHT" } });
      listener({ type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "removed", text: "" } });
    }
    for (const command of ["/login", "/logout", "/login anthropic", "/logout anthropic", "/details", "/quit"]) app.submit(command);
    await app.settled();
    app.tui.renderNow(true);
    expect(app.controller.getProviders).not.toHaveBeenCalled();
    expect(app.controller.login).not.toHaveBeenCalled();
    expect(app.controller.logout).not.toHaveBeenCalled();
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.terminal.stopped).toBe(false);
    expect(plainText(app.terminal.output)).not.toContain("REMOVED_COMMAND_THOUGHT");
    app.terminal.input("\x0f");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("REMOVED_COMMAND_THOUGHT");
  });

  it("aborts active chat on exit and waits until cancellation settles", async () => {
    const app = launch();
    let release!: () => void;
    app.controller.chat.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    app.submit("in flight");
    app.submit("/exit");
    expect(app.controller.stop).toHaveBeenCalledOnce();
    expect(app.terminal.stopped).toBe(false);
    release();
    await app.session;
    expect(app.terminal.stopped).toBe(true);
  });
});

describe("Claude-style response timeline", () => {
  const emit = (app: ReturnType<typeof launch>, event: LoopEvent): void => { for (const listener of app.listeners) listener(event); };
  const screen = (app: ReturnType<typeof launch>): string => {
    app.terminal.output = "";
    app.tui.renderNow(true);
    // Check actual terminal bytes, not stripped text: native link styling must never reach the screen.
    // Pi also emits a generic link reset on every row; those harmless closes remain intact.
    expect(app.terminal.output).not.toMatch(/\x1b\]8;[^;]*;[^\x1b\x07]+/);
    return plainText(app.terminal.output);
  };

  it("does not show a stopped task's recovery reason when opening ordinary chat", () => {
    const app = launch({ restoredReason: "Stopped by user; state and evidence retained." });
    expect(screen(app)).not.toContain("Stopped by user");
    expect(screen(app)).toContain("chat · idle");
    expect(app.controller.stop).not.toHaveBeenCalled();
  });

  it("shows actual thought timing, a plain answer and the final duration after an asynchronous chat", async () => {
    let now = new Date(2026, 8, 12, 17, 21, 0).getTime();
    const app = launch({ now: () => now });
    let release!: () => void;
    app.controller.chat.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    app.submit("你是什么模型？");
    expect(screen(app)).toContain("Working… 0s");
    expect(screen(app)).not.toContain("Thought");
    emit(app, { type: "runtime", runtime: { type: "thinking_start", mode: "chat", blockId: "a", text: "" } });
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "a", text: "PROVIDER_THINKING" } });
    now += 6000;
    emit(app, { type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "a", text: "" } });
    emit(app, { type: "runtime", runtime: { type: "text", mode: "chat", text: "我是当前配置的测试模型。" } });
    release();
    await app.settled();
    const output = screen(app);
    expect(output).toContain("Thought for 6s");
    expect(output).toContain("Worked for 6s · done 17:21");
    expect(output).toContain("我是当前配置的测试模型");
    expect(output).not.toContain("● 我是");
    expect(output).not.toContain("PROVIDER_THINKING");
    expect(output.indexOf("Worked for")).toBeGreaterThan(output.indexOf("我是当前配置"));
    app.terminal.input("\x14");
    expect(screen(app)).toContain("∴ PROVIDER_THINKING");
    app.terminal.input("\x14");
    expect(screen(app)).not.toContain("PROVIDER_THINKING");
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it.each(["done", "paused", "error", "exit"] as const)("animates without provider events and stops refreshing after %s", async outcome => {
    vi.useFakeTimers();
    const app = launch({ now: () => Date.now() });
    let release: () => void = () => {};
    let reject!: (error: Error) => void;
    try {
      app.controller.chat.mockImplementation(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
      const requestRender = vi.spyOn(app.tui, "requestRender");
      app.submit("你是什么模型？");
      expect(screen(app)).toContain("· Working… 0s");
      requestRender.mockClear();
      app.terminal.output = "";
      // Let the interval and Pi's queued render run without another model event.
      await vi.advanceTimersByTimeAsync(WORK_PULSE_INTERVAL_MS + 20);
      expect(requestRender).toHaveBeenCalledOnce();
      expect(plainText(app.terminal.output)).toContain("∗ Working… 0s");
      app.terminal.output = "";
      await vi.advanceTimersByTimeAsync(WORK_PULSE_INTERVAL_MS);
      expect(plainText(app.terminal.output)).toContain("✻ Working… 0s");
      expect(app.controller.chat).toHaveBeenCalledExactlyOnceWith("你是什么模型？");
      expect(app.controller.start).not.toHaveBeenCalled();
      expect(app.controller.runGoal).not.toHaveBeenCalled();

      if (outcome === "paused") app.terminal.input("\x1b");
      if (outcome === "exit") app.submit("/exit");
      if (outcome === "error") reject(new Error("Request timed out."));
      else release();
      await app.settled();
      if (outcome === "exit") await app.session;
      else {
        expect(screen(app)).toContain(`· ${outcome}`);
        expect(screen(app)).not.toContain("Working…");
      }
      // Drain the final frame, then check that idle/closed sessions no longer tick.
      await vi.advanceTimersByTimeAsync(20);
      requestRender.mockClear();
      app.terminal.output = "";
      await vi.advanceTimersByTimeAsync(6 * WORK_PULSE_INTERVAL_MS);
      expect(requestRender).not.toHaveBeenCalled();
      expect(app.terminal.output).toBe("");
    } finally {
      release();
      await app.close();
      vi.useRealTimers();
    }
  });

  it("handles real mouse clicks on thinking headers without submitting text or copying a click", async () => {
    const app = launch();
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "click", text: "CLICK_THOUGHT" } });
    emit(app, { type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "click", text: "" } });
    screen(app);
    // Three header rows and two blank rows precede the flush-left thought row 6.
    app.terminal.input("\x1b[<0;1;6M");
    app.terminal.input("\x1b[<0;1;6m");
    expect(screen(app)).toContain("CLICK_THOUGHT");
    expect(app.clipboard.writeText).not.toHaveBeenCalled();
    expect(app.controller.chat).not.toHaveBeenCalled();
    // Moving while held is selection, not a toggle.
    app.terminal.input("\x1b[<0;3;6M");
    app.terminal.input("\x1b[<32;8;6M");
    app.terminal.input("\x1b[<0;8;6m");
    await vi.waitFor(() => expect(app.clipboard.writeText).toHaveBeenCalled());
    expect(screen(app)).toContain("CLICK_THOUGHT");
  });

  it("collapses only the clicked expanded group and preserves drag-copy on its tool output", async () => {
    const app = launch();
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "body", text: "FIRST_THOUGHT" } });
    emit(app, { type: "runtime", runtime: { type: "tool_start", mode: "chat", toolName: "read", toolCallId: "body-read", text: '{"path":"fixture.txt"}' } });
    emit(app, { type: "runtime", runtime: { type: "tool_end", mode: "chat", toolName: "read", toolCallId: "body-read", text: "TOOL_RESULT\nSECOND_OUTPUT_LINE" } });
    emit(app, { type: "runtime", runtime: { type: "text", mode: "chat", text: "First result." } });
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "other", text: "OTHER_THOUGHT" } });
    emit(app, { type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "other", text: "" } });
    app.terminal.input("\x0f");
    const renderedRow = (text: string): number => {
      screen(app);
      // Inspect physical row writes, so headers, wrapping and scrolling are reflected.
      const rows = [...app.terminal.output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)];
      const row = rows.find(match => plainText(match[2]!).includes(text));
      expect(row, `Rendered row containing ${text}`).toBeDefined();
      return Number(row![1]);
    };
    const click = (text: string): void => {
      const row = renderedRow(text);
      app.terminal.input(`\x1b[<0;6;${row}M`);
      app.terminal.input(`\x1b[<0;6;${row}m`);
    };
    const row = renderedRow("TOOL_RESULT");
    app.terminal.input(`\x1b[<0;3;${row}M`);
    app.terminal.input(`\x1b[<32;12;${row}M`);
    app.terminal.input(`\x1b[<0;12;${row}m`);
    await vi.waitFor(() => expect(app.clipboard.writeText).toHaveBeenCalled());
    expect(app.clipboard.writeText.mock.calls[0]?.[0]).toContain("TOOL_RESUL");
    expect(app.clipboard.writeText.mock.calls[0]?.[0]).not.toContain("xloom-thinking:");
    expect(screen(app)).toContain("SECOND_OUTPUT_LINE");
    app.clipboard.writeText.mockClear();
    click("SECOND_OUTPUT_LINE");
    expect(screen(app)).not.toContain("FIRST_THOUGHT");
    expect(screen(app)).not.toContain("SECOND_OUTPUT_LINE");
    expect(screen(app)).toContain("OTHER_THOUGHT");
    click("OTHER_THOUGHT");
    expect(screen(app)).not.toContain("OTHER_THOUGHT");
    expect(app.clipboard.writeText).not.toHaveBeenCalled();
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("renders provider timeouts as failures, not successful or fabricated thinking", async () => {
    let now = 1000;
    const app = launch({ now: () => now });
    app.controller.chat.mockImplementation(async () => { now = 7000; throw new Error("Request timed out."); });
    app.submit("hello");
    await app.settled();
    const output = screen(app);
    expect(output).toContain("模型服务请求超时");
    expect(output).toContain("Worked for 6s · error");
    expect(output).not.toContain("· done");
    expect(output).not.toContain("Thought");
  });

  it("closes thought timing and marks a cancelled chat paused, not done", async () => {
    let now = 1000;
    const app = launch({ now: () => now });
    let reject!: (error: Error) => void;
    app.controller.chat.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    app.controller.pause.mockImplementation(() => { reject(new Error("The operation was aborted")); });
    app.submit("hello");
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "cancel", text: "partial provider thought" } });
    now += 6000;
    app.terminal.input("\x1b");
    await app.settled();
    const output = screen(app);
    expect(output).toContain("Thought for 6s");
    expect(output).toContain("Worked for 6s · paused");
    expect(output).not.toContain("· done");
    now += 2000;
    expect(screen(app)).toContain("Worked for 6s · paused");
  });

  it("keeps thought clicks correct after scrolling the conversation", () => {
    const app = launch();
    for (let index = 0; index < 40; index++) emit(app, { type: "notice", message: `earlier ${index}` });
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "scroll", text: "SCROLLED_THOUGHT" } });
    emit(app, { type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "scroll", text: "" } });
    screen(app);
    expect(app.tui.viewportTop).toBeGreaterThan(0);
    // Header + two blank rows + 40 notices + blank group separator + thought header.
    const row = 47 - app.tui.viewportTop;
    app.terminal.input(`\x1b[<0;1;${row}M`);
    app.terminal.input(`\x1b[<0;1;${row}m`);
    expect(screen(app)).toContain("SCROLLED_THOUGHT");
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it.each([4, 8, 20, 31])("keeps summary and wrapped body clicks working without link styling at %i columns", width => {
    const app = launch();
    app.terminal.columns = width;
    emit(app, { type: "runtime", runtime: { type: "thinking", mode: "chat", blockId: "narrow", text: "BODY 中文 🧪 wrapped thought" } });
    emit(app, { type: "runtime", runtime: { type: "thinking_end", mode: "chat", blockId: "narrow", text: "" } });
    const clickRow = (marker: string): void => {
      screen(app);
      const rows = [...app.terminal.output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)];
      const row = rows.find(match => plainText(match[2]!).includes(marker));
      expect(row, `Rendered row containing ${marker}`).toBeDefined();
      app.terminal.input(`\x1b[<0;3;${row![1]}M`);
      app.terminal.input(`\x1b[<0;3;${row![1]}m`);
    };
    expect(screen(app)).not.toContain("∴");
    clickRow("▸");
    expect(screen(app)).toContain("∴");
    clickRow("∴");
    expect(screen(app)).not.toContain("∴");
    expect(app.clipboard.writeText).not.toHaveBeenCalled();
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it("keeps synchronous startup failures before the final error marker", async () => {
    const app = launch();
    app.controller.runGoal.mockImplementation(() => { throw new Error("TASK_CREATE_FAILED"); });
    app.submit("/run local task");
    await app.settled();
    const output = screen(app);
    expect(output.indexOf("TASK_CREATE_FAILED")).toBeGreaterThan(-1);
    expect(output.indexOf("Worked for")).toBeGreaterThan(output.indexOf("TASK_CREATE_FAILED"));
    expect(output).toContain("· error");
  });

  it("cannot end an active controller-owned meta response by issuing /start", async () => {
    const app = launch();
    app.info.mode = "run";
    app.info.busy = true;
    app.board.status = "running";
    emit(app, { type: "handoff", handoff: { mode: "metacog", role: "decide", runId: "meta", revision: 1, trigger: { kind: "manual", reason: "manual review" } } });
    app.submit("/start");
    await app.settled();
    expect(app.controller.start).not.toHaveBeenCalled();
    expect(screen(app)).toContain("Working…");
    expect(screen(app)).not.toContain("Worked for");
    app.info.busy = false;
    app.board.status = "completed";
    emit(app, { type: "result", result: { mode: "metacog", summary: "COMMITTED_FINAL" }, snapshot: app.board });
    await app.settled();
    const output = screen(app);
    expect(output.indexOf("Worked for")).toBeGreaterThan(output.indexOf("COMMITTED_FINAL"));
    expect(output).toContain("· done");
  });

  it("does not use a stored stopped task as the completion status of a successful chat", async () => {
    const app = launch({ restoredReason: "Stopped by user" });
    app.submit("hello");
    await app.settled();
    expect(screen(app)).toContain("· done");
    expect(screen(app)).not.toContain("· stopped");
  });
});

describe("Pi-style model and credential dialogs", () => {
  it("shows Xloom while loading provider settings", async () => {
    const app = launch();
    const providers = Promise.withResolvers<Awaited<ReturnType<typeof app.controller.getProviders>>>();
    app.controller.getProviders.mockReturnValue(providers.promise);
    app.submit("/apikey");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("正在读取 Xloom 配置");
    expect(plainText(app.terminal.output)).not.toContain("Pi");
    providers.resolve([]);
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
  });

  it("directs users to /apikey when no authenticated models are available", async () => {
    const app = launch();
    app.controller.getModels.mockResolvedValue([]);
    app.submit("/model");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("请先使用 /apikey");
    expect(app.controller.selectModel).not.toHaveBeenCalled();
  });

  it("searches the full model/provider name and switches the selected role", async () => {
    const app = launch();
    app.submit("/model decide");
    await app.settled();
    expect(app.tui.hasOverlay()).toBe(true);
    app.terminal.input("flash");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("deepseek-v4-flash");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.selectModel).toHaveBeenCalledWith("opencode-go", "deepseek-v4-flash", "decide", expect.any(AbortSignal)));
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it("accepts a masked API key without rendering it or recording it in editor history", async () => {
    const app = launch();
    app.submit("/board");
    app.submit("/apikey opencode-go");
    await app.settled();
    app.terminal.input("PRIVATE_TEST_KEY");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("•••");
    expect(app.terminal.output).not.toContain("PRIVATE_TEST_KEY");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_TEST_KEY", expect.any(AbortSignal)));
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("opencode-go 的 API Key 已保存");
    expect(plainText(app.terminal.output)).toContain("/model");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/board");
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("selects API provider first when /apikey has no argument", async () => {
    const app = launch();
    app.submit("/apikey");
    await app.settled();
    app.terminal.input("opencode");
    app.terminal.input("\r");
    await app.settled();
    app.terminal.input("PRIVATE_SELECTED_KEY");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_SELECTED_KEY", expect.any(AbortSignal)));
  });

  it("never saves or retains accidentally inline credentials", async () => {
    const app = launch();
    app.submit("/board");
    app.submit("/apikey opencode-go PRIVATE_INLINE_KEY");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_INLINE_KEY");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    expect(app.tui.hasOverlay()).toBe(false);
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/board");
  });

  it("pastes secrets privately and requires Enter rather than treating pasted control bytes as commands", async () => {
    const app = launch();
    app.submit("/apikey opencode-go");
    await app.settled();
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(app.clipboard.readText).toHaveBeenCalledOnce());
    await app.settled();
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_CLIPBOARD_KEY");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_CLIPBOARD_KEY", expect.any(AbortSignal)));
  });

  it("cancels API key entry on Escape without storing a key", async () => {
    const app = launch();
    app.submit("/apikey anthropic");
    await app.settled();
    app.terminal.input("PRIVATE_CANCELLED_KEY");
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.terminal.output).not.toContain("PRIVATE_CANCELLED_KEY");
  });

  it.each(["apikey", "model", "logout"] as const)("passes cancellation through an in-flight %s commit", async command => {
    const app = launchAuthDialogs();
    let signal: AbortSignal | undefined;
    const wait = (value?: AbortSignal): Promise<void> => {
      signal = value;
      return new Promise((_resolve, reject) => value!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    };
    app.controller.saveApiKey.mockImplementation((_provider, _key, value) => wait(value));
    app.controller.selectModel.mockImplementation((_provider, _model, _role, value) => wait(value));
    app.controller.logout.mockImplementation((_provider, value) => wait(value));
    if (command === "logout") app.openAuth("logout", "anthropic");
    else app.submit(command === "model" ? "/model" : "/apikey anthropic");
    await app.settled();
    if (command === "apikey") app.terminal.input("PRIVATE_KEY_IN_FLIGHT");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(signal).toBeDefined());
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(true);
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).not.toContain("PRIVATE_KEY_IN_FLIGHT");
    if (command === "logout") expect(app.print).toHaveBeenCalledWith("xloom", "设置已取消。", false);
    else expect(plainText(app.terminal.output)).toContain("设置已取消");
  });

  it("does not save an old draft when Enter races a private clipboard read", async () => {
    const app = launch();
    let resolve!: (text: string) => void;
    app.clipboard.readText.mockImplementation(() => new Promise(done => { resolve = done; }));
    app.submit("/apikey anthropic");
    await app.settled();
    app.terminal.input("OLD");
    app.terminal.input("\x16");
    app.terminal.input("\r");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(app.clipboard.readText).toHaveBeenCalledOnce());
    app.terminal.input("\x03");
    app.terminal.input("NEW_KEY");
    resolve("STALE_SECRET");
    await app.settled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("anthropic", "NEW_KEY", expect.any(AbortSignal)));
  });

  it("honors cancellation while a provider catalog is loading before starting login", async () => {
    const app = launchAuthDialogs();
    let resolve!: (providers: Awaited<ReturnType<typeof app.controller.getProviders>>) => void;
    app.controller.getProviders.mockImplementation(() => new Promise(done => { resolve = done; }));
    app.openAuth("login", "anthropic");
    app.terminal.input("\x1b");
    resolve([{ id: "anthropic", name: "Anthropic", authTypes: ["oauth"] }]);
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.login).not.toHaveBeenCalled();
  });

  it("uses Pi auth interactions and hides login codes from feed/history", async () => {
    const app = launchAuthDialogs();
    let code = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example/login?state=PRIVATE_AUTH_STATE", instructions: "请打开此登录链接" });
      code = await interaction.prompt({ type: "manual_code", message: "登录码" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("PRIVATE_LOGIN_CODE");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_LOGIN_CODE");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(code).toBe("PRIVATE_LOGIN_CODE");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_AUTH_STATE");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("");
  });

  it.each(["auth_url", "device_code", "info"] as const)("copies exact raw %s login URLs without wrapping or terminal-control content", async type => {
    const app = launchAuthDialogs();
    const url = `https://auth.example/login?state=${"a".repeat(180)}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback`;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify(type === "auth_url" ? { type, url, instructions: "Browser opened automatically\x1b[2J" }
        : type === "device_code" ? { type, verificationUri: url, userCode: "CODE" }
          : { type, message: "Login", links: [{ url, label: "Browser" }] });
      await interaction.prompt({ type: "manual_code", message: "Paste code" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("本界面不自动打开浏览器");
    expect(plainText(app.terminal.output)).toContain("Ctrl+L");
    app.terminal.input("\x0c");
    await vi.waitFor(() => expect(app.clipboard.writeText).toHaveBeenCalledWith(url));
    expect(app.clipboard.writeText.mock.calls[0]?.[0]).not.toMatch(/[\n\r\x1b]/);
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "https://auth.example/?state=secret\x1b[2J", "https://auth.example/\nsecret"])("does not copy an unsafe or control-bearing auth URL %j", async url => {
    const app = launchAuthDialogs();
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url });
      await interaction.prompt({ type: "manual_code", message: "Code" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("\x0c");
    await app.settled();
    expect(app.clipboard.writeText).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).not.toContain("Ctrl+L");
  });

  it("filters auth providers to OAuth and rejects API-only providers", async () => {
    const app = launchAuthDialogs();
    app.openAuth("login", "opencode-go");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.login).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(app.print).toHaveBeenCalledWith("xloom", expect.stringContaining("不支持此认证方式"), true);
  });

  it("allows an empty OAuth text prompt for the default GitHub Copilot domain", async () => {
    const app = launchAuthDialogs();
    let domain: string | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(domain).toBe("");
  });

  it("shows non-secret OAuth text only in the current dialog, never in chat/history", async () => {
    const app = launchAuthDialogs();
    let domain = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("github.example.test");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("github.example.test");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(domain).toBe("github.example.test");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("github.example.test");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("");
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it.each(["secret", "manual_code"] as const)("continues to require non-empty, masked OAuth %s input", async type => {
    const app = launchAuthDialogs();
    let entered: string | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      entered = await interaction.prompt({ type, message: "Enter credential" });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("\r");
    await app.settled();
    expect(app.tui.hasOverlay()).toBe(true);
    expect(entered).toBeUndefined();
    app.terminal.input("PRIVATE_NONEMPTY_CREDENTIAL");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_NONEMPTY_CREDENTIAL");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(entered).toBe("PRIVATE_NONEMPTY_CREDENTIAL");
  });

  it("supports Pi login option selectors and keeps device-code notifications transient", async () => {
    const app = launchAuthDialogs();
    let selected = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "device_code", userCode: "DEVICE-CODE", verificationUri: "https://auth.example/device" });
      selected = await interaction.prompt({ type: "select", message: "Choose account", options: [
        { id: "personal", label: "Personal" }, { id: "business", label: "Business" },
      ] });
    });
    app.openAuth("login", "anthropic");
    await app.settled();
    app.terminal.input("\x1b[B");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(selected).toBe("business");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("DEVICE-CODE");
  });

  it("propagates Escape cancellation to the OAuth flow", async () => {
    const app = launchAuthDialogs();
    let signal: AbortSignal | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "secret", message: "Enter secret" });
    });
    app.openAuth("login", "anthropic");
    await vi.waitFor(() => expect(signal).toBeDefined());
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(true);
  });

  it("aborts pending API key save during terminal exit and restores terminal", async () => {
    const app = launch();
    let signal: AbortSignal | undefined;
    app.controller.saveApiKey.mockImplementation(async (_provider, _key, operationSignal) => {
      signal = operationSignal;
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    app.submit("/apikey anthropic");
    await app.settled();
    app.terminal.input("PRIVATE_PENDING_KEY");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(signal).toBeDefined());
    process.emit("SIGTERM");
    await app.session;
    expect(signal?.aborted).toBe(true);
    expect(app.terminal.stopped).toBe(true);
  });

  it("handles callback-cancelled auth prompts without cancelling the whole flow", async () => {
    const app = launchAuthDialogs();
    const promptAbort = new AbortController();
    let signal: AbortSignal | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Code", signal: promptAbort.signal }).catch(() => {});
    });
    app.openAuth("login", "anthropic");
    await vi.waitFor(() => expect(signal).toBeDefined());
    promptAbort.abort();
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(false);
  });

  it("requires confirmation for logout and keeps provider error details private", async () => {
    const app = launchAuthDialogs();
    app.controller.logout.mockRejectedValue(new Error("PRIVATE_PROVIDER_ERROR"));
    app.openAuth("logout", "anthropic");
    await app.settled();
    expect(app.controller.logout).not.toHaveBeenCalled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.logout).toHaveBeenCalledWith("anthropic", expect.any(AbortSignal));
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_PROVIDER_ERROR");
  });
});

describe("private settings input component", () => {
  it.each(["text", "select"] as const)("discards secret kill-ring and undo data before a new %s prompt", type => {
    const submitted = vi.fn();
    const panel = new SettingsPanel("Login", () => {});
    panel.focused = true;
    panel.setPrompt("Secret", { secret: true }, submitted);
    panel.handleInput("SYNTHETIC_PRIVATE_KEY");
    panel.handleInput("\x15");
    panel.setPrompt("Next prompt", type === "text" ? { allowEmpty: true } : { items: [{ value: "ok", label: "Continue" }] }, submitted);
    expect(panel.focused).toBe(true);
    panel.handleInput("\x19");
    panel.handleInput("\x1a");
    expect(panel.render(90).join("\n")).not.toContain("SYNTHETIC_PRIVATE_KEY");
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith(type === "text" ? "" : "ok");
    panel.setPrompt("Another secret", { secret: true }, submitted);
    panel.handleInput("SYNTHETIC_DISPOSED_KEY");
    panel.handleInput("\x15");
    panel.clear();
    panel.setPrompt("After clear", { allowEmpty: true }, submitted);
    panel.handleInput("\x19");
    expect(panel.render(90).join("\n")).not.toContain("SYNTHETIC_DISPOSED_KEY");
  });

  it("never renders secret text even in narrow terminals", () => {
    const panel = new SettingsPanel("API Key", () => {});
    panel.focused = true;
    panel.setPrompt("秘密输入", { secret: true }, () => {});
    panel.handleInput("SUPER_PRIVATE_VALUE");
    for (const width of [0, 1, 2, 4, 20, 90]) {
      const lines = panel.render(width);
      expect(lines.join("\n")).not.toContain("SUPER_PRIVATE_VALUE");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("treats split bracketed paste as text, supports Ctrl+C clearing, and ignores stale paste", () => {
    const submitted = vi.fn();
    const panel = new SettingsPanel("API Key", () => {});
    panel.setPrompt("Key", { secret: true }, submitted);
    const old = panel.version;
    panel.handleInput("\x1b[200~secret\r\n");
    panel.handleInput("\x03");
    panel.handleInput("\x1b[201~");
    expect(submitted).not.toHaveBeenCalled();
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith("secret");
    panel.handleInput("\x03");
    panel.setPrompt("New key", { secret: true }, submitted);
    panel.paste("STALE_KEY", old);
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledOnce();
  });
});
