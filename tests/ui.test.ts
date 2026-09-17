import { describe, expect, it, vi } from "vitest";
import { Editor, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent } from "../src/types.js";
import { ResponsiveEditor, runTui } from "../src/ui/index.js";
import { dispatchCommand, EventFeed, fitLines, formatBoard, formatRunError, HELP, plainText, recordCommandHistory, statusLine, type UiController } from "../src/ui/model.js";

function snapshot(): BoardSnapshot {
  return {
    revision: 2, status: "idle", outcome: null, reason: "", completedSteps: 1, noProgressCount: 0,
    lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 100, output: 80, cost: 0.02 },
    config: { version: 1, title: "测试项目", goal: "检查授权对象的安全边界", scope: "localhost", context: "",
      models: { decide: { provider: "test", model: "test" }, execute: { provider: "test", model: "test" } },
      limits: { maxNoProgress: 3, maxMinutes: 10, maxTokens: 10000, maxCost: 1, maxTurnsPerRun: 5, stepTimeoutSeconds: 60, metacogEvery: 3 } },
    goals: [{ id: "g1", description: "验证对象归属", parentId: null, status: "active", factIds: [] }],
    facts: [{ id: "f1", description: "已保存响应", stepId: "s1", evidenceIds: ["e1"] }],
    steps: [{ id: "s1", goalId: "g1", from: [], description: "账户对比", successSignal: "实际响应差异", evidencePlan: "保存响应", priority: 1, status: "done", attempts: 1, runId: "r1", leaseUntil: null }],
    findings: [{ id: "v1", key: "key", target: "localhost", title: "待复核线索", status: "technical_hit", rating: "unrated", evidenceIds: ["e1"], factIds: ["f1"], next: "验证影响" }],
    evidence: [{ id: "e1", path: ".xloom/runs/r1/response.txt", sha256: "a".repeat(64), bytes: 22, description: "响应", runId: "r1", stepId: "s1" }],
    hints: [],
  };
}

function fakeController() {
  const board = snapshot();
  const listeners = new Set<(event: LoopEvent) => void>();
  const controller = {
    snapshot: vi.fn(() => board),
    subscribe: vi.fn((listener: (event: LoopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    start: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), hint: vi.fn(), requestMetacog: vi.fn(),
  } satisfies UiController;
  return { board, controller, listeners };
}

class MemoryTerminal implements Terminal {
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  kittyProtocolActive = false;
  constructor(public columns = 40, public rows = 18) {}
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
  submit(text: string): void { for (const char of text) this.input(char); this.input("\r"); }
}

describe("TUI formatting", () => {
  it("renders agent handoffs without treating metacognition as a third role", () => {
    const feed = new EventFeed();
    for (const mode of ["decide", "execute", "metacog"] as const) feed.handoff({
      role: mode === "execute" ? "execute" : "decide", mode, runId: "run-private-id", revision: 3,
      stepId: mode === "execute" ? "S1" : undefined,
      trigger: { kind: "planned", reason: "Inspect the committed blackboard\x1b[2J" },
    });
    expect(feed.entries.map(entry => entry.label)).toEqual(["Decide", "Execute", "Decide · Meta"]);
    expect(feed.entries[1]?.text).toContain("S1");
    expect(feed.entries[0]?.text).toBe("规划");
    expect(feed.entries[0]?.details).toContain("r3 · planned");
    expect(feed.entries.every(entry => entry.kind === "activity")).toBe(true);
    expect(JSON.stringify(feed.entries)).not.toContain("run-private-id");
    expect(feed.entries.every(entry => !entry.text.includes("\x1b"))).toBe(true);
  });

  it.each([0, 1, 2, 4, 12, 30, 80])("fits Chinese, emoji and long tokens into %i columns", (width) => {
    const lines = fitLines("双 Agent 元认知 🧪 · token_abcdefghijklmnopqrstuvwxyz\n第二行", width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("strips terminal control sequences from external content", () => {
    const text = plainText("ok\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[31mred\x1b[0m\x00\r\n中文");
    expect(text).toBe("okred\n中文");
    expect(text).not.toContain("\x1b");
  });

  it("navigates saved tasks and paths without starting execution", () => {
    const { controller } = fakeController();
    const openTask = vi.fn();
    const app = { ...controller, openTask, listTasks: () => [{ id: "task-saved", directory: "saved", selected: true, goal: "Saved research", status: "paused" }], storagePaths: () => ({ task: "saved" }) };
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    for (const command of ["/tasks", "/paths", "/open task-saved", "/open", "/open a b"]) dispatchCommand(command, app, actions);
    expect(openTask).toHaveBeenCalledExactlyOnceWith("task-saved");
    expect(actions.start).not.toHaveBeenCalled();
    expect(actions.print).toHaveBeenCalledWith("Tasks", expect.stringContaining("* task-saved"));
    expect(actions.print).toHaveBeenCalledWith("Paths", expect.stringContaining("saved"));
  });

  it("shows concise FGS, findings and evidence references without inventing ratings", () => {
    const board = snapshot();
    const text = formatBoard(board);
    expect(text).toContain("Goals (1)");
    expect(text).toContain("Facts (1)");
    expect(text).toContain("Steps (1)");
    expect(text).toContain("technical_hit/unrated");
    expect(text).toContain("e1 .xloom/runs/r1/response.txt");
    board.evidence[0] = { ...board.evidence[0]!, path: "evidence/archive.bin", pathBase: "task" };
    expect(formatBoard(board)).toContain("e1 [任务目录] evidence/archive.bin");
    expect(text).toContain("next: 验证影响");
    expect(statusLine(board)).toContain("I 100 · O 80");
    expect(statusLine(board)).toContain("step 1");
    expect(statusLine(board)).not.toMatch(/step \d+\//);
  });

  it("bounds streamed output and updates one collapsed entry per tool call", () => {
    const feed = new EventFeed(3, 40);
    feed.runtime({ type: "text", mode: "chat", text: "a".repeat(20) });
    feed.runtime({ type: "text", mode: "chat", text: "b".repeat(40) });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.text.length).toBeLessThanOrEqual(41);
    feed.runtime({ type: "tool_start", mode: "execute", text: "test", toolName: "powershell", toolCallId: "t1" });
    feed.runtime({ type: "tool_update", mode: "execute", text: "x".repeat(10000), toolName: "powershell", toolCallId: "t1" });
    feed.runtime({ type: "tool_end", mode: "execute", text: "saved evidence", toolName: "powershell", toolCallId: "t1" });
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[1]!.text).toBe("test");
    expect(feed.entries[1]!.state).toBe("done");
    expect(feed.entries[1]!.output).toBe("saved evidence");
    feed.add("note", "first");
    feed.add("note", "last");
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries[0]!.label).toBe("PowerShell");
  });

  it("labels metacognition as Decide, not a third agent", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "text", mode: "metacog", text: "复核证据" });
    expect(feed.entries[0]!.label).toBe("Decide · Meta");
    expect(feed.entries[0]!.kind).toBe("protocol");
  });

  it("keeps read targets and PowerShell commands instead of raw returned bodies", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "tool_start", mode: "decide", toolName: "read", toolCallId: "a", text: JSON.stringify({ path: "src/main.ts", offset: 2 }) });
    feed.runtime({ type: "tool_end", mode: "decide", toolName: "read", toolCallId: "a", text: "source code\n".repeat(2000) });
    feed.runtime({ type: "tool_start", mode: "execute", toolName: "powershell", toolCallId: "b", text: JSON.stringify({ command: "Get-Content\n README.md" }) });
    expect(feed.entries[0]).toMatchObject({ kind: "tool", label: "Read", text: "src/main.ts", state: "done" });
    expect(feed.entries[0]!.output!.length).toBe(9000);
    expect(feed.entries[1]).toMatchObject({ label: "PowerShell", text: "Get-Content README.md", state: "running" });
  });

  it("preserves prior calls when a fresh context reuses a tool call id", () => {
    const feed = new EventFeed();
    for (const file of ["one.txt", "two.txt"]) {
      feed.runtime({ type: "tool_start", mode: "decide", toolName: "read", toolCallId: "a", text: JSON.stringify({ path: file }) });
      feed.runtime({ type: "tool_end", mode: "decide", toolName: "read", toolCallId: "a", text: file + " output" });
    }
    expect(feed.entries.map(entry => entry.text)).toEqual(["one.txt", "two.txt"]);
    expect(feed.entries.map(entry => entry.output)).toEqual(["one.txt output", "two.txt output"]);
  });

  it("deduplicates pricing warnings across roles without suppressing errors", () => {
    const feed = new EventFeed();
    for (const mode of ["chat", "decide", "execute", "metacog"] as const) feed.runtime({ type: "notice", mode,
      text: "Endpoint pricing is unknown; cost is an estimate and a monetary budget cannot be enforced accurately." });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.text).toContain("金额预算无法准确执行");
    feed.runtime({ type: "notice", mode: "decide", text: "authentication failed", isError: true });
    feed.runtime({ type: "notice", mode: "execute", text: "authentication failed", isError: true });
    expect(feed.entries.filter(entry => entry.error)).toHaveLength(2);
  });

  it("separates raw protocol from a committed summary and preserves explicit help", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "text", mode: "decide", text: '{"summary":"draft"}' });
    feed.result("decide", "已提交下一步");
    feed.runtime({ type: "text", mode: "decide", text: '{"summary":"new draft"}' });
    feed.result("metacog", "请补充账号", "NEED_INPUT");
    feed.add("xloom", "帮助\n第二行");
    expect(feed.entries.map(entry => entry.kind)).toEqual(["protocol", "message", "protocol", "message", "message"]);
    expect(feed.entries[1]!.text).toBe("已提交下一步");
    expect(feed.entries[3]!.text).toContain("NEED_INPUT");
  });

  it("keeps a complete terminal report after checkpoints and before the unfinished work footer", () => {
    const feed = new EventFeed();
    feed.beginWork();
    feed.result("execute", "阶段证据已提交");
    feed.runtime({ type: "thinking_start", mode: "execute", blockId: "interrupted", text: "" });
    const report = `**任务未完成**\n\n已确认第一项结果。\n\n${"保留原始证据与待验证条件。\n".repeat(1000)}\n第二项尚未完成；可用 /start 继续。\x1b[2J`;
    feed.result("execute", report, undefined, true);
    feed.finishWork("paused");
    expect(feed.entries[0]).not.toHaveProperty("final");
    expect(feed.entries.at(-2)).toMatchObject({ kind: "message", final: true, text: plainText(report) });
    expect(feed.entries.at(-2)!.text.length).toBeGreaterThan(9000);
    expect(feed.entries.at(-1)).toMatchObject({ kind: "work", workStatus: "paused" });
    expect(feed.entries.find(entry => entry.kind === "thinking")!.endedAt).toBeTypeOf("number");
  });

  it("keeps editor CJK and IME focus safe on narrow terminals", () => {
    const terminal = new MemoryTerminal();
    const tui = new TuiAltScreen(terminal);
    const identity = (text: string) => text;
    const editor = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } }, { paddingX: 1 });
    const responsive = new ResponsiveEditor(editor);
    responsive.focused = true;
    editor.setText("测试中文 🧪\n多行输入");
    expect(editor.focused).toBe(true);
    for (const width of [0, 1, 2, 3, 4, 12, 80]) {
      for (const line of responsive.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("response timeline model", () => {
  it("keeps streamed thinking separate from the answer with observed timing", () => {
    let now = 1000;
    const feed = new EventFeed(160, 3200, () => now);
    feed.beginWork();
    feed.add("You", "question");
    feed.runtime({ type: "thinking_start", mode: "chat", blockId: "a", text: "" });
    now = 4000;
    feed.runtime({ type: "thinking", mode: "chat", blockId: "a", text: "actual provider thought" });
    now = 7000;
    feed.runtime({ type: "thinking_end", mode: "chat", blockId: "a", text: "" });
    feed.runtime({ type: "text", mode: "chat", text: "answer " });
    feed.runtime({ type: "text", mode: "chat", text: "only" });
    now = 8100;
    feed.finishWork("done");
    expect(feed.entries.map(entry => entry.kind)).toEqual(["message", "thinking", "message", "work"]);
    expect(feed.entries[1]).toMatchObject({ startedAt: 1000, endedAt: 7000, text: "actual provider thought", durationKnown: true });
    expect(feed.entries[2]!.text).toBe("answer only");
    expect(feed.entries.at(-1)).toMatchObject({ startedAt: 1000, endedAt: 8100, workStatus: "done" });
    expect(feed.working).toBe(false);
  });

  it("does not invent thinking for waiting, notices, errors, or ordinary answers", () => {
    const feed = new EventFeed();
    feed.beginWork();
    feed.notice("Endpoint pricing is unknown; test");
    feed.runtime({ type: "text", mode: "chat", text: "answer" });
    feed.add("xloom", "failed", true);
    feed.finishWork("error");
    expect(feed.entries.some(entry => entry.kind === "thinking")).toBe(false);
    expect(feed.entries.at(-1)!.workStatus).toBe("error");
    expect(feed.entries[0]!.kind).toBe("diagnostic");
  });

  it("bounds thinking and freezes interrupted segments without joining separate blocks", () => {
    let now = 1000;
    const feed = new EventFeed(5, 40, () => now);
    feed.beginWork();
    feed.runtime({ type: "thinking", mode: "chat", blockId: "a", text: "x".repeat(10000) });
    now = 2000;
    feed.finishWork("paused");
    const old = feed.entries[0]!;
    expect(old.text.length).toBeLessThanOrEqual(41);
    expect(old.endedAt).toBe(2000);
    now = 3000;
    feed.beginWork();
    feed.runtime({ type: "thinking", mode: "chat", blockId: "a", text: "new block" });
    feed.finishWork("stopped");
    expect(old.endedAt).toBe(2000);
    expect(feed.entries.filter(entry => entry.kind === "thinking")).toHaveLength(2);
    expect(feed.entries.filter(entry => entry.kind === "work").map(entry => entry.workStatus)).toEqual(["paused", "stopped"]);
  });

  it("marks fallback thoughts as unknown duration and ignores orphaned ends", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "thinking_end", mode: "chat", text: "", blockId: "orphan" });
    expect(feed.entries).toHaveLength(0);
    feed.runtime({ type: "thinking_start", mode: "chat", text: "", blockId: "a", replayed: true });
    feed.runtime({ type: "thinking", mode: "chat", text: "returned final thought", blockId: "a", replayed: true });
    feed.runtime({ type: "thinking_end", mode: "chat", text: "", blockId: "a", replayed: true });
    expect(feed.entries[0]!.durationKnown).toBe(false);
  });

  it("preserves the active footer when the bounded feed evicts old entries", () => {
    const feed = new EventFeed(3);
    feed.beginWork();
    feed.beginWork();
    for (let index = 0; index < 10; index++) feed.add("notice", String(index));
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries.at(-1)!.kind).toBe("work");
    feed.finishWork("done");
    feed.beginWork();
    feed.runtime({ type: "text", mode: "chat", text: "fresh" });
    expect(feed.entries.at(-2)!.text).toBe("fresh");
    expect(feed.entries.at(-1)!.kind).toBe("work");
  });

  it("distinguishes provider timeout from the local reply time budget without claiming a cause", () => {
    expect(formatRunError(new Error("Request timed out."))).toContain("模型服务请求超时");
    expect(formatRunError(new Error("Request timed out."))).not.toMatch(/API Key|密钥|180|已修复/);
    expect(formatRunError(new Error("Chat response timed out; tool side effects may remain."))).toContain("本地时间限制");
    expect(formatRunError(new Error("other failure"))).toBe("other failure");
    expect(statusLine(snapshot(), undefined, { input: 15, output: 5, cost: 0 })).toContain("I 115 · O 85");
    expect(statusLine(snapshot(), undefined, { input: 15, output: 5, cost: 0 })).not.toMatch(/\$|费用/);
  });

  it("moves only actual pre-tool narration ahead of its thought summary without duplication", () => {
    const feed = new EventFeed();
    feed.add("You", "检查测试");
    feed.runtime({ type: "thinking", mode: "chat", text: "provider thinking", blockId: "a" });
    feed.runtime({ type: "thinking_end", mode: "chat", text: "", blockId: "a" });
    feed.runtime({ type: "text", mode: "chat", text: "先检查测试入口。" });
    feed.runtime({ type: "narration", mode: "chat", text: "先检查测试入口。" });
    feed.runtime({ type: "tool_start", mode: "chat", toolName: "read", toolCallId: "r", text: '{"path":"README.md"}' });
    feed.runtime({ type: "tool_end", mode: "chat", toolName: "read", toolCallId: "r", text: "read output" });
    feed.runtime({ type: "thinking", mode: "chat", text: "next thought", blockId: "b" });
    feed.runtime({ type: "text", mode: "chat", text: "接着运行测试。" });
    feed.runtime({ type: "narration", mode: "chat", text: "接着运行测试。" });
    expect(feed.entries.map(entry => entry.kind)).toEqual(["message", "message", "thinking", "tool", "message", "thinking"]);
    expect(feed.entries.filter(entry => entry.text === "先检查测试入口。")).toHaveLength(1);
    expect(feed.entries[4]!.text).toBe("接着运行测试。");
  });

  it("retains red-team protocol unless its completed tool-use message supplies public narration", () => {
    const feed = new EventFeed();
    feed.beginWork();
    feed.runtime({ type: "thinking", mode: "decide", text: "real thought", blockId: "a" });
    feed.runtime({ type: "text", mode: "decide", text: "先核对工具结果。" });
    feed.runtime({ type: "narration", mode: "decide", text: "先核对工具结果。" });
    expect(feed.entries[0]).toMatchObject({ kind: "message", text: "先核对工具结果。" });
    expect(feed.entries.some(entry => entry.kind === "protocol")).toBe(false);
    feed.runtime({ type: "tool_start", mode: "decide", toolName: "read", toolCallId: "r", text: "path" });
    feed.runtime({ type: "tool_end", mode: "decide", toolName: "read", toolCallId: "r", text: "output" });
    feed.runtime({ type: "text", mode: "decide", text: '{"summary":"not committed"}' });
    expect(feed.entries.at(-2)!.kind).toBe("protocol");
    expect(feed.entries.at(-1)!.kind).toBe("work");
  });

  it("replaces all text blocks of a completed message after replayed thinking without duplicating narration", () => {
    const feed = new EventFeed();
    feed.beginWork();
    feed.runtime({ type: "text", mode: "chat", text: "Earlier answer.", messageId: "previous" });
    feed.runtime({ type: "text", mode: "chat", text: "先检查入口。", messageId: "current" });
    feed.runtime({ type: "thinking_start", mode: "chat", text: "", blockId: "replay", messageId: "current", replayed: true });
    feed.runtime({ type: "thinking", mode: "chat", text: "actual returned thought", blockId: "replay", messageId: "current", replayed: true });
    feed.runtime({ type: "thinking_end", mode: "chat", text: "", blockId: "replay", messageId: "current", replayed: true });
    feed.runtime({ type: "text", mode: "chat", text: "然后运行测试。", messageId: "current" });
    feed.runtime({ type: "narration", mode: "chat", text: "先检查入口。\n然后运行测试。", messageId: "current" });
    expect(feed.entries.map(entry => entry.kind)).toEqual(["message", "message", "thinking", "work"]);
    expect(feed.entries[0]!.text).toBe("Earlier answer.");
    expect(feed.entries[1]!.text).toBe("先检查入口。\n然后运行测试。");
    expect(feed.entries[2]).toMatchObject({ text: "actual returned thought", durationKnown: false });
    feed.runtime({ type: "text", mode: "chat", text: "Next answer.", messageId: "next" });
    expect(feed.entries.at(-2)!.text).toBe("Next answer.");
  });

  it("keeps token accounting visible when long model names or narrow terminals hide metadata", () => {
    const info = { mode: "chat" as const, busy: true, model: "provider/" + "long-model-name".repeat(10), usage: { input: 11000, output: 2000, cost: 4, cacheRead: 8800 } };
    const pending = { input: 40, output: 5, cost: 0, cacheRead: 32 };
    expect(statusLine(snapshot(), info, pending, 48)).toBe("I 11,040 · O 2,005 · C 8,832 · H 80.0%");
    expect(statusLine(snapshot(), info, pending, 26)).toBe("I11K O2K C8.8K H80%");
    expect(statusLine(snapshot(), undefined, { input: 15, output: 5, cost: 0 }, 30)).toBe("I 115 · O 85 · C — · H —");
    expect(statusLine(snapshot(), info, pending)).toContain("long-model-name");
    for (const width of [0, 1, 12, 20, 40, 80]) expect(visibleWidth(statusLine(snapshot(), info, pending, width))).toBeLessThanOrEqual(width);
  });

  it("distinguishes unavailable historical cache counts, partial coverage and measured misses", () => {
    const board = snapshot();
    expect(statusLine(board)).toContain("I 100 · O 80 · C — · H —");
    expect(statusLine(board, undefined, { input: 0, output: 0, cost: 0, cacheRead: 0, cacheInput: 0 })).toContain("C — · H —");
    const pending = { input: 200, output: 10, cost: 0, cacheRead: 150, cacheInput: 200 };
    expect(statusLine(board, undefined, pending)).toContain("I 300 · O 90 · C 150* · H 75.0%*");
    board.usage = { input: 200, output: 10, cost: 0, cacheRead: 0, cacheInput: 200 };
    expect(statusLine(board)).toContain("C 0 · H 0.0%");
    board.usage = { input: 0, output: 0, cost: 0 };
    expect(statusLine(board)).toContain("I 0 · O 0 · C 0 · H —");
  });

  it("counts reported usage live without creating tool entries or double-counting committed usage", () => {
    const feed = new EventFeed();
    feed.beginWork();
    feed.runtime({ type: "usage", mode: "chat", text: "", usage: { input: 100, output: 25, cost: 1, cacheRead: 80 } });
    feed.runtime({ type: "usage", mode: "chat", text: "", usage: { input: 120, output: 30, cost: 2, cacheRead: 100 } });
    expect(feed.uncommittedTokens).toBe(275);
    expect(feed.uncommittedUsage).toEqual({ input: 220, output: 55, cost: 3, cacheRead: 180, cacheInput: 220 });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.tokens).toBe(275);
    feed.usageCommitted();
    expect(feed.uncommittedTokens).toBe(0);
    expect(feed.uncommittedUsage).toEqual({ input: 0, output: 0, cost: 0 });
    expect(feed.entries[0]!.tokens).toBe(275);
    feed.finishWork("done");
    feed.beginWork();
    expect(feed.entries.at(-1)!.tokens).toBe(0);
    for (const input of [-1, NaN, Infinity]) feed.runtime({ type: "usage", mode: "chat", text: "", usage: { input, output: 3, cost: 0 } });
    expect(feed.uncommittedTokens).toBe(0);
  });

  it("keeps actual tool start/end times for running summaries", () => {
    let now = 1000;
    const feed = new EventFeed(160, 3200, () => now);
    feed.runtime({ type: "tool_start", mode: "execute", toolName: "powershell", toolCallId: "t", text: "Get-Date" });
    now = 117000;
    feed.runtime({ type: "tool_end", mode: "execute", toolName: "powershell", toolCallId: "t", text: "result" });
    expect(feed.entries[0]).toMatchObject({ startedAt: 1000, endedAt: 117000, state: "done" });
    feed.runtime({ type: "tool_end", mode: "execute", toolName: "read", toolCallId: "orphan", text: "late result" });
    expect(feed.entries[1]!.startedAt).toBeUndefined();
  });

  it("explains a bounded Agent call without treating it as Goal completion or API quota", () => {
    const error = formatRunError("Agent budget reached before a final result; the Step may have partial side effects.");
    expect(error).toContain("回合或资源上限");
    expect(error).toContain("不等于 Goal 已完成");
    expect(error).not.toMatch(/余额|API.*额度|自动重试/);
    expect(formatRunError("Chat response budget reached before a final reply;")).not.toContain("Goal");
    expect(formatRunError("Agent budget reached before a final result (maxTurnsPerRun=12, turns=12); the Step may have partial side effects.")).toContain("maxTurnsPerRun=12, turns=12");
    expect(formatRunError("Chat response budget reached before a final reply (maxTokens=5000, tokens=5001); tool side effects may remain.")).toContain("maxTokens=5000, tokens=5001");
  });
});

describe("TUI command routing", () => {
  it("routes explicit Chrome controls and reports failures without calling an Agent", async () => {
    const { controller } = fakeController();
    const chromeControl = vi.fn(async (_action: string) => ({ bridgeRunning: true }));
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), chat: vi.fn() };
    for (const command of ["/chrome", "/chrome disconnect", "/chrome connect", "/chrome invalid", "/chrome status extra"]) dispatchCommand(command, { ...controller, chromeControl }, actions);
    await vi.waitFor(() => expect(actions.print).toHaveBeenCalledWith("Chrome", '{"bridgeRunning":true}'));
    expect(chromeControl.mock.calls).toEqual([["status"], ["disconnect"], ["connect"]]);
    expect(actions.chat).not.toHaveBeenCalled(); expect(controller.hint).not.toHaveBeenCalled();
    chromeControl.mockRejectedValueOnce(new Error("Synthetic socket error"));
    dispatchCommand("/chrome status", { ...controller, chromeControl }, actions);
    await vi.waitFor(() => expect(actions.print).toHaveBeenCalledWith("Chrome", "Synthetic socket error"));
    dispatchCommand("/chrome", controller, actions);
    expect(actions.print).toHaveBeenCalledWith("xloom", expect.stringContaining("没有 Chrome"));
  });

  it("sends only explicit /hint to blackboard and ordinary input to isolated chat", () => {
    const { controller } = fakeController();
    const chat = vi.fn(async () => {});
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), chat: vi.fn() };
    dispatchCommand("账户 A 属于组织甲", { ...controller, chat }, actions);
    dispatchCommand("/hint  账户 B\n属于组织乙", controller, actions);
    expect(controller.hint.mock.calls).toEqual([["账户 B\n属于组织乙"]]);
    expect(actions.chat).toHaveBeenCalledWith("账户 A 属于组织甲");
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("does not turn demo chat into implicit blackboard hints", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), chat: vi.fn() };
    dispatchCommand("ordinary text", controller, actions);
    expect(actions.chat).not.toHaveBeenCalled();
    expect(controller.hint).not.toHaveBeenCalled();
    expect(actions.print).toHaveBeenCalledWith("xloom", expect.stringContaining("未连接聊天模型"));
  });

  it("routes task/chat resets and settings without sending arguments to an Agent", () => {
    const { controller } = fakeController();
    const resetChat = vi.fn();
    const app = { ...controller, runGoal: vi.fn(async () => {}), resetChat };
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), run: vi.fn(), settings: vi.fn() };
    for (const command of ["/run https://localhost 对比账户", "/new", "/model", "/model decide", "/apikey", "/apikey opencode-go", "/login", "/login openai-codex", "/logout", "/logout opencode-go"]) dispatchCommand(command, app, actions);
    expect(actions.run).toHaveBeenCalledWith("https://localhost 对比账户");
    expect(resetChat).toHaveBeenCalledOnce();
    expect(actions.settings.mock.calls).toEqual([["model", ""], ["model", "decide"], ["apikey", ""], ["apikey", "opencode-go"], ["login", ""], ["login", "openai-codex"], ["logout", ""], ["logout", "opencode-go"]]);
    expect(controller.hint).not.toHaveBeenCalled();
  });

  it("rejects inline secrets and invalid model roles without echoing or recording secrets", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), settings: vi.fn() };
    for (const command of ["/apikey anthropic PRIVATE_KEY", "/login anthropic PRIVATE_CODE", "/logout anthropic PRIVATE_KEY", "/model invalid", "/run"]) dispatchCommand(command, controller, actions);
    expect(actions.settings).not.toHaveBeenCalled();
    expect(JSON.stringify(actions.print.mock.calls)).not.toMatch(/PRIVATE_KEY|PRIVATE_CODE/);
    expect(recordCommandHistory("/apikey anthropic PRIVATE_KEY")).toBe(false);
    expect(recordCommandHistory(" /login anthropic")).toBe(false);
    expect(recordCommandHistory("/logout anthropic PRIVATE_KEY")).toBe(false);
    expect(recordCommandHistory("/model decide")).toBe(true);
  });

  it("routes all lifecycle and inspection commands", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    for (const command of ["/start", "/pause", "/stop", "/meta", "/board", "/help", "/exit"]) dispatchCommand(command, controller, actions);
    expect(actions.start).toHaveBeenCalledOnce();
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(controller.requestMetacog).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
    expect(actions.print.mock.calls.some(([label]) => label === "Blackboard")).toBe(true);
  });

  it.each(["/details", "/quit"])("rejects removed command %s without side effects", command => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn(), settings: vi.fn(), chat: vi.fn() };
    dispatchCommand(command, controller, actions);
    dispatchCommand(`${command} anthropic`, controller, actions);
    expect(actions.settings).not.toHaveBeenCalled();
    expect(actions.quit).not.toHaveBeenCalled();
    expect(actions.chat).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(actions.print).toHaveBeenCalledWith("xloom", expect.stringContaining(`未知命令 ${command}`));
    expect(HELP).not.toContain(command);
    expect(HELP).toContain("Ctrl+O");
  });

  it("does not silently treat unknown commands as agent instructions", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    for (const command of ["/unknown", "/hint", "/stop now", "/exit now", "  "]) dispatchCommand(command, controller, actions);
    expect(controller.hint).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(actions.quit).not.toHaveBeenCalled();
    expect(actions.print).toHaveBeenCalledTimes(4);
  });
});

describe("TUI lifecycle", () => {
  it("waits for a controller-started idle /meta run before restoring the terminal", async () => {
    const { controller, listeners, board } = fakeController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const waitForIdle = vi.fn(() => pending);
    controller.requestMetacog.mockImplementation(() => {
      board.status = "running";
      for (const listener of listeners) listener({ type: "state", snapshot: board });
    });
    const terminal = new MemoryTerminal();
    const session = runTui(Object.assign(controller, { waitForIdle }), terminal);
    terminal.submit("/meta");
    expect(controller.requestMetacog).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce());
    expect(terminal.stopped).toBe(false);
    release();
    await session;
    expect(terminal.stopped).toBe(true);
  });

  it("coalesces duplicate starts and does not execute a queued start after quit", async () => {
    const { controller } = fakeController();
    const terminal = new MemoryTerminal();
    const session = runTui(controller, terminal);
    terminal.submit("/start");
    terminal.submit("/start");
    terminal.submit("/exit");
    await session;
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(terminal.stopped).toBe(true);
  });

  it("remains responsive while the loop runs and awaits cancellation before restoring terminal", async () => {
    const { controller, listeners } = fakeController();
    let release!: () => void;
    controller.start.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const terminal = new MemoryTerminal(24, 14);
    const session = runTui(controller, terminal);
    terminal.submit("/start");
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledOnce());
    terminal.submit("/hint 补充身份对比");
    expect(controller.hint).toHaveBeenCalledWith("补充身份对比");
    terminal.input("\x03");
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(terminal.stopped).toBe(false);
    release();
    await session;
    expect(terminal.stopped).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("renders runtime updates and exits cleanly from idle", async () => {
    const { controller, listeners, board } = fakeController();
    const terminal = new MemoryTerminal(12, 12);
    const session = runTui(controller, terminal);
    for (const listener of listeners) {
      listener({ type: "runtime", runtime: { type: "text", mode: "execute", text: "检查中文边界 🧪" } });
      listener({ type: "state", snapshot: { ...board, status: "paused", reason: "用户暂停" } });
    }
    terminal.input("\x1b");
    expect(controller.pause).toHaveBeenCalledOnce();
    terminal.submit("/board");
    terminal.submit("/exit");
    await session;
    expect(terminal.stopped).toBe(true);
    expect(plainText(terminal.output)).toContain("Xloom");
    expect(listeners.size).toBe(0);
  });
});
