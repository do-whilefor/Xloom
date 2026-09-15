/** Opt-in paid model smoke test. Uses only synthetic fixtures in an isolated data home. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel } from "../src/runtime/models.js";
import { planningMaterials } from "../src/wiki/materials.js";
import { gapQueue } from "../src/knowledge/gaps.js";
import { capabilityIssues } from "../src/knowledge/model.js";
import type { Decision, RunRequest, RuntimeEvent } from "../src/types.js";
import { nativeFixture, zero } from "../tests/fixtures/native-retrieval.js";
import { analyzeReadingOutcomes, successfulReadCalls } from "./lib/reading-outcomes.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live explicitly to use the configured model and incur model usage.");
const workspace = process.cwd(), configured = loadConfig(projectConfigPath(workspace));
// Resolve credentials once in the user's configured home, before isolating all fixture writes.
const selected = await resolveModel(configured.models.decide, AbortSignal.timeout(30000));
const root = mkdtempSync(join(tmpdir(), "xloom-native-live-"));
const reportFile = resolve(values.output ?? join(root, "report.json"));
const previousHome = process.env.XLOOM_HOME;
process.env.XLOOM_HOME = join(root, "home");
const config = defaultConfig("验证本地报表的实际下载结果；已有凭据不等于完成下载", "Only synthetic local files; no external target");
config.models = configured.models;
config.chrome = { enabled: false };
config.context = `这是原生 read 接口的合成验收。每次 Decide 都必须在提交计划前实际完成以下调用（已有材料包也不能省略）：
1. 调用 read，参数 {"path":"xloom://search?mode=combined&query=BridgeNote&budgetChars=64000"}，取得 complete=true 的 Wiki 来源与更正。
2. 调用 read，参数 {"path":"xloom://discover?consumerId=C-download&budgetChars=64000"}，核对消费者与供给条件。
3. 将上述完整来源包中的每个 evidence.originalReadPath 原样作为 read 的 path，逐一读取全部原件；如有 nextReadPath，继续读取。必须在本次 Decide 中读取新授权原件，不能只把原件核对安排给未来的 Execute。归档文件绝对路径、Wiki 文件或 record 读取不满足本段 xloom://search 与 xloom://original 接口验收。
基于实际读取内容核对 alice/v1 条件：缺少授权时计划获取缺失输入；新授权到来时先核对来源与更正，再规划带 revisits 的有界实际下载验证。尚未执行下载，不要 resolve 下载缺口或结束根目标。只规划，不访问外部目标。`;
// No monetary/token/request caps. The ten-minute stage watchdog detects a stuck run.
config.limits = { ...config.limits, maxCost: null, maxTurnsPerRun: null, maxTokens: null, maxMinutes: 10, stepTimeoutSeconds: 600 };
const fixture = nativeFixture(root, config), phases: Record<string, any>[] = [];
let requests = 0, failure: string | undefined;
const runner = new PiRunner({ resolveModel: async () => ({ ...selected, streamFn: (...args) => { requests++; return selected.streamFn(...args); } }) });
function save(status: "running" | "passed" | "failed") {
  const report = { status, model: { provider: configured.models.decide.provider, id: configured.models.decide.model },
    scope: "Explicitly guided native-interface smoke test over two synthetic snapshots; not autonomous research or vulnerability recall evaluation", root, phases, requests, ...(failure ? { failure } : {}) };
  mkdirSync(dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return report;
}
async function phase(id: string, hasProvider: boolean) {
  fixture.store.setStatus("running", "Live native interface smoke test"); fixture.store.beginRun(id, "decide");
  const events: RuntimeEvent[] = [], baseline = fixture.store.materialReceipts();
  const snapshot = fixture.store.snapshot();
  const request: RunRequest = { id, mode: "decide", snapshot, workspace: root, runDir: join(fixture.store.dataDir, "runs", id),
    blackboardPath: fixture.store.projectionPath, signal: AbortSignal.timeout(600000), onEvent: event => { events.push(event); },
    materialBaseline: baseline, materials: planningMaterials(snapshot, baseline, fixture.store.dataDir, root) };
  const started = Date.now(), requestStart = requests;
  const entry: Record<string, any> = { id, status: "running", checks: {} }; phases.push(entry); save("running");
  try {
    const result = await runner.run(request), decision = result.output as Decision;
    const reads = successfulReadCalls(events);
    const search = reads.find(call => call.path.startsWith("xloom://search?") && call.packet?.type === "task_search"
      && call.packet.query === "BridgeNote" && ["wiki", "combined"].includes(call.packet.mode) && call.packet.complete === true)?.packet;
    const discovery = reads.find(call => call.path.startsWith("xloom://discover?") && call.packet?.type === "discovery_context"
      && call.packet.consumerId === "C-download" && call.packet.complete === true)?.packet;
    const reading = analyzeReadingOutcomes(events, snapshot.evidence, fixture.store.dataDir, root,
      { roles: ["decide"], query: "BridgeNote", searchModes: ["wiki", "combined"] });
    // Earlier planning may declare counterevidence against the consumer's source.
    // A new supplier cannot acknowledge that source change on the author's behalf.
    const expectedReview = capabilityIssues(snapshot, snapshot.capabilities!.find(item => item.id === "C-download")!);
    const candidate = discovery?.items[0];
    const compatibleSupplier = candidate?.inputs?.some((input: any) => input.alternatives.some((alt: any) => alt.producerId === "C-grant"
      && alt.conditions.status === "compatible" && !alt.reviewIssues.length));
    const checks = {
      wikiSearch: !!search?.wiki?.records?.some((record: any) => record.ref.kind === "block"),
      targetedDiscovery: !!discovery,
      supplierMatchesState: hasProvider ? !!compatibleSupplier : !compatibleSupplier,
      planMatchesState: !!candidate && (hasProvider && !expectedReview.length ? candidate.plan?.requirementsCovered === true : candidate.plan === null),
      sourceReviewPreserved: !!candidate && expectedReview.every(issue => candidate.reviewIssues.includes(issue)),
      allOriginalsRead: reading.nativeReadingByRequiredRoles,
      readVerifiedOriginal: !hasProvider || reads.some(call => call.path.startsWith("xloom://original?") && call.packet?.type === "original_read"
        && call.packet.integrity === "verified" && call.packet.text?.includes("LOCAL_ONLY")
        && reading.coverage[0]?.evidence.some(item => item.id === call.packet.locator?.evidenceId && item.nativeComplete)),
      sawCorrection: !hasProvider || !!search?.wiki?.records?.some((record: any) => record.ref.kind === "block" && record.status === "review_required"),
      plannedRevisit: !hasProvider || !!decision.steps?.some(step => step.revisits?.some(ref => ref.stepId === fixture.step.id && ref.gapId === "gap-download")),
      noPrematureCompletion: !decision.conclusion && !decision.gapReviews?.some(review => review.action === "resolve") && !decision.updateGoals?.some(goal => goal.id === "G0" && goal.status === "satisfied"),
      noToolErrors: !events.some(event => event.type === "tool_end" && event.isError),
    };
    Object.assign(entry, { checks, expectedConsumerReview: expectedReview, usage: result.usage, decision });
    assert(Object.values(checks).every(Boolean), `Native smoke assertions failed: ${JSON.stringify(checks)}`);
    fixture.store.applyDecision(id, decision, result.usage, { ...request.materials!, items: [...request.materials!.items, ...request.materialReads ?? []] });
    assert.notEqual(gapQueue(fixture.store.snapshot())[0]!.state, "resolved");
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed"; entry.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    Object.assign(entry, { requests: requests - requestStart, durationMs: Date.now() - started, events, watchdogTriggered: request.signal.aborted,
      readPaths: events.filter(event => event.type === "tool_start" && event.toolName === "read").map(event => { try { return JSON.parse(event.text).path; } catch { return event.text; } }),
      reading: analyzeReadingOutcomes(events, snapshot.evidence, fixture.store.dataDir, root, { roles: ["decide"], query: "BridgeNote", searchModes: ["wiki", "combined"] }) });
    save(entry.status === "failed" ? "failed" : "running");
  }
}
try {
  await phase("live-before", false);
  // Do not execute model-proposed actions: the harness supplies a new synthetic observation.
  const ready = fixture.store.snapshot().steps.filter(step => step.status === "ready");
  if (ready.length) { fixture.store.beginRun("harness-supersede", "decide"); fixture.store.applyDecision("harness-supersede", { summary: "Harness supplies next synthetic sample",
    updateSteps: ready.map(step => ({ id: step.id, action: "abandon", reason: "Synthetic harness supplies new input; no target action executed" })) }, zero); }
  fixture.addProvider();
  await phase("live-after", true);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  fixture.store.close();
  if (previousHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = previousHome;
}
const report = save(failure ? "failed" : "passed");
console.log(JSON.stringify({ status: report.status, model: report.model, requests, reportFile, phases: phases.map((phase: any) => ({ id: phase.id, checks: phase.checks, usage: phase.usage })), ...(failure ? { failure } : {}) }, null, 2));
if (failure) process.exitCode = 1;
