import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import type { AttemptProposal, Decision, Execution, Usage } from "../src/types.js";
import type { ExecutionRefs } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
let sequence = 0;
const zero: Usage = { input: 0, output: 0, cost: 0 };
const usage: Usage = { input: 10, output: 5, cost: 0.01 };
const total: Usage = { input: 30, output: 12, cost: 0.025 };

function open(workspace?: string): BlackboardStore {
  const root = workspace ?? mkdtempSync(path.join(tmpdir(), "xloom-checkpoint-test-"));
  if (!workspace) roots.push(root);
  const store = new BlackboardStore(root, defaultConfig("Local fixture observations"));
  stores.push(store);
  return store;
}

function claim(store: BlackboardStore) {
  store.setStatus("running", "Fixture running");
  const number = ++sequence;
  const decisionId = `plan-${number}`;
  const runId = `execute-${number}`;
  store.beginRun(decisionId, "decide");
  const board = store.applyDecision(decisionId, { summary: "Plan", steps: [{ goalId: "G0", from: [], description: `Observe fixture ${number}`, successSignal: "Observation", evidencePlan: "Archive response", priority: 1 }] }, zero);
  const step = board.steps.find(item => item.status === "ready")!;
  store.beginRun(runId, "execute", step.id);
  const artifacts = path.join(store.dataDir, "runs", runId, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  return { runId, artifacts, step };
}

function output(artifacts: string, overrides: Partial<AttemptProposal> = {}, body = "fixture response at 2026-09-12T10:00:00Z"): Execution {
  writeFileSync(path.join(artifacts, "response.txt"), body);
  return {
    summary: "Fixture observation", result: "done",
    evidence: [{ ref: "e", path: "response.txt", description: "Original fixture response" }],
    facts: [{ ref: "f", description: "Fixture denies the tested account", evidenceRefs: ["e"] }],
    attempts: [{ hypothesis: "object-read", scope: "fixture:/object", identity: "account-A", stateVersion: "v1", baseline: "owner reads own fixture", changedVariable: "requester=account-A", outcome: "refutes", observation: "The fixture denies this condition", evidenceRefs: ["e"], ...overrides }],
  };
}

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable execution checkpoints", () => {
  it("persists cache counts once across checkpoints, failure and reopen alongside old usage", () => {
    const store = open();
    store.setStatus("running", "Historical usage fixture");
    store.beginRun("legacy-usage", "decide");
    store.applyDecision("legacy-usage", { summary: "Old usage has no cache breakdown" }, usage);
    const { runId, artifacts } = claim(store), result = output(artifacts);
    const first = { input: 100, output: 10, cost: 0.1, cacheRead: 60, cacheInput: 100 };
    const final = { input: 200, output: 20, cost: 0.2, cacheRead: 140, cacheInput: 200 };
    const checkpoint = store.applyExecutionCheckpoint(runId, "cache-first", result, first);
    expect(checkpoint.usage).toMatchObject({ input: 110, output: 15, cacheRead: 60, cacheInput: 100 });
    expect(store.applyExecutionCheckpoint(runId, "cache-first", result, first)).toEqual(checkpoint);
    expect(() => store.applyExecutionCheckpoint(runId, "cache-decreasing", result, { ...final, cacheRead: 50 })).toThrow(/cache usage must be cumulative/);
    expect(store.snapshot()).toEqual(checkpoint);
    store.applyExecutionCheckpoint(runId, "cache-final", result, final);
    // An interrupted call can return an older partial counter; never subtract a durable checkpoint.
    store.failRun(runId, "Synthetic interruption", first);
    const expected = store.snapshot().usage;
    expect(expected).toMatchObject({ input: 210, output: 25, cacheRead: 140, cacheInput: 200 });
    const root = store.workspace;
    store.close();
    expect(open(root).snapshot().usage).toEqual(expected);
  });

  it("returns durable alias mappings for deduplicated records and idempotent deliveries", () => {
    const store = open(), { runId, artifacts } = claim(store);
    const result = output(artifacts), first: Partial<ExecutionRefs> = {};
    const board = store.applyExecutionCheckpoint(runId, "first-refs", result, usage, first);
    expect(first).toEqual({ facts: { f: board.facts[0].id }, evidence: { e: board.evidence[0].id } });
    const renamed: Execution = { ...result, evidence: result.evidence!.map(e => ({ ...e, ref: "same-bytes" })),
      facts: result.facts!.map(f => ({ ...f, ref: "same-fact", evidenceRefs: ["same-bytes"] })), attempts: [] };
    const deduplicated: Partial<ExecutionRefs> = {};
    store.applyExecutionCheckpoint(runId, "second-refs", renamed, total, deduplicated);
    expect(deduplicated).toEqual({ facts: { "same-fact": board.facts[0].id }, evidence: { "same-bytes": board.evidence[0].id } });
    const replay: Partial<ExecutionRefs> = {};
    store.applyExecutionCheckpoint(runId, "first-refs", result, usage, replay);
    expect(replay).toEqual(first);
    expect(store.snapshot().facts).toHaveLength(1); expect(store.snapshot().evidence).toHaveLength(1);
    const rejected: Partial<ExecutionRefs> = {};
    expect(() => store.applyExecutionCheckpoint(runId, "invalid", { summary: "invalid", result: "done",
      facts: [{ ref: "bad", description: "Unsupported", evidenceRefs: ["missing"] }] }, total, rejected)).toThrow();
    expect(rejected).toEqual({});
    const final = store.applyExecution(runId, renamed, total);
    expect(final.facts).toEqual(board.facts);
    expect(final.evidence).toEqual(board.evidence);
  });

  it("commits observations while keeping the Step claimed, then counts final usage only once", () => {
    const store = open();
    const { runId, artifacts, step } = claim(store);
    const board = store.applyExecutionCheckpoint(runId, "first", output(artifacts), usage);
    expect(board).toMatchObject({ completedSteps: 0, usage, noProgressCount: 0, status: "running" });
    expect(board.steps.find(item => item.id === step.id)).toMatchObject({ status: "claimed", attempts: 1 });
    expect(board.facts).toHaveLength(1);
    expect(board.attempts).toHaveLength(1);
    expect(store.runs().find(run => run.id === runId)).toMatchObject({ status: "running", finishedAt: null });
    const final = store.applyExecution(runId, { summary: "Return to planning", result: "no_progress" }, total);
    expect(final).toMatchObject({ completedSteps: 1, usage: total, noProgressCount: 0 });
    expect(final.steps[0].status).toBe("done");
  });

  it("makes duplicate checkpoint delivery idempotent, including after completion", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const result = output(artifacts);
    const first = store.applyExecutionCheckpoint(runId, "first", result, usage);
    const events = store.events();
    expect(store.applyExecutionCheckpoint(runId, "first", result, usage)).toEqual(first);
    expect(store.events()).toEqual(events);
    const final = store.applyExecution(runId, { summary: "Finished", result: "done" }, total);
    expect(store.applyExecutionCheckpoint(runId, "first", result, usage)).toEqual(final);
    expect(store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
  });

  it("commits partial finding evidence lists using all referenced facts' provenance on the first checkpoint", () => {
    const store = open();
    const { runId, artifacts, step } = claim(store);
    const result = output(artifacts);
    writeFileSync(path.join(artifacts, "repeat.txt"), "independent repeated fixture observation");
    writeFileSync(path.join(artifacts, "baseline.txt"), "a different fixture baseline");
    result.evidence!.push(
      { ref: "repeat", path: "repeat.txt", description: "Repeat backing the first fact" },
      { ref: "baseline", path: "baseline.txt", description: "Baseline backing the second fact" },
    );
    result.facts![0].evidenceRefs = ["e", "repeat"];
    result.facts!.push({ ref: "second-f", description: "Second fixture observation", evidenceRefs: ["e", "baseline"] });
    result.findings = [
      { key: "first-fixture", title: "First fixture lead", target: "fixture one", status: "lead", factRefs: ["f"], evidenceRefs: ["e"], next: "Review repeated observation" },
      { key: "second-fixture", title: "Second fixture lead", target: "fixture two", status: "lead", factRefs: ["second-f"], evidenceRefs: ["e"], next: "Review baseline difference" },
    ];
    const board = store.applyExecutionCheckpoint(runId, "partial-evidence-lists", result, usage);
    expect(board).toMatchObject({ usage, completedSteps: 0 });
    expect(board.steps.find(item => item.id === step.id)?.status).toBe("claimed");
    expect(board.findings.map(finding => finding.evidenceIds)).toEqual(board.facts.map(fact => fact.evidenceIds));
    expect(board.findings.map(finding => finding.evidenceIds.length)).toEqual([2, 2]);
    expect(store.applyExecutionCheckpoint(runId, "partial-evidence-lists", result, usage)).toEqual(board);
    const final = store.applyExecution(runId, { summary: "All observations already committed", result: "done" }, total);
    expect(final.findings).toEqual(board.findings);
    expect(final.usage).toEqual(total);
    expect(store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
  });

  it("rejects reuse of a checkpoint ID for different content without changing authority", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const result = output(artifacts);
    const first = store.applyExecutionCheckpoint(runId, "first", result, usage);
    expect(() => store.applyExecutionCheckpoint(runId, "first", { ...result, summary: "Changed" }, total)).toThrow(/different content/);
    expect(store.snapshot()).toEqual(first);
  });

  it("rolls back records, usage, audit event and checkpoint identity when validation fails", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const result = output(artifacts);
    const before = store.snapshot();
    const events = store.events();
    expect(() => store.applyExecutionCheckpoint(runId, "first", { ...result, attempts: [{ ...result.attempts![0], evidenceRefs: ["unknown"] }] }, usage)).toThrow(/Unknown evidence/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.applyExecutionCheckpoint(runId, "first", result, usage)).toMatchObject({ usage, completedSteps: 0 });
  });

  it("retains checkpointed evidence and charges only remaining usage after failure", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const first = store.applyExecutionCheckpoint(runId, "first", output(artifacts), usage);
    const failed = store.failRun(runId, "Provider disconnected", total);
    expect(failed).toMatchObject({ usage: total, completedSteps: 0, status: "error" });
    expect(failed.steps[0].status).toBe("failed");
    expect(failed.facts).toEqual(first.facts);
    expect(failed.attempts).toEqual(first.attempts);
    expect(() => store.verifyEvidence(failed.evidence[0])).not.toThrow();
  });

  it("keeps a partial handoff blocked even when its checkpoint made real progress", () => {
    const store = open(); const { runId, artifacts } = claim(store);
    store.applyExecutionCheckpoint(runId, "first", output(artifacts), usage);
    const board = store.applyExecution(runId, { summary: "Partial work handed to Decide; Step success remains unverified", result: "blocked" }, total);
    expect(board).toMatchObject({ completedSteps: 1, noProgressCount: 0, usage: total, outcome: null });
    expect(board.steps[0].status).toBe("blocked");
    expect(board.goals[0].status).toBe("active");
  });

  it("preserves known usage when a cancellation cannot report later token counts", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    store.applyExecutionCheckpoint(runId, "first", output(artifacts), usage);
    expect(store.failRun(runId, "Cancelled", zero, true)).toMatchObject({ usage, status: "paused" });
  });

  it("requires nondecreasing cumulative checkpoint usage", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const result = output(artifacts);
    const first = store.applyExecutionCheckpoint(runId, "first", result, usage);
    expect(() => store.applyExecutionCheckpoint(runId, "second", result, zero)).toThrow(/cumulative and nondecreasing/);
    expect(store.snapshot()).toEqual(first);
    const second = store.applyExecutionCheckpoint(runId, "second", result, total);
    expect(second).toMatchObject({ usage: total, completedSteps: 0 });
    expect(second.facts).toHaveLength(1);
    expect(second.attempts).toHaveLength(1);
  });

  it("preserves checkpointed work across process recovery without replaying the Step", () => {
    const store = open();
    const { runId, artifacts } = claim(store);
    const first = store.applyExecutionCheckpoint(runId, "first", output(artifacts), usage);
    store.close();
    const recovered = open(store.workspace);
    const board = recovered.snapshot();
    expect(board).toMatchObject({ usage, status: "paused", completedSteps: 0 });
    expect(board.facts).toEqual(first.facts);
    expect(board.attempts).toEqual(first.attempts);
    expect(board.steps[0].status).toBe("failed");
    expect(recovered.runs().find(run => run.id === runId)?.status).toBe("interrupted");
  });

  it("rejects checkpoint commits on a decision channel", () => {
    const store = open();
    store.setStatus("running", "Plan");
    store.beginRun("planning", "decide");
    expect(() => store.applyExecutionCheckpoint("planning", "first", { summary: "Invalid", result: "done" }, usage)).toThrow(/Wrong run channel/);
    expect(store.snapshot().usage).toEqual(zero);
  });
});

describe("conditional research progress", () => {
  it("retains timestamped evidence and paraphrased facts without crediting a repeated outcome", () => {
    const store = open();
    const first = claim(store);
    store.applyExecution(first.runId, output(first.artifacts), usage);
    const second = claim(store);
    const repeated = output(second.artifacts, { observation: "Different wording: the same condition still fails" }, "fixture response at 2026-09-12T10:01:00Z");
    repeated.facts![0].description = "An account-A request was rejected by the fixture";
    const board = store.applyExecution(second.runId, repeated, usage);
    expect(board.noProgressCount).toBe(1);
    expect(board.steps.at(-1)?.status).toBe("no_progress");
    expect(board.evidence).toHaveLength(2);
    expect(board.facts).toHaveLength(2);
    expect(board.attempts).toHaveLength(2);
    expect(board.attempts!.map(item => item.observation)).toContain("Different wording: the same condition still fails");
    expect(board.attempts!.map(item => item.evidenceIds.length)).toEqual([1, 1]);
    expect(readFileSync(store.projectionPath, "utf8")).toContain("Conditional attempts");
  });

  it.each([
    { identity: "account-B" }, { stateVersion: "v2" }, { scope: "fixture:/other" },
    { baseline: "owner has changed object" }, { changedVariable: "requester=account-B" },
    { hypothesis: "different-object-read" }, { scope: "fixture:/Object" }, { identity: "account-a" },
  ])("allows a new outcome after actual test conditions change: %j", (conditions) => {
    const store = open();
    const first = claim(store);
    store.applyExecution(first.runId, output(first.artifacts), usage);
    const second = claim(store);
    const board = store.applyExecution(second.runId, output(second.artifacts, conditions), usage);
    expect(board.noProgressCount).toBe(0);
    expect(board.attempts).toHaveLength(2);
    expect(board.steps.at(-1)?.status).toBe("done");
  });

  it("records contrary evidence under the same conditions as new research progress", () => {
    const store = open();
    const first = claim(store);
    store.applyExecution(first.runId, output(first.artifacts), usage);
    const second = claim(store);
    const board = store.applyExecution(second.runId, output(second.artifacts, { outcome: "supports", observation: "Fixture now returns content" }, "fixture content returned"), usage);
    expect(board.noProgressCount).toBe(0);
    expect(new Set(board.attempts!.map(item => item.conditionKey)).size).toBe(1);
    expect(new Set(board.attempts!.map(item => item.outcomeKey)).size).toBe(2);
  });

  it.each(["inconclusive", "blocked"] as const)("does not count a new %s record alone as meaningful progress", outcome => {
    const store = open();
    const current = claim(store);
    const board = store.applyExecution(current.runId, output(current.artifacts, { outcome }), usage);
    expect(board.noProgressCount).toBe(1);
    expect(board.attempts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
  });

  it("rejects altered archived evidence backing a new attempt", () => {
    const store = open();
    const first = claim(store);
    const board = store.applyExecution(first.runId, output(first.artifacts), usage);
    const second = claim(store);
    writeFileSync(path.join(store.dataDir, board.evidence[0].path), "tampered archive");
    const before = store.snapshot();
    expect(() => store.applyExecution(second.runId, { summary: "Reuse", result: "done", attempts: [{ ...output(second.artifacts).attempts![0], identity: "account-B", evidenceRefs: [board.evidence[0].id] }] }, usage)).toThrow(/Evidence changed/);
    expect(store.snapshot()).toEqual(before);
  });

  it("keeps legacy evidence-only outputs without resetting stagnation", () => {
    const store = open();
    const current = claim(store);
    const result = output(current.artifacts);
    const board = store.applyExecution(current.runId, { summary: "Raw artifact", result: "done", evidence: result.evidence }, usage);
    expect(board.evidence).toHaveLength(1);
    expect(board.noProgressCount).toBe(1);
  });

  it("archives unsupported leads without treating speculation as research progress", () => {
    const store = open(); const current = claim(store);
    const board = store.applyExecution(current.runId, { summary: "Untested idea", result: "done", findings: [{ key: "new-idea", title: "Unverified lead", target: "fixture", status: "lead", factRefs: [], evidenceRefs: [], next: "Run controlled fixture test" }] }, usage);
    expect(board.findings).toHaveLength(1);
    expect(board.noProgressCount).toBe(1);
  });

  it("does not credit a legacy Fact with the same description merely because evidence bytes changed", () => {
    const store = open();
    const first = claim(store);
    const one = output(first.artifacts); delete one.attempts;
    store.applyExecution(first.runId, one, usage);
    const second = claim(store);
    const two = output(second.artifacts, {}, "fixture response with a different timestamp"); delete two.attempts;
    const board = store.applyExecution(second.runId, two, usage);
    expect(board.facts).toHaveLength(2);
    expect(board.evidence).toHaveLength(2);
    expect(board.noProgressCount).toBe(1);
  });
});

describe("combination prerequisites", () => {
  function fixture() {
    const store = open(); const current = claim(store);
    const result = output(current.artifacts);
    result.facts!.push(
      { ref: "f2", description: "A second prerequisite", evidenceRefs: ["e"] },
      { ref: "f3", description: "A third prerequisite", evidenceRefs: ["e"] },
      { ref: "counter", description: "A contrary observation", evidenceRefs: ["e"] },
    );
    const board = store.applyExecution(current.runId, result, usage);
    return { store, facts: board.facts.map(fact => fact.id) };
  }

  function decision(from: string[], requires: string[], counterEvidence: string[] = []): Decision {
    return { summary: "Combine existing capabilities", steps: [{
      goalId: "G0", from, description: "Combine fixture observations", priority: 10, successSignal: "Combined capability confirmed", evidencePlan: "Store combined observation",
      combination: { requires, missing: ["Second account session"], scope: "fixture", stateVersion: "v1", expectedCapability: "Read fixture using both prerequisites", counterEvidence },
    }] };
  }

  function combinationPlan(store: BlackboardStore, changes: Record<string, unknown> = {}) {
    const fact = store.snapshot().facts[0];
    const runId = `combination-${++sequence}`;
    store.beginRun(runId, "decide");
    return store.applyDecision(runId, { summary: "Combine existing capabilities", steps: [{
      goalId: "G0", from: [fact.id], description: "Combine fixture observations", priority: 10, successSignal: "Combined capability confirmed", evidencePlan: "Store combined observation",
      combination: { requires: [fact.id], missing: ["Second account session"], scope: "fixture", stateVersion: "v1", expectedCapability: "Read fixture using both prerequisites", ...changes },
    }] }, zero);
  }

  it("retains explicit prerequisites and allows the same plan to reopen when state changes", () => {
    const store = open(); const current = claim(store);
    store.applyExecution(current.runId, output(current.artifacts), usage);
    const first = combinationPlan(store);
    expect(first.steps.at(-1)?.combination?.requires).toEqual([first.facts[0].id]);
    expect(combinationPlan(store).steps).toHaveLength(2);
    expect(combinationPlan(store, { stateVersion: "v2" }).steps).toHaveLength(3);
  });

  it.each(["from", "requires", "counterEvidence"] as const)("atomically rejects an unknown %s reference before completing the decision", field => {
    const { store, facts } = fixture();
    const input = decision([facts[0]], [facts[1]], [facts[3]]);
    const invalid = structuredClone(input.steps![0]);
    invalid.description = "Invalid second proposal";
    if (field === "from") invalid.from.push("unknown");
    else invalid.combination![field]!.push("unknown");
    input.steps!.push(invalid);
    const original = structuredClone(input);
    const runId = `combination-${++sequence}`;
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const events = store.events();
    const runs = store.runs();
    expect(() => store.applyDecision(runId, input, usage)).toThrow(/Unknown fact/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.runs()).toEqual(runs);
    expect(input).toEqual(original);
  });

  it("persists omitted known requirements as causal inputs and audit data without altering the model output", () => {
    const { store, facts } = fixture();
    const input = decision([facts[0]], [facts[1]], [facts[3]]);
    const original = structuredClone(input);
    const runId = `combination-${++sequence}`;
    store.beginRun(runId, "decide");
    const board = store.applyDecision(runId, input, usage);
    expect(board.steps.at(-1)?.from).toEqual([facts[0], facts[1]]);
    expect(board.steps.at(-1)?.combination).toEqual(input.steps![0].combination);
    expect(board.steps.at(-1)?.from).not.toContain(facts[3]);
    const audit = JSON.parse(store.events().at(-1)!.payload);
    expect(audit.decision.steps[0].from).toEqual([facts[0], facts[1]]);
    expect(audit.decision.steps[0].combination).toEqual(input.steps![0].combination);
    expect(input).toEqual(original);
  });

  it.each([
    { from: [1, 1, 0], requires: [2, 1, 2, 0], expected: [1, 0, 2] },
    { from: [1, 0, 1, 2, 0], requires: [2, 0], expected: [1, 0, 2] },
    { from: [], requires: [2, 0, 2, 1], expected: [2, 0, 1] },
  ])("preserves first occurrence order and removes duplicate causal inputs: %j", ({ from, requires, expected }) => {
    const { store, facts } = fixture();
    const input = decision(from.map(index => facts[index]), requires.map(index => facts[index]));
    const runId = `combination-${++sequence}`;
    store.beginRun(runId, "decide");
    const board = store.applyDecision(runId, input, zero);
    expect(board.steps.at(-1)?.from).toEqual(expected.map(index => facts[index]));
  });

  it.each([true, false])("deduplicates equivalent plans after normalizing omitted requirements (explicit first: %s)", explicitFirst => {
    const { store, facts } = fixture();
    const explicit = decision([facts[0], facts[1]], [facts[0], facts[1]]);
    const omitted = decision([facts[0]], [facts[0], facts[1]]);
    const inputs = explicitFirst ? [explicit, omitted] : [omitted, explicit];
    let plannedId: string | undefined;
    for (const input of inputs) {
      const runId = `combination-${++sequence}`;
      store.beginRun(runId, "decide");
      const board = store.applyDecision(runId, input, zero);
      expect(board.steps).toHaveLength(2);
      expect(board.steps.at(-1)?.from).toEqual([facts[0], facts[1]]);
      if (plannedId) expect(board.steps.at(-1)?.id).toBe(plannedId);
      plannedId = board.steps.at(-1)?.id;
    }
  });
});
