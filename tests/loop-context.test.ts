import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { pendingStepReviews, projectContext, type BlackboardContext, type ContextProjector } from "../src/loop/context.js";
import type { Attempt, BoardSnapshot, Evidence, Fact, Finding, Goal, RunRequest, Step } from "../src/types.js";

const goal = (id: string, parentId: string | null = "G0", factIds: string[] = []): Goal => ({ id, parentId, factIds, description: id, status: "active" });
const step = (id: string, status: Step["status"] = "done", from: string[] = [], goalId = "G0"): Step => ({
  id, goalId, from, description: id, successSignal: "observable result", evidencePlan: "save comparison", priority: 1,
  status, attempts: 1, runId: `PRIVATE_RUN_${id}`, leaseUntil: 987654321,
});
const fact = (id: string, stepId: string | null = null, evidenceIds: string[] = [], supersedes?: string): Fact => ({ id, stepId, evidenceIds, description: id, ...(supersedes ? { supersedes } : {}) });
const evidence = (id: string, stepId: string, excerpt?: string): Evidence => ({ id, stepId, path: `state/evidence/${id}.txt`, sha256: "a".repeat(64), bytes: 50, description: id, runId: `PRIVATE_RUN_${id}`, ...(excerpt === undefined ? {} : { excerpt }) });
const finding = (id: string, factIds: string[] = [], evidenceIds: string[] = [], status: Finding["status"] = "lead"): Finding => ({
  id, factIds, evidenceIds, status, key: id, target: "fixture boundary", title: id, rating: "unrated", next: "change identity",
});

function request(mode: RunRequest["mode"] = "decide"): RunRequest {
  const snapshot: BoardSnapshot = {
    revision: 42, config: defaultConfig("Verify fixture boundary"), status: "running", outcome: null, reason: "",
    goals: [goal("G0", null)], steps: [], facts: [], evidence: [], findings: [], hints: [],
    usage: { input: 900, output: 90, cost: 0.9 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
  };
  return { id: "PRIVATE_CURRENT_RUN", mode, snapshot, workspace: "D:/fixture", runDir: "D:/fixture/private-run", signal: new AbortController().signal, onEvent() {} };
}

function ids(records: { id: string }[]): string[] { return records.map(item => item.id); }

function attempt(id: string, patch: Partial<Attempt> = {}): Attempt {
  return { id, stepId: "OLD", hypothesis: "join early capabilities", scope: "tenant A", identity: "alice", stateVersion: "v1",
    baseline: "normal result", changedVariable: "object", outcome: "refutes", observation: "boundary held",
    evidenceIds: [], conditionKey: "PRIVATE_CONDITION_KEY", outcomeKey: "PRIVATE_OUTCOME_KEY", runId: "PRIVATE_ATTEMPT_RUN", ...patch };
}

function assertReferences(context: BlackboardContext): void {
  const goals = new Set(ids(context.goals));
  const facts = new Set(ids(context.facts));
  const steps = new Set([...ids(context.steps), ...ids(context.stepOrigins)]);
  const evidence = new Set(ids(context.evidence));
  for (const goal of context.goals) {
    if (goal.parentId !== null) expect(goals.has(goal.parentId)).toBe(true);
    for (const id of goal.factIds) expect(facts.has(id)).toBe(true);
  }
  for (const step of context.steps) {
    expect(goals.has(step.goalId)).toBe(true);
    for (const id of step.from) expect(facts.has(id)).toBe(true);
  }
  for (const origin of context.stepOrigins) {
    for (const id of [...origin.from, ...(origin.combination?.requires ?? []), ...(origin.combination?.counterEvidence ?? [])]) expect(facts.has(id)).toBe(true);
  }
  for (const fact of context.facts) {
    if (fact.stepId !== null) expect(steps.has(fact.stepId)).toBe(true);
    if (fact.supersedes) expect(facts.has(fact.supersedes)).toBe(true);
    for (const id of fact.evidenceIds) expect(evidence.has(id)).toBe(true);
  }
  for (const finding of context.findings) {
    for (const id of finding.factIds) expect(facts.has(id)).toBe(true);
    for (const id of finding.evidenceIds) expect(evidence.has(id)).toBe(true);
    if (finding.pocEvidenceId) expect(evidence.has(finding.pocEvidenceId)).toBe(true);
  }
  for (const item of context.evidence) expect(steps.has(item.stepId)).toBe(true);
  expect(context.projection.unavailableReferences).toEqual({ goals: [], facts: [], steps: [], evidence: [] });
}

describe("role-specific blackboard context", () => {
  it.each(["decide", "execute", "metacog"] as const)("labels %s planning memory as unverified and bounds it independently of status", mode => {
    const input = request(mode);
    input.snapshot.reason = "Starting a fresh planning context";
    input.snapshot.planningMemory = { runId: "PRIVATE_RUN_MEMORY", mode: "decide", revision: 4, summary: "x".repeat(8000), truncated: false };
    const context = projectContext(input);
    expect(context.planningMemory).toMatchObject({ summary: "x".repeat(4000), truncated: true, evidenceStatus: "unverified" });
    expect(context.planningMemory!.notice).toContain("not verified evidence or Goal completion");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_RUN_MEMORY");
    expect(context.facts).toEqual([]);
    expect(context.reason).toBe(input.snapshot.reason);
    expect(input.snapshot.planningMemory.summary).toHaveLength(8000);
    delete input.snapshot.planningMemory;
    expect(projectContext(input).planningMemory).toBeUndefined();
  });
  it.each(["decide", "execute", "metacog"] as const)("keeps %s projection guidance compact without losing evidence and recovery boundaries", mode => {
    const context = projectContext(request(mode));
    const guidance = context.projection.notice;
    // This fixed text accompanies every research call; avoid restoring the
    // previous 2,150-character explanation alongside the role protocol.
    expect(guidance.length).toBeLessThanOrEqual(1_250);
    for (const required of [
      "Omission is not negative evidence", "counts give no contents", "dependencies may exceed a fixed context budget",
      "stepOrigins: causal inputs/conditions, not executable plans", "history pages cover all Facts/attempts",
      "available means no recorded replacement, not current validity", "Summaries/excerpts may be truncated and references unexpanded",
      "inspect full evidence", "schedule Execute from indexed Facts", "Superseded Facts are historical; read replacements",
      "superseded direct/causal inputs", "recheck scope/identity/state and abandon/replan",
      "attempts apply only to recorded scope/identity/state/baseline/changedVariable",
      "Combination requires must hold together in the same scope/state", "missing conditions are unverified",
      "recovery.artifacts files may be absent", "not committed Evidence or Facts", "Inspect before retrying",
      "in old runs read only artifacts, never sibling logs/transcripts/chats", "recovery evidence in this run's artifacts",
      "unavailableReferences are missing records, never verified facts",
    ]) expect(guidance).toContain(required);
  });

  it.each(["decide", "metacog"] as const)("keeps the entire active frontier for %s beyond tail limits", mode => {
    const input = request(mode);
    for (let i = 0; i < 30; i++) {
      input.snapshot.goals.push(goal(`G${i + 1}`));
      input.snapshot.steps.push(step(`S${i}`, i % 2 ? "ready" : "claimed", [`F${i}`], `G${i + 1}`));
      input.snapshot.facts.push(fact(`F${i}`, `S${i}`, [`E${i}`]));
      input.snapshot.evidence.push(evidence(`E${i}`, `S${i}`));
      input.snapshot.findings.push(finding(`V${i}`, [`F${i}`], [`E${i}`], i % 2 ? "technical_hit" : "lead"));
      input.snapshot.hints.push({ id: `H${i}`, content: `hint ${i}`, createdAt: "2026-09-12" });
    }
    const context = projectContext(input);
    expect(context.goals).toHaveLength(31);
    expect(context.steps).toHaveLength(30);
    expect(context.findings).toHaveLength(30);
    expect(context.hints).toHaveLength(30);
    expect(context.projection.omitted).toEqual({ goals: 0, facts: 0, steps: 0, findings: 0, evidence: 0, hints: 0 });
    assertReferences(context);
  });

  it("bounds irrelevant terminal history while keeping a compact discovery index of old isolated clues", () => {
    const input = request();
    for (let i = 0; i < 100; i++) {
      input.snapshot.steps.push(step(`S${i}`, "done"));
      input.snapshot.facts.push(fact(`F${i}`, `S${i}`, [`E${i}`]));
      input.snapshot.evidence.push(evidence(`E${i}`, `S${i}`));
      input.snapshot.findings.push(finding(`V${i}`, [], [], "closed"));
    }
    const context = projectContext(input);
    expect(context.steps).toHaveLength(8);
    expect(context.facts).toHaveLength(12);
    expect(context.findings).toHaveLength(8);
    expect(context.evidence).toHaveLength(12);
    expect(context.stepOrigins).toEqual([88, 89, 90, 91].map(i => ({ id: `S${i}`, description: `S${i}`, status: "done", from: [] })));
    expect(context.factIndex).toHaveLength(100);
    expect(context.factIndex[0]).toEqual({ id: "F0", summary: "F0", stepId: "S0", evidenceIds: ["E0"], replacedBy: [], status: "available" });
    expect(context.projection.omitted).toEqual({ goals: 0, facts: 88, steps: 92, findings: 92, evidence: 88, hints: 0 });
    expect(context.projection.notice).toContain("Omission is not negative evidence");
    expect(context.projection.notice).toContain("may exceed a fixed context budget");
    expect(context.projection.notice).toContain("schedule Execute");
    assertReferences(context);
  });

  it("recovers two distant indexed clues and their causal chains when assigned for combination", () => {
    const input = request();
    input.snapshot.steps.push(step("BASE_A"), step("BASE_B"), step("DERIVE_A", "done", ["A0"]), step("DERIVE_B", "done", ["B0"]));
    input.snapshot.facts.push(fact("A0", "BASE_A", ["EA0"]), fact("B0", "BASE_B", ["EB0"]),
      { ...fact("A1", "DERIVE_A", ["EA1"]), description: "early capability ".repeat(100) }, fact("B1", "DERIVE_B", ["EB1"]));
    input.snapshot.evidence.push(evidence("EA0", "BASE_A"), evidence("EB0", "BASE_B"), evidence("EA1", "DERIVE_A"), evidence("EB1", "DERIVE_B"));
    for (let i = 0; i < 40; i++) {
      input.snapshot.steps.push(step(`NOISE_S${i}`));
      input.snapshot.facts.push(fact(`NOISE_F${i}`, `NOISE_S${i}`, [`NOISE_E${i}`]));
      input.snapshot.evidence.push(evidence(`NOISE_E${i}`, `NOISE_S${i}`, "unrelated raw response"));
    }
    const decide = projectContext(input);
    expect(ids(decide.facts)).not.toContain("A1");
    expect(decide.factIndex.find(item => item.id === "A1")?.summary).toHaveLength(241);
    expect(decide.factIndex.find(item => item.id === "B1")).toBeDefined();
    input.mode = "execute";
    input.step = { ...step("COMBINE", "claimed", ["A1", "B1"]), combination: {
      requires: ["A1", "B1"], missing: ["same account can use both capabilities"], scope: "tenant A / account alice",
      stateVersion: "fixture-v3", expectedCapability: "complete combined fixture path", counterEvidence: ["B0"],
    } };
    const execute = projectContext(input);
    expect(ids(execute.facts)).toEqual(["A0", "B0", "A1", "B1"]);
    expect(ids(execute.evidence)).toEqual(["EA0", "EB0", "EA1", "EB1"]);
    expect(execute.steps[0]!.combination).toEqual(input.step.combination);
    expect(execute.stepOrigins.find(item => item.id === "DERIVE_A")?.from).toEqual(["A0"]);
    expect(JSON.stringify(execute)).not.toContain("unrelated raw response");
    assertReferences(execute);
  });

  it("retains deep causal ancestors iteratively and terminates source-Step cycles", () => {
    const input = request("execute");
    for (let i = 0; i < 5_000; i++) {
      input.snapshot.steps.push(step(`S${i}`, "done", i ? [`F${i - 1}`] : ["F1"]));
      input.snapshot.facts.push(fact(`F${i}`, `S${i}`, [`E${i}`]));
      input.snapshot.evidence.push(evidence(`E${i}`, `S${i}`));
    }
    input.step = step("CURRENT", "claimed", ["F4999"]);
    const context = projectContext(input);
    expect(context.facts).toHaveLength(5_000);
    expect(context.evidence).toHaveLength(5_000);
    expect(context.stepOrigins).toHaveLength(5_000);
    expect(context.steps).toHaveLength(1);
    assertReferences(context);
  });

  it("retains old evidence attached to root/child goals and verified findings needed by completion review", () => {
    const input = request("metacog");
    input.snapshot.goals[0]!.factIds = ["ROOT_PROOF"];
    input.snapshot.goals.push({ ...goal("G1", "G0", ["CHILD_PROOF"]), status: "satisfied" });
    input.snapshot.steps = [step("OLD")];
    input.snapshot.facts = [fact("ROOT_PROOF", "OLD", ["ROOT_E"]), fact("CHILD_PROOF", "OLD", ["CHILD_E"]), fact("FINDING_PROOF", "OLD", ["FINDING_E"])];
    input.snapshot.evidence = [evidence("ROOT_E", "OLD"), evidence("CHILD_E", "OLD"), evidence("FINDING_E", "OLD"), evidence("POC", "OLD")];
    input.snapshot.findings = [{ ...finding("verified", ["FINDING_PROOF"], ["FINDING_E"], "impact_verified"), rating: "P3", pocEvidenceId: "POC" }];
    for (let i = 0; i < 20; i++) {
      input.snapshot.steps.push(step(`RECENT${i}`));
      input.snapshot.facts.push(fact(`RECENT${i}`));
      input.snapshot.evidence.push(evidence(`RECENT${i}`, `RECENT${i}`));
    }
    const context = projectContext(input);
    expect(ids(context.facts)).toEqual(expect.arrayContaining(["ROOT_PROOF", "CHILD_PROOF", "FINDING_PROOF"]));
    expect(ids(context.evidence)).toEqual(expect.arrayContaining(["ROOT_E", "CHILD_E", "FINDING_E", "POC"]));
    expect(ids(context.findings)).toContain("verified");
    expect(ids(context.stepOrigins)).toContain("OLD");
    assertReferences(context);
  });

  it("projects Execute's assignment, ancestor chain, related findings, and all their dependencies without unrelated branches", () => {
    const input = request("execute");
    input.snapshot.goals.push(goal("G1"), goal("G2", "G1"), goal("UNRELATED"));
    const current = step("CURRENT", "claimed", ["CURRENT_FACT"], "G2");
    input.step = current;
    input.snapshot.steps = [step("OLD"), current, step("OTHER", "ready", ["OTHER_FACT"], "UNRELATED")];
    input.snapshot.facts = [fact("CURRENT_FACT", "OLD", ["CURRENT_E"]), fact("RELATED_FACT", "OLD", ["RELATED_E"]), fact("OTHER_FACT", "OTHER", ["OTHER_E"])];
    input.snapshot.evidence = [evidence("CURRENT_E", "OLD"), evidence("RELATED_E", "OLD"), evidence("OTHER_E", "OTHER"), evidence("POC", "OLD")];
    input.snapshot.findings = [{ ...finding("MATCH", ["CURRENT_FACT", "RELATED_FACT"], ["CURRENT_E", "RELATED_E"]), pocEvidenceId: "POC" }, finding("OTHER", ["OTHER_FACT"], ["OTHER_E"])];
    input.snapshot.hints.push({ id: "H", content: "user correction", createdAt: "now" });
    const context = projectContext(input);
    expect(ids(context.goals)).toEqual(["G0", "G1", "G2"]);
    expect(ids(context.steps)).toEqual(["CURRENT"]);
    expect(ids(context.facts)).toEqual(["CURRENT_FACT", "RELATED_FACT"]);
    expect(ids(context.findings)).toEqual(["MATCH"]);
    expect(ids(context.evidence)).toEqual(["CURRENT_E", "RELATED_E", "POC"]);
    expect(context.hints).toHaveLength(1);
    expect(context.projection.omitted).toEqual({ goals: 1, facts: 1, steps: 2, findings: 1, evidence: 1, hints: 0 });
    assertReferences(context);
  });

  it.each(["F0", "F1", "F2"])("retains old/new supersession chains when Execute starts from %s", selected => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", [selected]);
    input.snapshot.steps = [step("OLD"), input.step];
    input.snapshot.facts = [fact("F0", "OLD", ["E0"]), fact("F1", "OLD", ["E1"], "F0"), fact("F2", "OLD", ["E2"], "F1"), fact("BRANCH", "OLD", ["EB"], "F0")];
    input.snapshot.evidence = ["E0", "E1", "E2", "EB"].map(id => evidence(id, "OLD"));
    const context = projectContext(input);
    expect(ids(context.facts)).toEqual(["F0", "F1", "F2", "BRANCH"]);
    expect(context.evidence).toHaveLength(4);
    expect(context.projection.notice).toContain("Superseded Facts are historical");
    assertReferences(context);
  });

  it("retains findings connected by assigned-Step artifacts even when no input Facts exist", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed");
    input.snapshot.steps = [input.step];
    input.snapshot.evidence = [evidence("OWN", "CURRENT")];
    input.snapshot.findings = [finding("V", [], ["OWN"])];
    const context = projectContext(input);
    expect(ids(context.findings)).toEqual(["V"]);
    assertReferences(context);
  });

  it("selects directly related Execute findings independently of their insertion order", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", ["CURRENT_FACT"]);
    input.snapshot.steps = [input.step];
    input.snapshot.facts = [fact("CURRENT_FACT"), fact("LINKED_FACT"), fact("UNRELATED_FACT")];
    input.snapshot.findings = [finding("DIRECT", ["CURRENT_FACT", "LINKED_FACT"]), finding("INDIRECT", ["LINKED_FACT", "UNRELATED_FACT"])];
    const first = projectContext(input);
    input.snapshot.findings.reverse();
    const reversed = projectContext(input);
    expect(ids(first.findings)).toEqual(["DIRECT"]);
    expect(ids(reversed.findings)).toEqual(["DIRECT"]);
    expect(ids(first.facts)).toEqual(["CURRENT_FACT", "LINKED_FACT"]);
    expect(ids(reversed.facts)).toEqual(ids(first.facts));
    assertReferences(first);
    assertReferences(reversed);
  });

  it("caps excerpts explicitly without dropping required evidence identities or paths", () => {
    const input = request();
    input.snapshot.steps = [step("S")];
    input.snapshot.evidence = [evidence("LONG", "S", "x".repeat(10_000)), evidence("SHORT", "S", "exact comparison")];
    const context = projectContext(input);
    expect(context.evidence[0]!.excerpt).toHaveLength(2_000 + "\n[excerpt truncated; inspect referenced artifact]".length);
    expect(context.evidence[0]!.path).toBe("state/evidence/LONG.txt");
    expect(context.evidence[1]!.excerpt).toBe("exact comparison");
    expect(context.projection.truncatedExcerpts).toBe(1);
    expect(input.snapshot.evidence[0]!.excerpt).toHaveLength(10_000);
  });

  it.each(["decide", "execute", "metacog"] as const)("allowlists every nested record and detaches returned values in %s", mode => {
    const input = request(mode);
    const privateFields = { messages: ["SECRET_CHAT"], apiKey: "SECRET_KEY", runtime: "SECRET_RUNTIME" };
    input.snapshot.steps = [{ ...step("S", "claimed"), combination: { requires: [], missing: ["authorization"], scope: "account alice", stateVersion: "v1", expectedCapability: "capability", counterEvidence: [] } }];
    input.snapshot.facts = [fact("F", "S", ["E"])];
    input.snapshot.goals[0]!.factIds = ["F"];
    input.snapshot.evidence = [evidence("E", "S", "public evidence")];
    input.snapshot.findings = [{ ...finding("V", ["F"], ["E"]), impact: { capability: "read", object: "fixture", result: "observed", scope: "one", prerequisites: "account" } }];
    input.snapshot.hints = [{ id: "H", content: "public", createdAt: "now" }];
    input.snapshot.attempts = [attempt("A", { stepId: "S", evidenceIds: ["E"] })];
    Object.assign(input.snapshot, privateFields);
    Object.assign(input.snapshot.config, privateFields);
    Object.assign(input.snapshot.findings[0]!.impact!, privateFields);
    Object.assign(input.snapshot.steps[0]!.combination!, privateFields);
    for (const list of [input.snapshot.goals, input.snapshot.steps, input.snapshot.facts, input.snapshot.evidence, input.snapshot.findings, input.snapshot.hints, input.snapshot.attempts]) {
      for (const record of list) Object.assign(record, privateFields);
    }
    if (mode === "execute") input.step = input.snapshot.steps[0];
    const before = JSON.stringify(input.snapshot);
    const projector: ContextProjector = projectContext;
    const context = projector(input);
    const serialized = JSON.stringify(context);
    for (const secret of ["SECRET_CHAT", "SECRET_KEY", "SECRET_RUNTIME", "PRIVATE_RUN", "PRIVATE_ATTEMPT", "PRIVATE_CONDITION", "PRIVATE_OUTCOME", "987654321", "models", "apiKey", "leaseUntil", "runId"]) expect(serialized).not.toContain(secret);
    context.goals[0]!.factIds.push("mutation");
    context.facts[0]!.evidenceIds.push("mutation");
    context.findings[0]!.impact!.capability = "mutation";
    context.steps[0]!.from.push("mutation");
    context.steps[0]!.combination!.requires.push("mutation");
    context.steps[0]!.combination!.missing.push("mutation");
    context.steps[0]!.combination!.counterEvidence!.push("mutation");
    context.factIndex[0]!.evidenceIds.push("mutation");
    context.factIndex[0]!.replacedBy.push("mutation");
    context.attempts[0]!.evidenceIds.push("mutation");
    context.hints[0]!.content = "mutation";
    expect(JSON.stringify(input.snapshot)).toBe(before);
  });

  it("retains source combination conditions and counterevidence without leaking private origin fields", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", ["RESULT"]);
    const origin = { ...step("ORIGIN", "done", ["INPUT"]), combination: {
      requires: ["INPUT"], missing: ["verify shared identity"], scope: "tenant A/alice", stateVersion: "v3", expectedCapability: "combined result", counterEvidence: ["COUNTER"],
    } };
    Object.assign(origin, { messages: ["PRIVATE_ORIGIN_CHAT"] });
    Object.assign(origin.combination, { credentials: "PRIVATE_ORIGIN_SECRET" });
    input.snapshot.steps = [origin];
    input.snapshot.facts = [fact("RESULT", "ORIGIN"), fact("INPUT"), fact("COUNTER")];
    const before = JSON.stringify(input.snapshot);
    const context = projectContext(input);
    expect(ids(context.facts)).toEqual(["RESULT", "INPUT", "COUNTER"]);
    expect(context.stepOrigins[0]!.combination).toEqual({ requires: ["INPUT"], missing: ["verify shared identity"], scope: "tenant A/alice", stateVersion: "v3", expectedCapability: "combined result", counterEvidence: ["COUNTER"] });
    expect(JSON.stringify(context)).not.toContain("PRIVATE_ORIGIN");
    context.stepOrigins[0]!.combination!.counterEvidence!.push("mutation");
    context.stepOrigins[0]!.from.push("mutation");
    expect(JSON.stringify(input.snapshot)).toBe(before);
    assertReferences(projectContext(input));
  });

  it("projects compact historical attempts with identity/state intact and scopes Execute to matching conditions", () => {
    const input = request();
    input.snapshot.attempts = [attempt("A", { observation: "x".repeat(1_000) }), attempt("B", { identity: "bob" }),
      attempt("OLD_STATE", { stateVersion: "v0" }), attempt("OTHER_SCOPE", { scope: "tenant B" }), attempt("DIRECT", { stepId: "CURRENT", scope: "other direct scope" })];
    expect(projectContext(input).attempts).toHaveLength(5);
    input.mode = "execute";
    input.step = { ...step("CURRENT", "claimed"), combination: { requires: [], missing: [], scope: "tenant A", stateVersion: "v1", expectedCapability: "inspect same conditions" } };
    const context = projectContext(input);
    expect(ids(context.attempts)).toEqual(["A", "B", "DIRECT"]);
    expect(context.attempts[0]!.observation).toHaveLength(501);
    expect(context.attempts.map(item => item.identity)).toEqual(["alice", "bob", "alice"]);
    expect(context.attempts[0]!.stateVersion).toBe("v1");
    expect(context.projection.omittedAttempts).toBe(2);
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE_CONDITION|PRIVATE_OUTCOME|PRIVATE_ATTEMPT/);
    delete input.snapshot.attempts;
    expect(projectContext(input).attempts).toEqual([]);
  });

  it("marks direct and derived plans for review while allowing explicitly corrected facts", () => {
    const input = request();
    input.snapshot.steps = [step("DERIVE", "done", ["OLD"]), step("CORRECT", "done", ["OLD"]),
      step("DIRECT", "ready", ["OLD"]), step("INDIRECT", "ready", ["DERIVED"]), step("REPLANNED", "ready", ["NEW"]),
      step("HISTORY", "done", ["OLD"])];
    input.snapshot.facts = [fact("OLD"), fact("DERIVED", "DERIVE"), fact("NEW", "CORRECT", [], "OLD")];
    const expected = [
      { stepId: "DIRECT", staleFactIds: ["OLD"], replacementFactIds: ["NEW"] },
      { stepId: "INDIRECT", staleFactIds: ["OLD"], replacementFactIds: ["NEW"] },
    ];
    expect(pendingStepReviews(input.snapshot)).toEqual(expected);
    const context = projectContext(input);
    expect(context.projection.stepReviews).toEqual(expected);
    expect(context.factIndex.find(item => item.id === "OLD")).toMatchObject({ status: "superseded", replacedBy: ["NEW"] });
    expect(context.factIndex.find(item => item.id === "NEW")).toMatchObject({ status: "available", supersedes: "OLD" });
  });

  it("terminates cyclic replacement/causal review graphs and records unknown causal references", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", ["F0"]);
    input.snapshot.steps = [input.step, step("ORIGIN", "done", ["F1", "MISSING_FACT"])];
    input.snapshot.facts = [fact("F0", "ORIGIN", [], "F1"), fact("F1", "ORIGIN", ["MISSING_E"], "F0")];
    const context = projectContext(input);
    expect(context.projection.unavailableReferences).toEqual({ goals: [], facts: ["MISSING_FACT"], evidence: ["MISSING_E"], steps: [] });
    expect(context.projection.stepReviews[0]).toMatchObject({ stepId: "CURRENT", staleFactIds: ["F0"] });
    expect(new Set(context.projection.stepReviews[0]!.replacementFactIds)).toEqual(new Set(["F0", "F1"]));
  });

  it("terminates malformed cycles and labels source references that were already missing", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", ["F0", "MISSING_FACT"], "G1");
    input.snapshot.goals = [goal("G0", null), goal("G1", "G2"), goal("G2", "G1")];
    input.snapshot.facts = [fact("F0", "MISSING_STEP", ["MISSING_EVIDENCE"], "F1"), fact("F1", null, [], "F0")];
    const context = projectContext(input);
    expect(ids(context.facts)).toEqual(["F0", "F1"]);
    expect(context.projection.unavailableReferences).toEqual({ goals: [], facts: ["MISSING_FACT"], steps: ["MISSING_STEP"], evidence: ["MISSING_EVIDENCE"] });
  });

  it("records a missing assigned Goal instead of implying its completion", () => {
    const input = request("execute");
    input.step = step("CURRENT", "claimed", [], "MISSING_GOAL");
    expect(projectContext(input).projection.unavailableReferences.goals).toEqual(["MISSING_GOAL"]);
  });

  it("exposes only an unverified artifacts recovery reference for failed Steps", () => {
    const input = request("decide");
    input.snapshot.steps = [step("FAILED", "failed"), step("DONE", "done"), step("READY", "ready")];
    const before = JSON.stringify(input.snapshot);
    const context = projectContext(input);
    expect(context.steps[0]!.recovery).toEqual({
      artifacts: join(dirname(input.runDir), "PRIVATE_RUN_FAILED", "artifacts"), evidenceStatus: "unverified",
    });
    expect(context.steps.slice(1).every(item => item.recovery === undefined)).toBe(true);
    expect(context.facts).toEqual([]);
    expect(context.evidence).toEqual([]);
    const serialized = JSON.stringify(context);
    for (const privateField of ["\"runId\"", "leaseUntil", "input.json", "events.jsonl", "output.json"]) expect(serialized).not.toContain(privateField);
    expect(context.projection.notice).toContain("not committed Evidence");
    context.steps[0]!.recovery!.artifacts = "changed projection only";
    expect(JSON.stringify(input.snapshot)).toBe(before);
  });

  it.each([null, "../other-run", "run/../../input.json", "x".repeat(101)])("does not derive recovery paths from missing or malformed run IDs (%s)", runId => {
    const input = request("decide");
    input.snapshot.steps = [{ ...step("FAILED", "failed"), runId }];
    expect(projectContext(input).steps[0]!.recovery).toBeUndefined();
  });
});
