/** Paid opt-in integration replay through Xloom's AppController and real Pi agents. */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppController } from "../src/app.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { ensureProject, projectConfigPath, projectDirectory } from "../src/paths.js";
import { ChatSession } from "../src/runtime/chat.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel, type ModelResolver } from "../src/runtime/models.js";
import { selectTask } from "../src/workspace.js";
import type { AgentRunner, LoopEvent, ModelConfig, RuntimeEvent } from "../src/types.js";
import { wikiStructureFixture } from "../tests/fixtures/wiki-structure.js";
import { wikiIssues } from "../src/wiki/model.js";
import { analyzeToolOutcomes } from "./lib/tool-outcomes.js";
import { analyzeReadingOutcomes } from "./lib/reading-outcomes.js";
import { freshSessionChecks } from "./lib/live-session-validation.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live to call configured models.");
const configured = loadConfig(projectConfigPath(process.cwd()));
const models = [configured.models.chat ?? configured.models.execute, configured.models.decide, configured.models.execute];
const selected = new Map<string, Awaited<ReturnType<typeof resolveModel>>>();
for (const config of models) if (!selected.has(JSON.stringify(config))) selected.set(JSON.stringify(config), await resolveModel(config, AbortSignal.timeout(30000)));
const root = mkdtempSync(join(tmpdir(), "xloom-modes-live-")), output = resolve(values.output ?? join(root, "report.json"));
const oldHome = process.env.XLOOM_HOME; process.env.XLOOM_HOME = join(root, "home");
const workspace = join(root, "workspace"); mkdirSync(workspace); ensureProject(workspace);
const config = defaultConfig("Chat and Run synthetic integration"); config.models = configured.models; config.chrome = { enabled: false };
// No monetary/token/request caps. Timeouts detect a stuck test, not affordability.
config.limits = { ...config.limits, maxCost: null, maxTokens: null, maxTurnsPerRun: null, maxMinutes: 20, stepTimeoutSeconds: 240, metacogEvery: 3 };
const configFile = projectConfigPath(workspace); saveConfig(configFile, config);
const privateMarker = "CHAT_CONTEXT_MOSS_731", sourceMarker = "RUN_INPUT_KITE_492";
writeFileSync(join(workspace, "input.txt"), `SYNTHETIC LOCAL INPUT\nidentity=alice\nstate=v2\nresult=DENIED\nmarker=${sourceMarker}\n`);
let phaseId = "", activeRole = "chat", requests = 0, app: AppController | undefined, failure: string | undefined;
const phases: Record<string, any>[] = [], events: LoopEvent[] = [], calls: object[] = [];
const resolver: ModelResolver = async (model: ModelConfig) => {
  const provider = selected.get(JSON.stringify(model)); if (!provider) throw new Error("Unexpected model configuration in isolated replay");
  const role = activeRole;
  return { ...provider, streamFn: (model, context, options) => {
    requests++;
    const privateLeak = role !== "chat" && JSON.stringify(context).includes(privateMarker);
    const previousChatLeak = phaseId === "chat-fresh-after-restart" && [privateMarker, "CHAT_TOOL_TWO"].some(marker => JSON.stringify(context).includes(marker));
    calls.push({ phase: phaseId, role, model: model.id, messages: context.messages.length, tools: context.tools?.map(tool => tool.name), privateLeak, previousChatLeak });
    assert(!privateLeak, "Private Chat content leaked into Run");
    assert(!previousChatLeak, "Previous Chat content leaked into the restarted session");
    return provider.streamFn(model, context, options);
  } };
};
const pi = new PiRunner({ resolveModel: resolver });
const runner: AgentRunner = { async run(request) { activeRole = request.mode; return pi.run(request); } };
function open() {
  activeRole = "chat";
  const current = new AppController(workspace, configFile, config, { runner,
    chat: new ChatSession({ storageDirectory: join(projectDirectory(workspace), "chats"), resolveModel: resolver }) });
  current.subscribe(event => events.push(event)); return current;
}
const runtime = (start: number) => events.slice(start).flatMap(event => event.runtime ? [event.runtime] : []);
const toolStarts = (items: RuntimeEvent[]) => items.filter(event => event.type === "tool_start");
const parsedOutputs = (items: RuntimeEvent[]) => items.filter(event => event.type === "tool_end" && !event.isError).flatMap(event => {
  try { return [{ ...JSON.parse(event.text), toolCallId: event.toolCallId }]; } catch { return []; }
});
const finalChat = () => app!.chatHistory()!.messages.filter(message => message.role === "assistant").at(-1)!.text;
async function phase(id: string, body: (entry: Record<string, any>, eventStart: number) => Promise<void>) {
  phaseId = id; const entry: Record<string, any> = { id, checks: {} }, start = events.length, requestStart = requests, started = Date.now(); phases.push(entry);
  const timeout = setTimeout(() => { entry.watchdogTriggered = true; app?.pause(); }, 900000);
  try {
    await body(entry, start);
    entry.checks.watchdogNotTriggered = !entry.watchdogTriggered;
    entry.toolOutcomes = analyzeToolOutcomes(events.slice(start));
    if (id.startsWith("run-")) entry.checks.noUnrecoveredToolErrors = entry.toolOutcomes.unrecoveredErrors === 0;
    assert(Object.values(entry.checks).every(Boolean), `Failed checks: ${JSON.stringify(entry.checks)}`); entry.status = "passed";
  }
  catch (error) { entry.status = "failed"; entry.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    clearTimeout(timeout); Object.assign(entry, { requests: requests - requestStart, durationMs: Date.now() - started, events: events.slice(start), session: app?.getSessionInfo(),
      toolOutcomes: analyzeToolOutcomes(events.slice(start)) });
    // Preserve a report after every phase, even if a later phase is interrupted.
    save();
  }
}
function save() {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ status: failure ? "failed" : phases.every(p => p.status === "passed") ? "passed_so_far" : "running",
    scope: "Guided synthetic Xloom AppController/ChatSession/PiRunner replay with real tools; not a GUI or real vulnerability benchmark",
    root, models: models.map(model => ({ provider: model.provider, model: model.model })), requests, phases, calls, ...(failure ? { failure } : {}) }, null, 2));
}

try {
  app = open();
  await phase("chat-tools", async entry => {
    const start = events.length; activeRole = "chat";
    await app!.chat(`本轮是 Xloom 本地工具测试。记住私有聊天标记 ${privateMarker}，不要写进文件。必须依次使用 write 创建 chat-fixture.txt，内容为 CHAT_TOOL_ONE；edit 把 ONE 改成 TWO；read 核对全文；powershell 用 Get-Content 读这个文件核对。最后简述真实结果；不要创建研究任务，不访问外部目标。`);
    const seen = toolStarts(runtime(start)).map(event => event.toolName);
    entry.reply = finalChat(); entry.checks = { fileTools: ["write", "edit", "read", "powershell"].every(name => seen.includes(name)),
      fileResult: /^CHAT_TOOL_TWO(?:\r?\n)?$/.test(readFileSync(join(workspace, "chat-fixture.txt"), "utf8")), noResearchTask: app!.listTasks().length === 0,
      noToolErrors: !runtime(start).some(event => event.type === "tool_end" && event.isError),
      chatIdle: app!.getSessionInfo().mode === "chat" && !app!.getSessionInfo().busy };
    entry.archive = app!.chatHistory()!.file;
  });
  const oldChat = app.chatHistory()!.file!;
  await app.close(); app = open();
  await phase("chat-fresh-after-restart", async (entry, start) => {
    const initial = freshSessionChecks(app!);
    assert(Object.values(initial).every(Boolean), `Restart did not start a fresh session: ${JSON.stringify(initial)}`);
    activeRole = "chat";
    await app!.chat("只根据当前会话回答先前的私有聊天标记和文件最终内容；若当前会话没有这些信息，只回复 NO_PRIOR_CONTEXT。不要调用工具或重做文件操作。");
    entry.reply = finalChat(); entry.checks = { ...initial, noInventedHistory: entry.reply.includes("NO_PRIOR_CONTEXT"),
      oldPrivateContextAbsent: ![privateMarker, "CHAT_TOOL_TWO"].some(marker => JSON.stringify(app!.chatHistory()!.messages).includes(marker)),
      newArchive: !!app!.chatHistory()!.file && app!.chatHistory()!.file !== oldChat, oldArchivePreserved: existsSync(oldChat),
      noReplay: toolStarts(runtime(start)).length === 0 };
  });
  await phase("chat-native-exit-diagnostics", async (entry, start) => {
    activeRole = "chat";
    await app!.chat("隔离目录中的工具回归：只调用一次 powershell，原样执行 node -e 'process.exit(7)'; Write-Output 'NEXT_OK' 。不要改写，不要重试或补救，然后如实报告工具的错误与输出。这是故意制造的非零退出。不要使用其他工具。");
    const seen = runtime(start), calls = toolStarts(seen), results = seen.filter(event => event.type === "tool_end");
    entry.reply = finalChat(); entry.checks = { once: calls.length === 1 && calls[0].toolName === "powershell",
      failureVisible: results.length === 1 && results[0].isError === true && results[0].text.includes("last native exit code=7") && results[0].text.includes("NEXT_OK"),
      chatRecovered: app!.getSessionInfo().status === "idle" && !app!.getSessionInfo().busy };
  });
  await phase("chat-format-error-recovery", async (entry, start) => {
    activeRole = "chat";
    await app!.chat("这是故意的 PowerShell 格式错误回归。先原样实际调用 powershell：$items=[System.Collections.Generic.List[string]]::new(); $items.Add('x={0}, y={1}' -f 1,2); $items 。不要预先修正。收到报错后根据工具提示改正表达式，再调用一次 powershell 输出正确的格式化结果。不要调用其他工具、访问文件或执行其他动作，最后如实总结。");
    const seen = runtime(start), calls = toolStarts(seen), results = seen.filter(event => event.type === "tool_end");
    entry.reply = finalChat(); entry.checks = { bounded: calls.length === 2 && calls.every(call => call.toolName === "powershell"),
      guidance: results[0]?.isError === true && results[0].text.includes("parenthesize the complete -f expression"),
      corrected: results[1]?.isError === false && results[1].text.includes("x=1, y=2"),
      chatRecovered: app!.getSessionInfo().status === "idle" && !app!.getSessionInfo().busy };
  });
  await phase("chat-cancel-and-recover", async entry => {
    activeRole = "chat";
    let cancelled = false;
    const detach = app!.subscribe(event => { if (!cancelled && event.runtime?.type === "tool_start" && event.runtime.toolName === "powershell") {
      cancelled = true; setTimeout(() => app!.pause(), 300);
    } });
    const pending = app!.chat("取消能力测试：仅调用 powershell，执行 Start-Sleep -Seconds 12，然后写 chat-cancelled.txt 内容 UNEXPECTED。不要使用其他工具；测试装置将在等待时取消本轮。");
    const concurrency = await Promise.resolve().then(() => app!.chat("并发调用不应启动")).then(() => false, () => true);
    let interrupted = false;
    try { await pending; } catch { interrupted = true; } finally { detach(); }
    const paused = app!.getSessionInfo().status;
    await app!.chat("取消测试已结束，放弃刚才的写文件动作。只回复 RECOVERED_OK，不调用工具。");
    entry.reply = finalChat(); entry.checks = { concurrencyRejected: concurrency, interrupted: interrupted && cancelled,
      paused: paused === "paused", noLateWrite: !existsSync(join(workspace, "chat-cancelled.txt")),
      recovered: entry.reply.includes("RECOVERED_OK") && app!.getSessionInfo().status === "idle" };
  });
  await phase("chat-reset", async entry => {
    app!.resetChat(); activeRole = "chat";
    await app!.chat("全新聊天，只回复 RESET_OK，不调用工具。");
    entry.checks = { newArchive: app!.chatHistory()!.file !== oldChat, oldArchivePreserved: existsSync(oldChat),
      oldHistoryAbsent: !JSON.stringify(app!.chatHistory()!.messages).includes(privateMarker), reply: finalChat().includes("RESET_OK") };
  });
  let completedTask = "";
  await phase("run-goal-file-roundtrip", async (entry, start) => {
    await app!.runGoal("合成本地软件回归，只在当前 workspace：验证合成假设 fixture-copy-corruption（复制会改变输入字节），未测试真实目标或真实漏洞。安排一个有界 Execute 完成读取 input.txt、复制到本轮 artifacts/observed.txt、实际读回与 SHA256 对比。使用 PowerShell Copy-Item、.NET ReadAllBytes 和 SHA256 即可完成对照；本回放不测试 fc/cmp、嵌套 powershell.exe 或其他旧工具兼容性，不开展额外工具排错。把原样文件、比较命令和真实输出留在 artifacts 并登记 Evidence/Fact：artifacts/observed.txt 必须作为独立 Evidence 登记，不能只登记哈希或日志。Fact 必须逐字保留输入中的 identity=alice、state=v2、result=DENIED；这是合成文件内容，与复制操作成功是两回事，不能把 DENIED 说成成功。Execute 登记一个对应合成假设的 Finding（lead），供后续基于真实对照结果复核关闭；关闭理由包含重新检查的条件。只有新鲜元认知读到归档原件、确认这个假设有对照证据且关闭后，才满足根目标并以 NOT_REPRODUCED 结束合成测试。不要追加其他调查，不读取聊天历史。");
    const board = app!.snapshot(), seen = runtime(start), results = parsedOutputs(seen);
    const roles = events.slice(start).flatMap(event => event.handoff ? [event.handoff.mode] : []);
    entry.board = board; entry.checks = { completed: board.status === "completed" && board.outcome === "NOT_REPRODUCED", roles: ["decide", "execute", "metacog"].every(role => roles.includes(role as any)),
      persistedEvidence: board.evidence.length > 0 && board.facts.length > 0, observedDenied: JSON.stringify(board.facts).includes("DENIED"),
      archivedInput: board.evidence.some(evidence => readFileSync(join(app!.storagePaths().task!, evidence.path), "utf8").includes(sourceMarker)),
      noPrivateLeak: !JSON.stringify(board).includes(privateMarker) };
    completedTask = app!.listTasks().find(task => task.directory === app!.storagePaths().task)!.id;
    entry.nativeOriginalReads = results.filter(result => result.type === "original_read").length;
  });
  await app.close();
  const nativeConfig = structuredClone(config);
  nativeConfig.goal = "核对本地合成报表观察的原件与更正；未验证下载成功";
  nativeConfig.context = "本段专测原生检索接口，仅核对当前合成研究材料。Decide 和 Execute 各自先调用 read，path=xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000；取得 complete=true 的完整来源包后沿 evidence.originalReadPath 精读全部原件与更正。文件路径直读虽能读取内容，但不满足本段原生接口测试；本段不要打开 Wiki index/pages/record，所需记录由来源包提供。Decide 安排一个 Execute 做同样的原生搜索、原件核对和 WK-flow 元数据维护，并在 Step 中写明上述入口和读取约束（仅 aliases 增加 InspectedBridge，省略 blocks）。不添加新 Fact/Evidence/Finding，核对日志不是新观察。不执行任何下载，不复核旧解释，不结束根目标。Execute 后 Decide 基于现有资料说明剩余缺口并不再安排动作。用现有 read；不访问外部目标。";
  const fixture = wikiStructureFixture(workspace, nativeConfig); fixture.correct(); fixture.store.setStatus("paused", "Synthetic native review replay"); fixture.store.close(); selectTask(workspace, null);
  app = open(); app.openTask("@legacy");
  await phase("run-original-reading", async (entry, start) => {
    const before = app!.snapshot();
    entry.before = before;
    await app!.start();
    const seen = runtime(start), outputs = parsedOutputs(seen), board = app!.snapshot();
    const originals = outputs.filter(result => result.type === "original_read" && result.integrity === "verified");
    const readCalls = toolStarts(seen).filter(event => event.toolName === "read").map(event => ({ mode: event.mode, path: JSON.parse(event.text).path as string }));
    const reading = analyzeReadingOutcomes(seen, before.evidence, app!.storagePaths().task!, workspace);
    entry.reading = reading;
    const page = board.wikiPages!.find(page => page.id === "WK-flow")!, oldPage = before.wikiPages!.find(page => page.id === "WK-flow")!;
    entry.readCalls = readCalls; entry.board = board; entry.originalRanges = originals.map(result => ({
      mode: seen.find(event => event.toolCallId === result.toolCallId)?.mode, locator: result.locator, reading: result.reading }));
    entry.checks = { nativeSearchByBothRoles: reading.nativeSearchByRequiredRoles, originalReadingByBothRoles: reading.nativeReadingByRequiredRoles,
      correctionRead: originals.some(result => result.text.includes("v1 observation withdrawn")),
      metadataCommitted: !!board.wikiPages?.find(page => page.id === "WK-flow")?.aliases?.includes("InspectedBridge"),
      noNewObservations: JSON.stringify([board.evidence, board.facts, board.findings]) === JSON.stringify([before.evidence, before.facts, before.findings]),
      preservedReview: JSON.stringify(page.blocks) === JSON.stringify(oldPage.blocks)
        && JSON.stringify(wikiIssues(board, page)) === JSON.stringify(wikiIssues(before, oldPage)),
      noPrematureCompletion: board.goals[0]!.status === "active" && board.outcome === null,
      noResearchError: board.status === "paused",
      noRedundantWikiFiles: !readCalls.some(call => /[/\\]wiki[/\\](?:pages[/\\]|index\.md)/.test(call.path)) };
  });
  await phase("idle-run-restart", async entry => {
    const before = app!.snapshot(); await app!.close(); app = open();
    const fresh = freshSessionChecks(app);
    assert(Object.values(fresh).every(Boolean), `Restart unexpectedly restored state: ${JSON.stringify(fresh)}`);
    app.openTask("@legacy");
    entry.checks = { ...fresh, preservedDiagnosis: JSON.stringify(app.snapshot()) === JSON.stringify(before), idle: !app.getSessionInfo().busy };
  });
  await phase("mode-switch-and-reopen-completed", async (entry, start) => {
    const before = app!.snapshot(); activeRole = "chat";
    await app!.chat("普通聊天检查：只回复 CHAT_AFTER_RUN_OK，不调用工具。");
    const unchanged = JSON.stringify(app!.snapshot()) === JSON.stringify(before);
    app!.openTask(completedTask); const previousRequests = requests; await app!.start();
    entry.checks = { chatAfterRun: finalChat().includes("CHAT_AFTER_RUN_OK"), unchangedBoard: unchanged,
      completedNotReplayed: requests === previousRequests && app!.snapshot().status === "completed", noTools: toolStarts(runtime(start)).length === 0 };
  });
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  await app?.close(); save();
  const report = JSON.parse(readFileSync(output, "utf8")); report.status = failure ? "failed" : "passed"; writeFileSync(output, JSON.stringify(report, null, 2));
  if (oldHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = oldHome;
}
console.log(JSON.stringify({ status: failure ? "failed" : "passed", reportFile: output, requests,
  phases: phases.map(({ id, status, checks, requests }) => ({ id, status, checks, requests })), ...(failure ? { failure } : {}) }, null, 2));
if (failure) process.exitCode = 1;
