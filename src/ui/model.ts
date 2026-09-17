import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentHandoff, BoardSnapshot, LoopEvent, Mode, RuntimeEvent, Usage } from "../types.js";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import type { ProviderChoice } from "../runtime/settings.js";
import { retainToolOutput } from "./tool-output.js";
import type { TaskInfo } from "../workspace.js";
import { cvssIssues } from "../scoring/cvss.js";
import { progressNotice, protocolFailure } from "./diagnostics.js";
import { materialFeedback } from "../wiki/feedback.js";
import type { MaterialDelivery } from "../wiki/materials.js";
import { addUsage, cacheInput } from "../usage.js";
import { usageSchema } from "../schema.js";

export type ModelRole = "all" | "chat" | "decide" | "execute";
export type SettingsCommand = "model" | "login" | "logout";
export interface SessionInfo { mode: "chat" | "run"; busy: boolean; model: string; status?: string; usage?: Usage; workspace?: string; contextWindow?: number; authLabel?: string; modelName?: string }

export interface UiController {
  snapshot(): BoardSnapshot;
  subscribe(listener: (event: LoopEvent) => void): () => void;
  start(): Promise<void>;
  pause(): void;
  stop(): void;
  hint(content: string): void;
  requestMetacog(): void;
  waitForIdle?(): Promise<void>;
  chat?(text: string): Promise<void>;
  runGoal?(goal: string): Promise<void>;
  resetChat?(): void;
  listTasks?(): TaskInfo[];
  openTask?(id: string): void;
  storagePaths?(): object;
  chatHistory?(): { id?: string; file?: string; pendingToolCalls: string[]; messages: { role: string; text: string }[] } | undefined;
  chromeControl?(action: "status" | "disconnect" | "connect"): Promise<object>;
  getSessionInfo?(): SessionInfo;
  getModels?(): Promise<{ provider: string; model: string; name: string }[]>;
  getProviders?(mode?: "login" | "logout"): Promise<ProviderChoice[]>;
  selectModel?(provider: string, model: string, role?: ModelRole, signal?: AbortSignal): Promise<void>;
  login?(provider: string, interaction: AuthInteraction, type?: AuthType): Promise<void>;
  logout?(provider: string, signal?: AbortSignal): Promise<void>;
}

export const HELP = [
  "普通输入：和模型聊天，可使用 read / write / edit / powershell / chrome；/new 新建聊天；/history 保存内容",
  "/chrome [status|disconnect|connect]  查看 Chrome 连接、手动断开或允许重连",
  "/run 目标  新建双 Agent 任务（不读取聊天历史）",
  "/start  开始 / 继续    /pause  暂停    /stop  停止",
  "/tasks  历史任务    /open 任务ID  选择任务    /paths  数据位置",
  "/hint 内容  写入黑板    /meta  请求元认知    /board  查看黑板",
  "/help  帮助    /exit  退出",
  "/model [all|chat|decide|execute]  搜索切换模型；默认应用所有角色",
  "/login [provider]  选择账号登录或 API Key    /logout  移除本地凭据",
  "普通聊天与黑板隔离；补充任务信息请显式使用 /hint。设置期间 Esc 取消。",
  "Enter 提交 · Alt+Enter / Shift+Enter 换行 · ↑/↓ 上一条 / 下一条输入（保留草稿）",
  "输入 / 显示命令候选；↑/↓ 选择，Tab / Enter 补全，再按 Enter 执行；Esc 关闭候选",
  "Ctrl+O 展开 / 收起工具详情和协议输出；默认只显示工具摘要与已提交结果",
  "点击活动摘要展开思考和工具详情，再点击摘要或展开内容收起；Ctrl+T 切换最近一组（思考内容需模型返回）",
  "Alt+↑/↓ 多行光标移动 · Ctrl+P/N 也可切换历史输入",
  "Ctrl+C：有内容先清空；空输入框 2 秒内连续按两次退出（不会先暂停）",
  "选中即复制；Ctrl+Shift+C / Ctrl+Insert 复制，Ctrl+C 不再用于复制",
  "底部 token：I 输入（含缓存）· O 输出 · C 缓存命中 · H 命中率；* 表示仅统计有缓存明细的输入，— 表示未知",
  "Ctrl+Shift+C / Ctrl+Insert 复制选择或输入 · Ctrl+V / Shift+Insert / 右键粘贴",
  "应用剪贴板粘贴不会自动提交；终端原生粘贴需支持括号粘贴协议",
  "滚轮 / PageUp / PageDown 滚动会话 · End 回到底部并恢复跟随 · Ctrl+Shift+F 搜索",
].join("\n");

// Tool output and remote content must never become terminal control sequences.
export function plainText(value: string): string {
  return stripTerminalSequences(value).replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function compact(value: string, limit = 180): string {
  const clean = plainText(value).replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function fitLines(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const clean = plainText(value);
  if (width === 1) return clean.split("\n").map((line) => truncateToWidth(line, width, ""));
  return wrapTextWithAnsi(clean, width).map((line) => truncateToWidth(line, width, ""));
}

export function statusLine(board: BoardSnapshot, session?: SessionInfo, pending: Usage = { input: 0, output: 0, cost: 0 }, width = Infinity): string {
  const chat = session?.mode === "chat";
  const usage = addUsage({ ...(chat ? session.usage : board.usage) ?? { input: 0, output: 0, cost: 0 } }, pending);
  const coverage = cacheInput(usage), partial = coverage > 0 && coverage < usage.input ? "*" : "";
  const count = (value: number, small: boolean) => value.toLocaleString("en-US", small ? { notation: "compact", maximumFractionDigits: 1 } : {});
  const tokens = (small: boolean) => [
    `I${small ? "" : " "}${count(usage.input, small)}`,
    `O${small ? "" : " "}${count(usage.output, small)}`,
    `C${small ? "" : " "}${coverage === 0 && usage.input > 0 ? "—" : count(usage.cacheRead ?? 0, small) + partial}`,
    `H${small ? "" : " "}${coverage > 0 ? `${(100 * (usage.cacheRead ?? 0) / coverage).toFixed(small ? 0 : 1)}%${partial}` : "—"}`,
  ].join(small ? " " : " · ");
  const status = chat ? session.status ?? (session.busy ? "running" : "idle") : board.status;
  const full = chat ? `chat · ${status} · ${compact(session.model, 120)} · ${tokens(false)}`
    : `${session ? "run · " : ""}${status} · r${board.revision} · step ${board.completedSteps} · ${tokens(false)}${board.outcome ? ` · ${board.outcome}` : ""}`;
  // Model names and revision metadata must not push token accounting off-screen.
  if (visibleWidth(full) <= width) return full;
  for (const small of [false, true]) {
    const short = `${session ? `${session.mode} · ` : ""}${status} · ${tokens(small)}`;
    if (visibleWidth(short) <= width) return short;
    if (visibleWidth(tokens(small)) <= width) return tokens(small);
  }
  return truncateToWidth(tokens(true), Math.max(0, width), "");
}

export function formatBoard(board: BoardSnapshot): string {
  const lines = [statusLine(board), `目标：${compact(board.config.goal, 300)}`];
  if (board.reason) lines.push(`状态：${compact(board.reason, 300)}`);
  const section = <T>(title: string, values: T[], count: number, format: (value: T) => string): void => {
    lines.push("", `${title} (${values.length})`);
    if (!values.length) lines.push("  —");
    else {
      if (values.length > count) lines.push(`  … 仅显示最近 ${count} 条`);
      lines.push(...values.slice(-count).map((item) => `  ${format(item)}`));
    }
  };
  section("Goals", board.goals, 8, (g) => `${g.id} [${g.status}] ${compact(g.description)}`);
  section("Facts", board.facts, 10, (f) => `${f.id} ${compact(f.description)} → ${f.evidenceIds.join(", ") || "无证据引用"}`);
  section("Steps", board.steps, 10, (s) => `${s.id} [${s.status}] ${s.goalId} ← ${s.from.join(",") || "—"} · ${compact(s.description)}`);
  section("Findings", board.findings, 8, (f) => `${f.id} [${f.status}/${f.rating}] ${compact(f.title)}\n    evidence: ${f.evidenceIds.join(", ") || "—"}\n    next: ${compact(f.next)}${f.cvss ? `\n    CVSS 3.1 Base: ${f.cvss.baseScore.toFixed(1)} ${f.cvss.severity} · ${f.cvss.status}\n    ${f.cvss.vector}\n    ${cvssIssues(board, f).join(", ") || "指标已复核；评分不代表影响验证"}` : ""}`);
  section("Evidence", board.evidence, 8, (e) => `${e.id} ${e.pathBase === "task" ? "[任务目录] " : ""}${compact(e.path)} · sha256:${e.sha256.slice(0, 12)}`);
  section("Hints", board.hints, 4, (h) => `${h.id} ${compact(h.content)}`);
  return lines.join("\n");
}

export interface FeedEntry {
  kind?: "message" | "activity" | "tool" | "notice" | "protocol" | "thinking" | "work" | "diagnostic";
  label: string; text: string; key?: string; error?: boolean;
  details?: string; output?: string; state?: "running" | "done" | "error";
  startedAt?: number; endedAt?: number; expanded?: boolean; durationKnown?: boolean;
  workStatus?: "running" | "done" | "error" | "paused" | "stopped";
  tokens?: number;
  messageId?: string;
  final?: boolean;
}

export function formatRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const protocol = protocolFailure(message);
  if (protocol) return protocol;
  if (/^Request timed out\.?$/i.test(message)) return "模型服务请求超时。请检查模型服务或网络后重试；已执行的工具操作不会自动回滚。";
  if (message.startsWith("Chat response timed out;")) return "本次回复达到本地时间限制。请先检查已执行的工具操作，再决定是否重试。";
  const budgetDetail = /^.*?budget reached before[^;(]*\(([^)]*)\)/.exec(message)?.[1];
  const diagnostic = budgetDetail ? `（${budgetDetail}）` : "";
  if (message.startsWith("Agent budget reached before")) return `本次 Agent 调用达到配置的回合或资源上限${diagnostic}，尚未提交最终结果。\n这不等于 Goal 已完成；已执行的操作保留，请先检查黑板和产物再继续。`;
  if (message.startsWith("Chat response budget reached before")) return `本次聊天调用达到配置的回合或资源上限${diagnostic}，尚未收到最终回复。\n已执行的工具操作保留，请检查产物后再决定是否继续。`;
  return message;
}

function roleLabel(mode: Mode | "chat"): string {
  return mode === "chat" ? "Assistant" : mode === "metacog" ? "Decide · Meta" : mode === "decide" ? "Decide" : "Execute";
}

/** Describe the request, not the tool's potentially huge returned document. */
function toolTarget(event: RuntimeEvent): string {
  try {
    const args: unknown = JSON.parse(event.text);
    if (args && typeof args === "object") {
      const record = args as Record<string, unknown>;
      const target = event.toolName === "powershell" ? record.command : record.path;
      if (typeof target === "string") return compact(target, 180);
    }
  } catch { /* Older/custom runners can supply a plain request description. */ }
  return compact(event.text, 180);
}

/** UI-only event feed. It is never passed back to either Agent. */
export class EventFeed {
  readonly entries: FeedEntry[] = [];
  private pricingNoticeShown = false;
  private work?: FeedEntry;
  private stream?: FeedEntry;
  private pendingUsage: Usage = { input: 0, output: 0, cost: 0 };
  constructor(private readonly maxEntries = 160, private readonly maxText = 3200, private readonly now = Date.now) {}
  get pricingUnknown(): boolean { return this.pricingNoticeShown; }
  get working(): boolean { return this.work !== undefined; }
  get uncommittedTokens(): number { return this.pendingUsage.input + this.pendingUsage.output; }
  get uncommittedUsage(): Usage { return { ...this.pendingUsage }; }
  usageCommitted(): void { this.pendingUsage = { input: 0, output: 0, cost: 0 }; }

  beginWork(): void {
    if (this.work) return;
    this.breakStream();
    this.work = { kind: "work", label: "xloom", text: "", startedAt: this.now(), workStatus: "running", tokens: 0 };
    this.entries.push(this.work);
    this.trim();
  }

  finishWork(status: Exclude<FeedEntry["workStatus"], "running" | undefined>): void {
    this.endThinking();
    this.breakStream();
    if (!this.work) return;
    this.work.workStatus = status;
    this.work.endedAt = this.now();
    this.work = undefined;
  }

  private append(entry: FeedEntry): void {
    const index = this.work ? this.entries.indexOf(this.work) : -1;
    if (index >= 0) this.entries.splice(index, 0, entry);
    else this.entries.push(entry);
    this.trim();
  }

  private endThinking(): void {
    for (const entry of this.entries) if (entry.kind === "thinking" && entry.endedAt === undefined) entry.endedAt = this.now();
  }

  add(label: string, text: string, error = false): void {
    this.breakStream();
    const kind = (label === "xloom" || label === "Loop" || label === "恢复状态") && !text.includes("\n") ? "notice" : "message";
    this.append({ kind, label: plainText(label), text: plainText(text).slice(0, 9000), error });
  }

  notice(text: string, error = false): void {
    const friendly = !error && progressNotice(text);
    if (friendly) {
      this.breakStream();
      this.append({ kind: "message", label: "xloom", text: friendly, details: plainText(text).slice(0, 9000) });
      return;
    }
    if (!error && text.startsWith("Endpoint pricing is unknown;")) {
      if (this.pricingNoticeShown) return;
      this.pricingNoticeShown = true;
      this.append({ kind: "diagnostic", label: "xloom", text: "当前端点未提供定价；费用仅供估算，金额预算无法准确执行。" });
      return;
    }
    this.add("xloom", text, error);
  }

  failure(reason: unknown): void {
    this.endThinking();
    this.breakStream();
    const raw = plainText(reason instanceof Error ? reason.message : String(reason));
    const text = formatRunError(raw);
    this.append({ kind: "message", label: "Loop", text: text.slice(0, 9000), error: true,
      ...(text !== raw ? { details: raw.slice(0, 9000) } : {}) });
  }

  result(mode: Mode | "chat", summary: string, outcome?: string, final = false, source?: LoopEvent["result"]): void {
    this.endThinking();
    const key = !final && source?.kind === "checkpoint" && source.runId && source.checkpointId
      ? `checkpoint:${source.runId}:${source.checkpointId}` : undefined;
    if (key && this.entries.some(entry => entry.key === key)) return;
    if (!final && (key || source?.kind === "transition")) {
      this.breakStream();
      this.append({ kind: "message", label: roleLabel(mode), text: plainText(summary), ...(key ? { key } : {}) });
      return;
    }
    if (!final) {
      this.add(roleLabel(mode), `${outcome ? `${outcome}\n\n` : ""}${summary}`);
      return;
    }
    this.breakStream();
    // A terminal report is the answer, not a bounded tool/protocol preview.
    this.append({ kind: "message", label: roleLabel(mode), text: plainText(summary), final: true });
  }

  handoff(event: AgentHandoff): void {
    this.endThinking();
    this.breakStream();
    const phase = event.mode === "metacog" ? "复核" : event.mode === "execute" ? "执行" : "规划";
    this.append({ kind: "activity", label: roleLabel(event.mode),
      text: `${phase}${event.stepId ? ` · ${plainText(event.stepId)}` : ""}`,
      details: `r${event.revision} · ${event.trigger.kind}\n${plainText(event.trigger.reason).slice(0, 2000)}` });
    this.trim();
  }

  materials(delivery: MaterialDelivery): void {
    if (!delivery.items.length && !delivery.deferredCount) return;
    this.breakStream();
    this.append({ kind: "message", label: "资料 → Decide", text: plainText(materialFeedback(delivery)), details: JSON.stringify(delivery, null, 2) });
  }

  runtime(event: RuntimeEvent): void {
    const label = roleLabel(event.mode);
    if (event.type === "usage") {
      const parsed = usageSchema.safeParse(event.usage);
      if (parsed.success) {
        addUsage(this.pendingUsage, parsed.data);
        if (this.work) this.work.tokens = (this.work.tokens ?? 0) + parsed.data.input + parsed.data.output;
      }
    } else if (event.type === "narration") {
      this.endThinking();
      // Relocate only this model message's public pre-tool prose ahead of its
      // thought/tool summary. This UI ordering never changes Agent history.
      const matchesMessage = (entry: FeedEntry): boolean => Boolean(event.messageId && entry.messageId === event.messageId && entry.label === label);
      const first = event.messageId ? this.entries.find(matchesMessage) : undefined;
      let index = first ? this.entries.indexOf(first) : -1;
      const streams = event.messageId ? this.entries.filter(entry => matchesMessage(entry) && (entry.kind === "message" || entry.kind === "protocol"))
        : this.stream && this.entries.includes(this.stream) ? [this.stream] : [];
      for (const entry of streams) this.entries.splice(this.entries.indexOf(entry), 1);
      this.breakStream();
      const message: FeedEntry = { kind: "message", label, text: plainText(event.text).slice(0, 9000), messageId: event.messageId };
      if (index < 0) {
        index = this.work ? this.entries.indexOf(this.work) : this.entries.length;
        while (index > 0 && ["thinking", "protocol"].includes(this.entries[index - 1]!.kind ?? "")) index--;
      }
      this.entries.splice(index, 0, message);
    } else if (event.type === "thinking_start" || event.type === "thinking" || event.type === "thinking_end") {
      this.breakStream();
      const key = `thinking:${event.mode}:${event.blockId ?? "current"}`;
      let entry = this.entries.findLast(item => item.kind === "thinking" && item.key === key && item.endedAt === undefined);
      if (!entry && event.type === "thinking_end") return;
      if (!entry) { entry = { kind: "thinking", label, text: "", key, startedAt: this.now(), durationKnown: !event.replayed, messageId: event.messageId }; this.append(entry); }
      if (event.type === "thinking") {
        const text = entry.text + plainText(event.text);
        entry.text = text.length > this.maxText ? `…${text.slice(-this.maxText)}` : text;
      }
      if (event.type === "thinking_end") entry.endedAt = this.now();
    } else if (event.type === "text") {
      this.endThinking();
      const last = this.stream && this.entries.includes(this.stream) ? this.stream : undefined;
      if (last?.label === label && last.key === "stream" && last.messageId === event.messageId) {
        const joined = last.text + plainText(event.text);
        last.text = joined.length > this.maxText ? `…${joined.slice(-this.maxText)}` : joined;
      } else {
        this.stream = { kind: event.mode === "chat" ? "message" : "protocol", label, text: plainText(event.text).slice(-this.maxText), key: "stream", messageId: event.messageId };
        this.append(this.stream);
      }
    } else if (event.type === "notice") {
      this.notice(event.text, event.isError);
    } else {
      this.endThinking();
      this.breakStream();
      const key = `tool:${event.mode}:${event.toolCallId ?? event.toolName ?? "unknown"}`;
      // A new call may reuse an ID in a new Pi context. Never overwrite a prior call.
      const existing = event.type === "tool_start" ? undefined : this.entries.findLast((entry) => entry.key === key && entry.state === "running");
      const state = event.type === "tool_start" ? "running" : event.type === "tool_end" ? (event.isError ? "error" : "done") : "running";
      const names: Record<string, string> = { read: "Read", write: "Write", edit: "Edit", powershell: "PowerShell" };
      const entry: FeedEntry = existing ?? { kind: "tool", key, label: names[event.toolName ?? ""] ?? compact(event.toolName ?? "Tool", 40),
        text: event.type === "tool_start" ? toolTarget(event) : "", details: event.type === "tool_start" ? plainText(event.text).slice(0, 9000) : undefined,
        startedAt: event.type === "tool_start" ? this.now() : undefined };
      if (event.type !== "tool_start") entry.output = retainToolOutput(plainText(event.text), event.isError === true);
      entry.state = state;
      if (event.type === "tool_end") entry.endedAt = this.now();
      entry.error = event.isError;
      if (!existing) this.append(entry);
      if (event.type === "tool_end" && !event.isError && event.retrievalFeedback) {
        this.append({ kind: "message", label: "资料读取", text: plainText(event.retrievalFeedback) });
      }
    }
    this.trim();
  }

  breakStream(): void {
    const last = this.stream;
    if (last?.key === "stream") delete last.key;
    this.stream = undefined;
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

export interface CommandActions {
  start(): void;
  quit(): void;
  print(label: string, text: string): void;
  chat?(text: string): void;
  run?(goal: string): void;
  settings?(command: SettingsCommand, argument: string): void;
}

/** Credential commands and accidental inline credentials never enter editor history. */
export function recordCommandHistory(input: string): boolean {
  return !/^\/(?:apikey|login|logout)\b/i.test(input.trim());
}

/** Synchronous dispatch keeps input responsive while the loop runs. */
export function dispatchCommand(input: string, controller: UiController, actions: CommandActions): void {
  const value = input.trim();
  if (!value) return;
  if (!value.startsWith("/")) {
    if (actions.chat && controller.chat) actions.chat(value);
    else actions.print("xloom", "当前演示未连接聊天模型；使用 run 启动真实 TUI。任务补充请使用 /hint。");
    return;
  }
  const [command, ...rest] = value.split(/\s+/);
  const argument = value.slice(command!.length).trim();
  if (rest.length && !["/hint", "/run", "/model", "/login", "/open", "/chrome"].includes(command!)) {
    actions.print("xloom", `命令 ${command} 不接受参数。`);
    return;
  }
  switch (command) {
    case "/run":
      if (!argument) actions.print("xloom", "用法：/run 目标和目标范围");
      else if (actions.run && controller.runGoal) actions.run(argument);
      else actions.print("xloom", "当前演示不支持新建真实任务。请使用 run 启动真实 TUI。");
      break;
    case "/new":
      if (controller.resetChat) { controller.resetChat(); actions.print("xloom", "已新建普通聊天；旧聊天文件与任务黑板保留。"); }
      else actions.print("xloom", "当前演示没有普通聊天会话。");
      break;
    case "/history": {
      const history = controller.chatHistory?.();
      actions.print("Chat", history ? [history.file ?? "当前内存聊天", history.pendingToolCalls.length ? "存在结果不确定的工具；不能自动续接，可用 /new 开始新聊天。" : "保存的上下文可能含压缩摘要；完整内容见上方文件。",
        ...history.messages.map(message => `${message.role}: ${message.text}`)].join("\n\n") : "当前没有保存的聊天。");
      break;
    }
    case "/model":
      if (argument && !["all", "chat", "decide", "execute"].includes(argument)) actions.print("xloom", "用法：/model [all|chat|decide|execute]");
      else if (actions.settings) actions.settings("model", argument);
      else actions.print("xloom", "当前模式不支持模型设置。");
      break;
    case "/login":
    case "/logout":
      if (actions.settings) actions.settings(command.slice(1) as SettingsCommand, argument);
      else actions.print("xloom", "当前模式不支持凭据设置。");
      break;
    case "/start": actions.start(); break;
    case "/tasks": {
      const tasks = controller.listTasks?.();
      actions.print("Tasks", tasks?.length ? tasks.map(task => `${task.selected ? "* " : "  "}${task.id} · ${task.error ?? task.status}\n  ${task.goal ?? task.directory}`).join("\n") : "当前工作区尚无研究任务。");
      break;
    }
    case "/open":
      if (!argument || rest.length !== 1) actions.print("xloom", "用法：/open 完整任务ID；使用 /tasks 查看。");
      else if (controller.openTask) { controller.openTask(argument); actions.print("xloom", "已选择任务；/board 查看，/start 继续研究。"); }
      else actions.print("xloom", "当前模式不支持切换任务。");
      break;
    case "/paths": actions.print("Paths", controller.storagePaths ? JSON.stringify(controller.storagePaths(), null, 2) : "使用 xloom paths 查看数据目录。"); break;
    case "/chrome": {
      const action = argument || "status";
      if (!["status", "disconnect", "connect"].includes(action)) { actions.print("xloom", "用法：/chrome [status|disconnect|connect]"); break; }
      if (!controller.chromeControl) { actions.print("xloom", "当前演示没有 Chrome 连接。"); break; }
      void controller.chromeControl(action as "status" | "disconnect" | "connect").then(result => actions.print("Chrome", JSON.stringify(result)))
        .catch(error => actions.print("Chrome", error instanceof Error ? error.message : String(error)));
      break;
    }
    case "/pause": controller.pause(); actions.print("xloom", "已请求暂停；正在取消当前运行。"); break;
    case "/stop": controller.stop(); actions.print("xloom", "已请求停止；黑板与证据保留。"); break;
    case "/meta": controller.requestMetacog(); actions.print("xloom", "已请求 Decide 在下一调度点进行元认知复核。"); break;
    case "/hint":
      if (!argument) actions.print("xloom", "用法：/hint 补充信息");
      else { controller.hint(argument); actions.print("You → Blackboard", argument); }
      break;
    case "/board": actions.print("Blackboard", formatBoard(controller.snapshot())); break;
    case "/help": actions.print("xloom", HELP); break;
    case "/exit": actions.quit(); break;
    default: actions.print("xloom", `未知命令 ${compact(command ?? "")}。使用 /help 查看命令。`);
  }
}
