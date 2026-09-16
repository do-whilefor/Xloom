import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calculateCvss, calculatorFile, cvssIssues, cvssProposalSchema, metricKeys, roundup, validateCvssExecution, type CvssProposal } from "../src/scoring/cvss.js";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { renderReport } from "../src/report.js";
import { formatBoard } from "../src/ui/model.js";
import { projectContext } from "../src/loop/context.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { wikiRecord } from "../src/wiki/model.js";
import type { Execution, RunRequest } from "../src/types.js";

const vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N";
// Fixed regression examples; expected scores are not produced by this calculator.
const examples = [
  ["AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N", 6.4, "MEDIUM"],
  ["AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N", 3.1, "LOW"],
  ["AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 9.9, "CRITICAL"],
  ["AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:L", 4.2, "MEDIUM"],
  ["AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H", 7.2, "HIGH"],
  ["AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5, "HIGH"],
  ["AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "CRITICAL"],
] as const;
const assessment = (refs = ["f"], assumption = false): CvssProposal => ({ vector, rationale: Object.fromEntries(metricKeys.map(key => [key, { reason: `Synthetic ${key} rationale; not a real vulnerability claim`, factRefs: refs, assumption }])) as CvssProposal["rationale"] });
const usage = { input: 2, output: 1, cost: 0 };
const opened: { root: string; store: BlackboardStore }[] = [];
function begin(store: BlackboardStore, run: string) {
  store.beginRun(`plan-${run}`, "decide"); store.applyDecision(`plan-${run}`, { summary: "Plan synthetic scoring fixture", steps: [{ goalId: "G0", from: [], description: `Fixture ${run}`, successSignal: "Local result", evidencePlan: "Synthetic artifact", priority: 1 }] }, usage);
  const step = store.snapshot().steps.at(-1)!; store.beginRun(run, "execute", step.id);
  const directory = join(store.dataDir, "runs", run, "artifacts"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "original.txt"), `SYNTHETIC ONLY ${run}: fixture observations. No target contacted.`);
  return step;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-cvss-")), store = new BlackboardStore(root, defaultConfig("Synthetic scoring"), { taskId: "task-scoring" });
  opened.push({ root, store }); store.setStatus("running", "Fixture"); begin(store, "initial"); return { root, store };
}
function execution(extra: Partial<Execution> = {}): Execution {
  return { summary: "Fixture findings", result: "done", evidence: [{ ref: "e", path: "original.txt", description: "Synthetic original" }],
    facts: [{ ref: "f", description: "Fixture observation", evidenceRefs: ["e"] }],
    findings: [{ key: "fixture", target: "synthetic-local-only", title: "Fixture finding", status: "technical_hit", factRefs: ["f"], evidenceRefs: ["e"], next: "Independent review required", cvss: assessment() }], ...extra };
}
afterEach(() => { for (const { root, store } of opened.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });

describe("bundled CVSS calculator", () => {
  it.each(examples)("calculates %s as %s %s", (bare, score, severity) => {
    expect(calculateCvss(bare)).toMatchObject({ vector: `CVSS:3.1/${bare}`, baseScore: score, severity, version: "3.1", metricGroup: "Base" });
  });
  it("handles zero impact, Scope Changed, ceiling, ordering and five-decimal Roundup", () => {
    for (const scope of ["U", "C"]) expect(calculateCvss(`AV:N/AC:L/PR:N/UI:N/S:${scope}/C:N/I:N/A:N`).baseScore).toBe(0);
    expect(calculateCvss("AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N").baseScore).toBe(4.7);
    expect(calculateCvss("AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H").baseScore).toBe(10);
    expect(calculateCvss("a:n/i:n/c:h/s:u/ui:n/pr:n/ac:l/av:n").vector).toBe(vector);
    expect([roundup(4.02), roundup(4), roundup(0.1 + 0.2)]).toEqual([4.1, 4, 0.3]);
  });
  it.each([vector.replace("3.1", "4.0"), vector.replace("3.1", "3.0"), vector + "/AV:N", vector + "/E:F", vector.replace("S:U", "S:X"), vector.replace("/S:U", ""), vector.replace("AV:N", "AV:N:EXTRA"), vector + "/"])("rejects invalid or unsupported input %s", value => {
    expect(() => calculateCvss(value)).toThrow(); expect(cvssProposalSchema.safeParse({ ...assessment(), vector: value }).success).toBe(false);
  });
  it("provides a functional CLI and import without stdin side effects", () => {
    expect(JSON.parse(execFileSync(process.execPath, [calculatorFile, "--json", vector], { encoding: "utf8" })).baseScore).toBe(7.5);
    expect(execFileSync(process.execPath, [calculatorFile, vector], { encoding: "utf8" })).toContain("Score:     7.5");
    const result = execFileSync(process.execPath, ["-e", "const before=process.stdin.listenerCount('data'); const api=require(process.argv[1]); console.log(JSON.stringify([typeof api.calc,process.stdin.listenerCount('data')-before]));", calculatorFile], { encoding: "utf8", input: "not a vector" });
    expect(JSON.parse(result)).toEqual(["function", 0]);
  });
});

describe("native Finding assessments", () => {
  it("calculates same-batch vectors transactionally and persists scores without promoting the Finding or selecting priority", () => {
    const { root, store } = fixture(); const output = execution();
    expect(() => validateCvssExecution(store.snapshot(), output)).not.toThrow();
    store.applyExecutionCheckpoint("initial", "scored", output, usage); const checkpoint = store.snapshot();
    store.applyExecutionCheckpoint("initial", "scored", output, usage); expect(store.snapshot()).toEqual(checkpoint);
    store.applyExecution("initial", { summary: "Finish", result: "done" }, usage);
    const board = store.snapshot(), finding = board.findings[0]!;
    expect(finding).toMatchObject({ status: "technical_hit", rating: "unrated", cvss: { baseScore: 7.5, severity: "HIGH", status: "proposed" } });
    expect(finding.cvss!.rationale.AV.factIds).toEqual(finding.factIds); expect(board.steps[0]!.priority).toBe(1); expect(board.goals[0]!.status).toBe("active");
    expect(cvssIssues(board, finding)).toEqual(["awaiting_decide_review"]);
    store.close(); const reopened = new BlackboardStore(root, board.config, { taskId: "task-scoring" }); opened[0]!.store = reopened;
    expect(reopened.snapshot().findings[0]!.cvss).toEqual(finding.cvss);
  });

  it("permits conditional estimates on leads, and keeps their assumptions visible after a scoring review", () => {
    const { store } = fixture(); const output = execution({ facts: [], evidence: [] });
    output.findings![0] = { ...output.findings![0]!, status: "lead", factRefs: [], evidenceRefs: [], cvss: assessment([], true) };
    store.applyExecution("initial", output, usage); const finding = store.snapshot().findings[0]!;
    store.beginRun("review", "decide"); store.applyDecision("review", { summary: "Conditional score only", cvssReviews: [{ findingId: finding.id, assessment: assessment([], true), reason: "All choices remain assumptions" }] }, usage);
    const board = store.snapshot(); expect(board.findings[0]).toMatchObject({ status: "lead", rating: "unrated", cvss: { status: "reviewed" } });
    expect(cvssIssues(board, board.findings[0]!)).toContain("conditional_metrics");
    expect(renderReport(board)).toContain("assumption; Facts: none"); expect(formatBoard(board)).toContain("conditional_metrics");
  });

  it("reviews scoring independently, and exposes changed sources consistently in prompt, report and Wiki", () => {
    const { store, root } = fixture(); store.applyExecution("initial", execution(), usage); const finding = store.snapshot().findings[0]!;
    store.beginRun("review", "decide"); store.applyDecision("review", { summary: "Review arithmetic and reasons", cvssReviews: [{ findingId: finding.id, assessment: assessment(finding.factIds), reason: "Synthetic evidence reviewed" }] }, usage);
    expect(cvssIssues(store.snapshot(), store.snapshot().findings[0]!)).toEqual([]);
    begin(store, "correction"); store.applyExecution("correction", execution({ findings: [], facts: [{ ref: "new", description: "Earlier fixture result corrected", evidenceRefs: ["e"], supersedes: finding.factIds[0] }] }), usage);
    const board = store.snapshot(); expect(board.findings[0]!.cvss!.baseScore).toBe(7.5); expect(cvssIssues(board, board.findings[0]!)).toContain("sources_changed");
    const request: RunRequest = { id: "fixture", mode: "decide", snapshot: board, workspace: root, runDir: join(store.dataDir, "runs", "fixture"), blackboardPath: store.projectionPath, signal: new AbortController().signal, onEvent() {} };
    const context = projectContext(request); expect(context.findings[0]!.cvss!.baseScore).toBe(7.5); expect(context.findingContext!.items[0]!.cvssIssues).toContain("sources_changed");
    expect(JSON.parse(buildRunPrompt(request).userPrompt.split("\n").at(-1)!).scoring.calculatorFile).toBe(calculatorFile);
    expect(renderReport(board)).toContain("CVSS 3.1 Base: **7.5 HIGH**"); expect(renderReport(board)).toContain("sources_changed");
    expect(wikiRecord(board, { kind: "finding", id: finding.id })!.value).toMatchObject({ cvssIssues: ["sources_changed"] });
    store.beginRun("bad-review", "decide"); const before = store.snapshot();
    expect(() => store.applyDecision("bad-review", { summary: "Stale", cvssReviews: [{ findingId: finding.id, assessment: assessment(finding.factIds), reason: "Old evidence" }] }, usage)).toThrow(/superseded/);
    expect(store.snapshot()).toEqual(before);
  });

  it.each(["forged_score", "missing_reason", "unsupported_metric", "unattached_fact"])("rejects %s without any partial commit", kind => {
    const { store } = fixture(); const output = execution(); const cvss = output.findings![0]!.cvss!;
    if (kind === "forged_score") Object.assign(cvss, { baseScore: 10 });
    if (kind === "missing_reason") cvss.rationale.AV.reason = "";
    if (kind === "unsupported_metric") cvss.rationale.AV.factRefs = [];
    if (kind === "unattached_fact") { output.facts!.push({ ref: "other", description: "Unrelated fixture fact", evidenceRefs: ["e"] }); cvss.rationale.AV.factRefs = ["other"]; }
    const before = store.snapshot(); expect(() => store.applyExecution("initial", output, usage)).toThrow(); expect(store.snapshot()).toEqual(before);
  });

  it("seals scoring after same-batch attempts and invalidates review on subsequent Finding updates", () => {
    const { store } = fixture(); store.applyExecution("initial", execution({ attempts: [{ hypothesis: "fixture", scope: "fixture", identity: "a", stateVersion: "v1", baseline: "fixture baseline", changedVariable: "fixture value", outcome: "supports", observation: "local result", evidenceRefs: ["e"] }] }), usage);
    let board = store.snapshot(); expect(cvssIssues(board, board.findings[0]!)).toEqual(["awaiting_decide_review"]);
    store.beginRun("review", "decide"); store.applyDecision("review", { summary: "Review", cvssReviews: [{ findingId: board.findings[0]!.id, assessment: assessment(board.findings[0]!.factIds), reason: "Fixture" }] }, usage);
    begin(store, "update"); store.applyExecution("update", execution({ facts: [{ ref: "f", description: "New fixture fact", evidenceRefs: ["e"] }], findings: [{ ...execution().findings![0]!, cvss: undefined }] }), usage);
    board = store.snapshot(); expect(cvssIssues(board, board.findings[0]!)).toContain("awaiting_decide_review"); expect(cvssIssues(board, board.findings[0]!)).toContain("finding_changed");
  });
});
