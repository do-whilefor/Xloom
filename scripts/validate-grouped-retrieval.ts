/** Configured-model replay: retrieve multiple inputs, read their actual archive
 * versions and plan without treating lexical coverage as a successful result. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, loadConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { BlackboardStore } from "../src/store.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import { resolveModel } from "../src/runtime/models.js";
import { planningMaterials } from "../src/wiki/materials.js";
import type { Decision, RunRequest, RuntimeEvent } from "../src/types.js";
import { beginFixtureStep, zero } from "../tests/fixtures/native-retrieval.js";
import { toolFailureDetails } from "./lib/tool-failure-details.js";
import { redactCredentials } from "../src/runtime/redaction.js";

const { values } = parseArgs({ options: { live: { type: "boolean" }, output: { type: "string" } }, strict: true });
if (!values.live) throw new Error("Pass --live to use the configured model.");
const configured = loadConfig(projectConfigPath(process.cwd()));
const selected = await resolveModel(configured.models.decide, AbortSignal.timeout(30000));
const root = mkdtempSync(join(tmpdir(), "xloom-grouped-live-")), output = resolve(values.output ?? join(root, "report.json"));
const previousHome = process.env.XLOOM_HOME; process.env.XLOOM_HOME = join(root, "home");
const config = defaultConfig("依据当前任务归档，判断报表读取还缺什么条件并规划下一步", "Only synthetic local files; read-only planning; no external target");
config.models = configured.models; config.chrome = { enabled: false };
config.limits = { ...config.limits, maxTokens: null, maxCost: null, maxTurnsPerRun: null, stepTimeoutSeconds: null };
config.context = "这是只读原生检索接口回放。先读取所给缺口的 question 入口；complete=false 时先按返回诊断和 nextReadPath 补全来源包，预算最高 64000。随后使用返回的 xloom://original 定位入口精读有关授权和对象的归档原件，核对实际身份、版本和结果；本场景验证带完整性校验的原生读取。依据观察规划有界下一步，禁止新增观察或访问外部目标。检索命中不表示业务完成；不要为了继续查询而创建多条检索步骤。继续已有缺口的步骤须使用该缺口原 goalId，并带 revisits 引用。同一缺口在本次 Decision 中只选一种处置：用新 Step.revisits 计划跟进，或用 gapReviews 的 defer/resolve 暂缓或关闭；不可同时出现在这两个字段，gapReviews 内也不可重复。本轮需要规划跟进，所以保留 Step.revisits，并省略对应的 gapReviews 项。";
config.context += "本回放还要验证 original 精读接口：提交之前必须实际调用 read 分别读取授权和对象的 xloom://original 路径（使用 question 返回的路径即可）。即使 question 已展示有关片段，也不能跳过这两次接口调用；本次检验包含工具路径可用性，不只是根据片段答题。";
const store = new BlackboardStore(root, config, { taskId: "task-grouped-live" });
let requests = 0, failure: string | undefined;
const events: RuntimeEvent[] = [];
const report: Record<string, unknown> = { root, model: { provider: configured.models.decide.provider, id: configured.models.decide.model },
  scope: "Guided synthetic multi-input retrieval and archive-condition replay; no expected answer labels in model context; not autonomous accuracy or cost comparison." };
try {
  const step = beginFixtureStep(store, "seed"), artifacts = join(store.dataDir, "runs", "seed", "artifacts"); mkdirSync(artifacts, { recursive: true });
  const samples = [
    { ref: "grant", body: "SYNTHETIC observation: downloadGrant issued; identity=alice; stateVersion=v1; grant=LOCAL_GRANT; report download NOT_ATTEMPTED.", description: "Recorded grant issuance" },
    { ref: "object", body: "unrelated padding\n".repeat(4500) + "SYNTHETIC observation: reportKey=LOCAL_OBJECT; identity=alice; stateVersion=v2; object registration only; report download NOT_ATTEMPTED.", description: "Recorded object registration" },
    ...Array.from({ length: 6 }, (_, index) => ({ ref: `catalog${index}`, body: `SYNTHETIC catalogue ${index}: downloadGrant exportPermit reportTicket. These are vocabulary entries, not an issued input.`, description: `Catalogue vocabulary ${index}` })),
  ];
  for (const sample of samples) writeFileSync(join(artifacts, `${sample.ref}.txt`), sample.body);
  store.applyExecution("seed", { summary: "Preserve synthetic input observations", result: "blocked",
    evidence: samples.map(sample => ({ ref: sample.ref, path: `${sample.ref}.txt`, description: sample.description })),
    facts: samples.map(sample => ({ ref: `${sample.ref}-fact`, description: sample.description, evidenceRefs: [sample.ref] })),
    gaps: [{ id: "gap-inputs", missing: "报表读取需要授权和对象，适用条件仍需核对", why: "Both inputs are required", reopenWhen: "Inputs and common conditions verified by observations",
      needs: [{ type: "downloadGrant", aliases: ["exportPermit", "reportTicket"], description: "downloadGrant issued" },
        { type: "objectHandle", aliases: ["reportKey", "resultRef"], description: "object registration" }],
      conditions: { scope: "local report", identity: "alice", environment: "synthetic", stateVersion: "v1" } }],
  }, zero);
  store.setStatus("running", "Configured-model retrieval replay"); store.beginRun("live-plan", "decide");
  const board = store.snapshot(), baseline = store.materialReceipts(), started = Date.now();
  const request: RunRequest = { id: "live-plan", mode: "decide", snapshot: board, workspace: root,
    runDir: join(store.dataDir, "runs", "live-plan"), blackboardPath: store.projectionPath,
    signal: AbortSignal.timeout(300000), onEvent: event => { events.push(event); },
    materialBaseline: baseline, materials: planningMaterials(board, baseline, store.dataDir, root) };
  const runner = new PiRunner({ resolveModel: async () => ({ ...selected, streamFn: (...args) => { requests++; return selected.streamFn(...args); } }) });
  const result = await runner.run(request), decision = result.output as Decision;
  const outputs = events.filter(event => event.type === "tool_end" && !event.isError).flatMap(event => { try { return [JSON.parse(event.text) as Record<string, any>]; } catch { return []; } });
  const question = outputs.find(value => value.type === "question_context" && value.complete);
  const originals = outputs.filter(value => value.type === "original_read" && value.integrity === "verified");
  const grantId = board.evidence.find(item => item.description === samples[0]!.description)!.id;
  const objectId = board.evidence.find(item => item.description === samples[1]!.description)!.id;
  const checks = {
    groupedQuestion: question?.originals?.queryGroups?.some((group: any) => group.id === "need:0" && group.fullExpressionWindows > 0)
      && question.originals.queryGroups.some((group: any) => group.id === "need:1" && group.fullExpressionWindows > 0) || false,
    readGrant: originals.some(value => value.locator.evidenceId === grantId && value.text.includes("stateVersion=v1")),
    readObject: originals.some(value => value.locator.evidenceId === objectId && value.text.includes("stateVersion=v2")),
    statesDisclosed: decision.summary.includes("v1") && decision.summary.includes("v2"),
    noPrematureResolution: !decision.conclusion && !decision.gapReviews?.some(review => review.action === "resolve") && !decision.updateGoals?.some(goal => goal.id === "G0" && goal.status === "satisfied"),
    plannedRevisit: !!decision.steps?.some(next => next.revisits?.some(ref => ref.stepId === step.id && ref.gapId === "gap-inputs")),
    noToolErrors: !events.some(event => event.type === "tool_end" && event.isError),
  };
  Object.assign(report, { checks, usage: result.usage, durationMs: Date.now() - started, decision,
    nativeOutputs: outputs.filter(value => value.type).map(value => ({ type: value.type, complete: value.complete, status: value.status,
      queryGroups: value.originals?.queryGroups, nextReadPath: value.nextReadPath })),
    readPaths: events.filter(event => event.type === "tool_start" && event.toolName === "read").map(event => JSON.parse(event.text).path),
    reading: outputs.filter(value => value.reading).map(value => ({ type: value.type, reading: value.reading })) });
  assert(Object.values(checks).every(Boolean), `Replay assertions failed: ${JSON.stringify(checks)}`);
  store.applyDecision("live-plan", decision, result.usage, { ...request.materials!, items: [...request.materials!.items, ...request.materialReads ?? []] });
  assert.equal(store.snapshot().facts.length, board.facts.length); assert.equal(store.snapshot().evidence.length, board.evidence.length);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  report.toolErrors = toolFailureDetails(events, selected.secrets);
  store.close(); if (previousHome === undefined) delete process.env.XLOOM_HOME; else process.env.XLOOM_HOME = previousHome;
}
Object.assign(report, { status: failure ? "failed" : "passed", requests, ...(failure ? { failure } : {}) });
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, redactCredentials(JSON.stringify(report, null, 2), selected.secrets ?? []) + "\n");
console.log(redactCredentials(JSON.stringify({ status: report.status, output, requests, checks: report.checks, usage: report.usage, ...(failure ? { failure } : {}) }, null, 2), selected.secrets ?? []));
if (failure) process.exitCode = 1;
