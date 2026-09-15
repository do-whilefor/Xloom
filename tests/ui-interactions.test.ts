import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth, type Editor, type Terminal, type TuiAltScreen } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent } from "../src/types.js";
import type { Clipboard } from "../src/ui/clipboard.js";
import { runTui } from "../src/ui/index.js";
import { plainText, type UiController } from "../src/ui/model.js";

class MemoryTerminal implements Terminal {
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  kittyProtocolActive = false;
  constructor(public columns = 90, public rows = 24) {}
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resize = onResize; }
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

function snapshot(): BoardSnapshot {
  return {
    revision: 2, status: "idle", outcome: null, reason: "", completedSteps: 1, noProgressCount: 0,
    lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 100, output: 80, cost: 0.02 },
    config: { version: 1, title: "界面测试", goal: "验证 TUI 交互", scope: "localhost", context: "",
      models: { decide: { provider: "test", model: "test" }, execute: { provider: "test", model: "test" } },
      limits: { maxNoProgress: 3, maxMinutes: 10, maxTokens: 10000, maxCost: 1, maxTurnsPerRun: 5, stepTimeoutSeconds: 60, metacogEvery: 3 } },
    goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [],
  };
}

const cleanup: (() => Promise<void>)[] = [];
const fixtureWorkspace = "C:\\xloom-fixture";
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function launch(clipboard: Clipboard = { readText: vi.fn(async () => "剪贴板文本"), writeText: vi.fn(async () => true) }, columns = 90, rows = 24, chat = false, workspace = fixtureWorkspace) {
  const board = snapshot();
  const listeners = new Set<(event: LoopEvent) => void>();
  const controller = {
    snapshot: vi.fn(() => board),
    subscribe: vi.fn((listener: (event: LoopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    start: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), hint: vi.fn(), requestMetacog: vi.fn(),
    ...(chat ? { getSessionInfo: () => ({ mode: "chat" as const, busy: false, model: "test/test", status: board.status, usage: board.usage }) } : {}),
  } satisfies UiController;
  const terminal = new MemoryTerminal(columns, rows);
  let controls!: { editor: Editor; tui: TuiAltScreen };
  const session = runTui(controller, terminal, { clipboard, workspace, onReady: (value) => { controls = value; } });
  const close = async (): Promise<void> => {
    if (!terminal.stopped) {
      controls.editor.disableSubmit = false;
      controls.editor.setText("/exit");
      terminal.input("\r");
    }
    await session;
  };
  cleanup.push(close);
  const submit = (text: string): void => { controls.editor.setText(text); terminal.input("\r"); };
  const emit = (event: LoopEvent): void => { for (const listener of listeners) listener(event); };
  return { ...controls, board, controller, terminal, clipboard, session, close, submit, emit };
}

describe("TUI layout and input history", () => {
  it("shows the dotted X session header and status without the removed intro or static help footer", () => {
    const app = launch();
    app.tui.renderNow(true);
    const screen = plainText(app.terminal.output);
    expect(screen).toContain("Xloom v");
    expect(screen).toContain("⠙⢿⣦⣀⣴⡿⠋");
    expect(screen).toContain("test/test");
    expect(screen).toContain(fixtureWorkspace);
    expect(screen).toContain("idle");
    expect(screen).toContain("I 100 · O 80");
    expect(screen).toContain("step 1");
    expect(screen).not.toMatch(/step \d+\//);
    expect(screen).not.toContain("双 Agent");
    expect(screen).not.toContain("黑板协作");
    expect(screen).not.toContain("输入 /start");
    expect(screen).not.toContain("/help · /start · /board");
  });

  it.each([4, 5, 6, 8])("keeps input usable after the header shrinks to a %i-row terminal", rows => {
    const app = launch(undefined, 40, rows);
    app.editor.setText("short draft");
    app.tui.renderNow(true);
    expect(app.editor.getExpandedText()).toBe("short draft");
    expect(plainText(app.terminal.output)).toContain("short draft");
    app.terminal.rows = 24;
    app.terminal.resize();
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("Xloom v");
    expect(app.editor.getExpandedText()).toBe("short draft");
  });

  it.each([[8, 5], [9, 5], [10, 6], [11, 6], [12, 6], [24, 6]])("indents only the header and input while preserving spacers at %i rows", (height, firstTranscriptRow) => {
    const app = launch(undefined, 90, height, true);
    app.emit({ type: "notice", message: "FIRST_TRANSCRIPT_LINE" });
    app.terminal.input("short draft");
    app.terminal.output = "";
    app.tui.renderNow(true);
    const rows = new Map([...app.terminal.output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)]
      .map(match => [Number(match[1]), plainText(match[2]!).trimEnd()]));
    expect(rows.get(1)).toMatch(/^ ⠙/);
    expect(rows.get(3)).toContain(fixtureWorkspace);
    for (let row = 4; row < firstTranscriptRow; row++) expect(rows.get(row)).toBe("");
    expect(rows.get(firstTranscriptRow)).toBe("FIRST_TRANSCRIPT_LINE");
    expect([...rows.values()]).toContain(" short draft");
    expect(app.editor.getExpandedText()).toBe("short draft");
    expect(rows.get(height)).toContain("idle");
    expect(rows.get(height)).not.toMatch(/^\s/);
    expect(app.editor.getPaddingX()).toBe(1);
  });

  it("truncates a long checkout path without displacing the first transcript row", () => {
    const workspace = "C:\\very-long-checkout\\" + "nested\\".repeat(20);
    const app = launch(undefined, 90, 24, true, workspace);
    app.emit({ type: "notice", message: "FIRST_TRANSCRIPT_LINE" });
    app.terminal.output = "";
    app.tui.renderNow(true);
    const rows = new Map([...app.terminal.output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|$)/g)]
      .map(match => [Number(match[1]), plainText(match[2]!).trimEnd()]));
    expect(rows.get(3)).toContain("C:\\very-long-checkout\\");
    expect(rows.get(3)).toMatch(/…$/);
    expect(visibleWidth(rows.get(3)!)).toBeLessThanOrEqual(app.terminal.columns);
    expect(rows.get(4)).toBe("");
    expect(rows.get(5)).toBe("");
    expect(rows.get(6)).toBe("FIRST_TRANSCRIPT_LINE");
  });

  it("uses Up/Down for previous/next submissions and restores a multiline unsent draft", () => {
    const app = launch();
    app.submit("第一条信息");
    app.submit("第二条信息");
    app.editor.setText("尚未发送\n第二行草稿");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("第二条信息");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("第一条信息");
    app.terminal.input("\x1b[B");
    expect(app.editor.getExpandedText()).toBe("第二条信息");
    app.terminal.input("\x1b[B");
    expect(app.editor.getExpandedText()).toBe("尚未发送\n第二行草稿");
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("stores commands and deduplicates consecutive identical history entries", () => {
    const app = launch();
    app.submit("旧信息");
    app.submit("/board");
    app.submit("/board");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/board");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("旧信息");
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("retains multiline cursor movement on Alt+Up and Alt+Down", () => {
    const app = launch();
    app.submit("历史信息");
    app.editor.setText("第一行\n第二行");
    app.tui.renderNow(true);
    expect(app.editor.getCursor().line).toBe(1);
    app.terminal.input("\x1b[1;3A");
    expect(app.editor.getCursor().line).toBe(0);
    app.terminal.input("\x1b[1;3B");
    expect(app.editor.getCursor().line).toBe(1);
    expect(app.editor.getExpandedText()).toBe("第一行\n第二行");
  });

  it("keeps Alt+Enter as newline until an explicit submission", () => {
    const app = launch();
    app.editor.setText("/hint 第一行");
    app.terminal.input("\x1b\r");
    app.terminal.input("第二行");
    expect(app.editor.getExpandedText()).toBe("/hint 第一行\n第二行");
    expect(app.controller.hint).not.toHaveBeenCalled();
    app.terminal.input("\r");
    expect(app.controller.hint).toHaveBeenCalledWith("第一行\n第二行");
  });
});

describe("TUI slash candidates and compact transcript", () => {
  async function typeCommand(app: ReturnType<typeof launch>, text: string): Promise<void> {
    for (const char of text) app.terminal.input(char);
    await vi.waitFor(() => expect(app.editor.isShowingAutocomplete()).toBe(true), { interval: 1 });
  }

  it("opens on slash and navigates candidates without replacing the draft with history", async () => {
    const app = launch();
    app.submit("历史输入");
    await typeCommand(app, "/");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("/run");
    expect(plainText(app.terminal.output)).toContain("/model");
    app.terminal.input("\x1b[B");
    app.terminal.input("\x1b[B");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/");
    app.terminal.input("\t");
    expect(app.editor.getExpandedText()).toBe("/model ");
    expect(app.editor.isShowingAutocomplete()).toBe(false);
    expect(app.controller.start).not.toHaveBeenCalled();
    app.editor.setText("");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("历史输入");
  });

  it("Enter accepts a command without executing; another Enter explicitly runs it", async () => {
    const app = launch();
    await typeCommand(app, "/ex");
    app.terminal.input("\r");
    expect(app.editor.getExpandedText()).toBe("/exit");
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(false);
    app.terminal.input("\r");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("Esc closes suggestions before pausing; Ctrl+C still clears a suggested draft", async () => {
    const app = launch();
    await typeCommand(app, "/ru");
    app.terminal.input("\x1b");
    expect(app.editor.isShowingAutocomplete()).toBe(false);
    expect(app.editor.getExpandedText()).toBe("/ru");
    expect(app.controller.pause).not.toHaveBeenCalled();
    app.terminal.input("\x1b");
    expect(app.controller.pause).toHaveBeenCalledOnce();
    app.editor.setText("");
    await typeCommand(app, "/hi");
    app.terminal.input("\x03");
    expect(app.editor.getExpandedText()).toBe("");
    expect(app.editor.isShowingAutocomplete()).toBe(false);
    expect(app.controller.stop).not.toHaveBeenCalled();
  });

  it("shows committed results, keeps raw output in details, and hides running boilerplate", () => {
    const app = launch(undefined, 100, 45);
    app.emit({ type: "state", snapshot: { ...app.board, status: "running", reason: "Starting a fresh planning context" } });
    app.emit({ type: "handoff", handoff: { role: "decide", mode: "decide", revision: 2, runId: "private", trigger: { kind: "start", reason: "Verbose planning reason" } } });
    app.emit({ type: "runtime", runtime: { type: "tool_start", mode: "decide", toolName: "read", toolCallId: "t", text: '{"path":"README.md"}' } });
    app.emit({ type: "runtime", runtime: { type: "tool_end", mode: "decide", toolName: "read", toolCallId: "t", text: "RAW_FILE_BODY" } });
    app.emit({ type: "runtime", runtime: { type: "text", mode: "decide", text: '{"summary":"RAW_PROTOCOL"}' } });
    app.emit({ type: "result", result: { mode: "decide", summary: "已提交计划，下一步验证目标边界。" } });
    app.terminal.output = "";
    app.tui.renderNow(true);
    const compactScreen = plainText(app.terminal.output);
    expect(compactScreen).toContain("Read 1 file");
    expect(compactScreen).not.toContain("README.md");
    expect(compactScreen).toContain("已提交计划");
    expect(compactScreen).not.toMatch(/RAW_FILE_BODY|RAW_PROTOCOL|Starting a fresh|Verbose planning/);
    app.terminal.input("\x0f");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("README.md");
    expect(plainText(app.terminal.output)).toContain("RAW_FILE_BODY");
    expect(plainText(app.terminal.output)).toContain("RAW_PROTOCOL");
    expect(plainText(app.terminal.output)).toContain("Verbose planning reason");
    app.terminal.input("\x0f");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).not.toMatch(/RAW_FILE_BODY|RAW_PROTOCOL/);
    expect(app.controller.pause).not.toHaveBeenCalled();
  });

  it("keeps tool errors and unknown pricing visible without repeated warning spam", () => {
    const app = launch(undefined, 100, 35);
    for (const mode of ["decide", "execute", "metacog"] as const) app.emit({ type: "runtime", runtime: { type: "notice", mode,
      text: "Endpoint pricing is unknown; cost is an estimate." } });
    app.emit({ type: "runtime", runtime: { type: "tool_start", mode: "execute", toolName: "read", toolCallId: "bad", text: '{"path":"missing.txt"}' } });
    app.emit({ type: "runtime", runtime: { type: "tool_end", mode: "execute", toolName: "read", toolCallId: "bad", text: "File not found", isError: true } });
    app.terminal.output = "";
    app.tui.renderNow(true);
    const screen = plainText(app.terminal.output);
    expect(screen).not.toContain("当前端点未提供定价");
    expect(screen).not.toMatch(/费用|\$/);
    expect(screen).toContain("I 100 · O 80");
    expect(screen).toContain("File not found");
    app.terminal.input("\x0f");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output).match(/当前端点未提供定价/g)).toHaveLength(1);
  });

  it("shows an explicit partial report on pause without exposing an empty reasoning stub", async () => {
    const app = launch(undefined, 100, 40);
    app.board.status = "running";
    app.emit({ type: "handoff", handoff: { role: "execute", mode: "execute", revision: 2, runId: "private", trigger: { kind: "planned", reason: "Continue remaining goal" } } });
    app.emit({ type: "runtime", runtime: { type: "thinking_start", mode: "execute", blockId: "interrupted", text: "" } });
    app.emit({ type: "runtime", runtime: { type: "thinking", mode: "execute", blockId: "interrupted", text: "Problem:" } });
    app.board.status = "paused";
    app.board.reason = "Run time limit reached; inspect interrupted step state before resuming.";
    app.emit({ type: "state", snapshot: app.board });
    app.emit({ type: "result", snapshot: app.board, result: { mode: "execute", final: true,
      summary: "**任务未完成**\n\n已确认：第一项结果已保存。\n\n未完成：第二项仍待验证。\n\n暂停原因：达到运行时间限制。使用 /start 继续。" } });
    await Promise.resolve();
    await Promise.resolve();
    app.terminal.output = "";
    app.tui.renderNow(true);
    const screen = plainText(app.terminal.output);
    expect(screen).toContain("任务未完成");
    expect(screen).toContain("第一项结果已保存");
    expect(screen).toContain("第二项仍待验证");
    expect(screen).toContain("使用 /start 继续");
    expect(screen).not.toMatch(/\*\*|Problem:|Thought for 0s/);
    expect(screen.indexOf("任务未完成")).toBeLessThan(screen.indexOf("Worked for"));
    expect(screen).toContain("· paused");
  });
});

describe("TUI clipboard", () => {
  it.each(["\x16", "\x1b[2;2~"])("pastes native clipboard with %j and keeps it in the editor", async (key) => {
    const readText = vi.fn(async () => "中文 🧪\r\n第二行");
    const app = launch({ readText, writeText: vi.fn(async () => true) });
    app.terminal.input(key);
    await vi.waitFor(() => expect(app.editor.getExpandedText()).toBe("中文 🧪\n第二行"));
    expect(readText).toHaveBeenCalledOnce();
    expect(app.controller.hint).not.toHaveBeenCalled();
    app.terminal.input("\r");
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("does not execute a pasted /exit command until Enter", async () => {
    const app = launch({ readText: vi.fn(async () => "/exit"), writeText: vi.fn(async () => true) });
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(app.editor.getExpandedText()).toBe("/exit"));
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(false);
    app.terminal.input("\r");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("keeps all native bracketed-paste chunks as text, including control bytes", () => {
    const app = launch();
    app.terminal.input("\x1b[200~");
    app.terminal.input("/exit\r\n第二行");
    app.terminal.input("\x1b");
    app.terminal.input("\x03");
    app.terminal.input("\x1b[201~");
    expect(app.editor.getExpandedText()).toBe("/exit\n第二行");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
    expect(app.clipboard.readText).not.toHaveBeenCalled();
  });

  it("disables Enter while an asynchronous clipboard read is pending", async () => {
    let resolve!: (text: string) => void;
    const readText = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const app = launch({ readText, writeText: vi.fn(async () => true) });
    app.editor.setText("/hint 草稿");
    app.terminal.input("\x16");
    app.terminal.input("\r");
    expect(app.controller.hint).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(readText).toHaveBeenCalledOnce());
    resolve("续写");
    await vi.waitFor(() => expect(app.editor.getExpandedText()).toBe("/hint 草稿续写"));
    app.terminal.input("\r");
    expect(app.controller.hint).toHaveBeenCalledWith("草稿续写");
  });

  it("leaves the editor intact and usable when reading the clipboard fails", async () => {
    const app = launch({ readText: vi.fn(async () => { throw new Error("clipboard is busy"); }), writeText: vi.fn(async () => true) });
    app.editor.setText("/hint 保留草稿");
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(app.editor.disableSubmit).toBe(false));
    app.tui.renderNow(true);
    expect(app.editor.getExpandedText()).toBe("/hint 保留草稿");
    expect(plainText(app.terminal.output)).toMatch(/clipboard|剪贴板/i);
    app.terminal.input("\r");
    expect(app.controller.hint).toHaveBeenCalledWith("保留草稿");
  });

  it("does not insert clipboard results after quit, and drains the pending operation before closing", async () => {
    let resolve!: (text: string) => void;
    const readText = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const app = launch({ readText, writeText: vi.fn(async () => true) });
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledOnce());
    const closed = app.close();
    const before = app.editor.getExpandedText();
    expect(app.terminal.stopped).toBe(false);
    resolve("不应写入");
    await closed;
    expect(app.editor.getExpandedText()).toBe(before);
    expect(app.terminal.stopped).toBe(true);
  });

  it.each(["\x1b[99;6u", "\x1b[2;5~"])("copies the draft with %j without triggering lifecycle actions", async (key) => {
    const writeText = vi.fn(async () => true);
    const app = launch({ readText: vi.fn(async () => ""), writeText });
    app.editor.setText("复制草稿\n保留换行");
    app.terminal.input(key);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("复制草稿\n保留换行"));
    expect(app.editor.getExpandedText()).toBe("复制草稿\n保留换行");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
  });

  it("confirms before exiting a running loop without pausing, ignoring Kitty releases and repeats", async () => {
    const app = launch();
    app.board.status = "running";
    app.emit({ type: "state", snapshot: app.board });
    app.terminal.input("\x1b[99;5:1u");
    app.terminal.input("\x1b[99;5:3u");
    app.terminal.input("\x1b[99;5:2u");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(false);
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).toHaveBeenCalledOnce();
  });

  it("auto-copies a mouse selection but Ctrl+C clears a non-empty draft instead of copying", async () => {
    const writeText = vi.fn(async () => true);
    const app = launch({ readText: vi.fn(async () => ""), writeText });
    app.tui.renderNow(true);
    app.terminal.input("\x1b[<0;12;1M");
    app.terminal.input("\x1b[<32;17;1M");
    app.terminal.input("\x1b[<0;17;1m");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]?.[0].trim()).toBe("Xloom");
    const count = writeText.mock.calls.length;
    app.editor.setText("草稿\n第二行");
    app.terminal.input("\x03");
    expect(app.editor.getExpandedText()).toBe("");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(count);
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")("supports the Windows terminal right-click paste event", async () => {
    vi.stubEnv("TERM_PROGRAM", "Windows_Terminal");
    const app = launch();
    app.tui.renderNow(true);
    app.terminal.input("\x1b[<2;5;5M");
    await vi.waitFor(() => expect(app.editor.getExpandedText()).toBe("剪贴板文本"));
    expect(app.clipboard.readText).toHaveBeenCalledOnce();
    expect(app.controller.hint).not.toHaveBeenCalled();
  });
});

describe("TUI Ctrl+C and exit", () => {
  it("requires two Ctrl+C presses to exit from idle", async () => {
    const app = launch();
    app.terminal.input("\x03");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(false);
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toMatch(/Ctrl\+C.*退出/);
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it.each(["未提交输入", "  \t ", "第一行\n第二行", "\n\n"])("clears all of %j and needs two additional presses to quit", async (draft) => {
    const app = launch();
    app.board.status = "running";
    app.emit({ type: "state", snapshot: app.board });
    app.editor.setText(draft);
    app.terminal.input("\x03");
    expect(app.editor.getExpandedText()).toBe("");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
    app.terminal.input("\x03");
    expect(app.controller.stop).not.toHaveBeenCalled();
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).toHaveBeenCalledOnce();
    expect(app.controller.pause).not.toHaveBeenCalled();
  });

  it("does not let an active transcript selection intercept the empty-editor exit sequence", async () => {
    const writeText = vi.fn(async () => true);
    const app = launch({ readText: vi.fn(async () => ""), writeText });
    app.tui.renderNow(true);
    app.terminal.input("\x1b[<0;12;1M");
    app.terminal.input("\x1b[<32;17;1M");
    app.terminal.input("\x1b[<0;17;1m");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    app.terminal.input("\x03");
    expect(app.controller.stop).not.toHaveBeenCalled();
    app.terminal.input("\x03");
    await app.session;
    expect(writeText).toHaveBeenCalledOnce();
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("cancels exit confirmation after intervening keyboard input", async () => {
    const app = launch();
    app.terminal.input("\x03");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("");
    app.terminal.input("\x03");
    expect(app.controller.stop).not.toHaveBeenCalled();
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("cancels exit confirmation after a submitted command", async () => {
    const app = launch();
    app.terminal.input("\x03");
    app.submit("/board");
    app.terminal.input("\x03");
    expect(app.controller.stop).not.toHaveBeenCalled();
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("expires the exit confirmation after two seconds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    const app = launch();
    app.terminal.input("\x03");
    now.mockReturnValue(12001);
    app.terminal.input("\x03");
    expect(app.controller.stop).not.toHaveBeenCalled();
    now.mockReturnValue(12002);
    app.terminal.input("\x03");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });

  it("discards a clipboard result that arrives after Ctrl+C clears the draft", async () => {
    let resolve!: (text: string) => void;
    const readText = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const app = launch({ readText, writeText: vi.fn(async () => true) });
    app.editor.setText("要清除的草稿");
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledOnce());
    app.terminal.input("\x03");
    const cleared = app.editor.getExpandedText();
    app.terminal.input("新的草稿");
    resolve("过期粘贴结果");
    await vi.waitFor(() => expect(app.editor.disableSubmit).toBe(false));
    expect(cleared).toBe("");
    expect(app.editor.getExpandedText()).toBe("新的草稿");
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.controller.stop).not.toHaveBeenCalled();
  });

  it("exits with /exit without requiring a Ctrl+C confirmation", async () => {
    const app = launch();
    app.submit("/exit");
    await app.session;
    expect(app.controller.stop).not.toHaveBeenCalled();
    expect(app.terminal.stopped).toBe(true);
  });
});

describe("TUI transcript scrolling", () => {
  it("scrolls three lines per wheel tick, preserves reading position, and follows again at the bottom", () => {
    const app = launch(undefined, 70, 16);
    for (let index = 0; index < 25; index++) app.emit({ type: "notice", message: `会话信息 ${index}\n详细内容 ${index}` });
    app.tui.renderNow(true);
    const bottom = app.tui.viewportTop;
    expect(bottom).toBeGreaterThan(3);
    expect(app.tui.isFollowingOutput).toBe(true);
    app.terminal.input("\x1b[<64;5;5M");
    app.tui.renderNow(true);
    expect(app.tui.viewportTop).toBe(bottom - 3);
    expect(app.tui.isFollowingOutput).toBe(false);
    const reading = app.tui.viewportTop;
    app.emit({ type: "runtime", runtime: { type: "text", mode: "execute", text: "新增运行输出\n不应抢走滚动位置" } });
    app.tui.renderNow(true);
    expect(app.tui.viewportTop).toBe(reading);
    for (let index = 0; index < 60; index++) app.terminal.input("\x1b[<65;5;5M");
    app.tui.renderNow(true);
    expect(app.tui.isFollowingOutput).toBe(true);
    const previousBottom = app.tui.viewportTop;
    app.emit({ type: "notice", message: "回到底部后继续跟随\n下一条消息" });
    app.tui.renderNow(true);
    expect(app.tui.viewportTop).toBeGreaterThan(previousBottom);
    expect(app.tui.isFollowingOutput).toBe(true);
  });
});
