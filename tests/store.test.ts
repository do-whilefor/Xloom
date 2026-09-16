import { projectDirectory } from "../src/paths.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import { BlackboardStore } from "../src/store.js";
import type { BoardSnapshot, Decision, Execution, Impact, Mode, Outcome, Usage } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
const usage: Usage = { input: 10, output: 5, cost: 0.001 };
const impact: Impact = { capability: "Mock read capability", object: "Mock object owned by second fixture identity", result: "Fixture content returned", scope: "One fixture object", prerequisites: "Two local fixture accounts" };
let runSequence = 0;
const nextRun = () => `test-run-${++runSequence}`;

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-store-test-"));
  roots.push(root);
  return root;
}

function openStore(root = workspace()): BlackboardStore {
  const store = new BlackboardStore(root, defaultConfig("Validate local test fixtures"));
  stores.push(store);
  return store;
}

function runDecision(store: BlackboardStore, decision: Decision, mode: "decide" | "metacog" = "decide") {
  if (store.snapshot().status !== "running") store.setStatus("running", "Test running");
  const runId = nextRun();
  store.beginRun(runId, mode);
  return store.applyDecision(runId, decision, usage);
}

function claimStep(store: BlackboardStore, description = `Fixture validation ${runSequence}`) {
  const board = runDecision(store, { summary: "Plan fixture validation", steps: [{ goalId: "G0", from: [], description, successSignal: "Fixture result saved", evidencePlan: "Save fixture responses", priority: 50 }] });
  const step = board.steps.find(item => item.status === "ready")!;
  const runId = nextRun();
  store.beginRun(runId, "execute", step.id);
  const artifacts = path.join(store.dataDir, "runs", runId, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  return { runId, step, artifacts };
}

function hitOutput(evidencePath = "response.txt", contentDescription = "Mock response difference"): Execution {
  return {
    summary: "Fixture boundary difference observed",
    result: "done",
    evidence: [{ ref: "e1", path: evidencePath, description: "Original mock fixture responses" }],
    facts: [{ ref: "f1", description: contentDescription, evidenceRefs: ["e1"] }],
    findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: "fixture identity B × object A", status: "technical_hit", factRefs: ["f1"], evidenceRefs: ["e1"], next: "Validate fixture impact" }],
  };
}

function produceHit(store: BlackboardStore) {
  const claimed = claimStep(store);
  writeFileSync(path.join(claimed.artifacts, "response.txt"), "TEST FIXTURE ONLY\nGET /fixture/object\nidentity=A -> fixture-200\nidentity=B -> fixture-200\n");
  return store.applyExecution(claimed.runId, hitOutput(), usage);
}

function verifiedDecision(store: BlackboardStore, rating: "info" | "P3" | "P2" | "P1" = "P3"): Decision {
  const finding = store.snapshot().findings[0];
  return { summary: "Review fixture evidence", reviews: [{ findingId: finding.id, status: "impact_verified", rating, reason: "Structurally complete mock review; not a real vulnerability claim", impact, pocEvidenceId: finding.evidenceIds[0] }] };
}

function completeGoal(store: BlackboardStore, outcome: Exclude<Outcome, "NEED_INPUT"> = "VULN_FOUND"): Decision {
  return {
    summary: "Final fixture goal review",
    updateGoals: [{ id: "G0", status: "satisfied", factIds: store.snapshot().facts.map(fact => fact.id), reason: "Archived fixture observations cover the original goal" }],
    conclusion: { outcome, reason: "Fixture goal complete with archived evidence" },
  };
}

function legacyFixture(store: BlackboardStore, change: (board: BoardSnapshot) => void): BoardSnapshot {
  const board = store.snapshot();
  change(board);
  store.close();
  const database = new DatabaseSync(path.join(store.dataDir, "blackboard.sqlite"));
  try { database.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board)); }
  finally { database.close(); }
  return board;
}

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("transactional blackboard", () => {
  it("retains bounded planning memory across status changes, failed proposals, reopen and task isolation", () => {
    const store = openStore();
    const first = runDecision(store, { summary: "Readonly comparison complete. ".repeat(200) });
    const memory = first.planningMemory!;
    expect(memory).toMatchObject({ mode: "decide", revision: first.revision, truncated: true });
    expect(memory.summary).toHaveLength(4000);
    expect(first.facts).toEqual([]);
    store.setStatus("paused", "Operational pause");
    store.setStatus("running", "Starting a fresh planning context");
    const runId = nextRun(); store.beginRun(runId, "metacog");
    expect(() => store.applyDecision(runId, { summary: "Must not replace saved memory", steps: [{ goalId: "missing" }] }, usage)).toThrow();
    store.failRun(runId, "Provider failed");
    expect(store.snapshot().planningMemory).toEqual(memory);
    const root = store.workspace; store.close();
    const reopened = openStore(root);
    expect(reopened.snapshot().planningMemory).toEqual(memory);
    const other = new BlackboardStore(root, defaultConfig("Validate local test fixtures"), { taskId: "independent" }); stores.push(other);
    expect(other.snapshot().planningMemory).toBeUndefined();
    const second = runDecision(reopened, { summary: "Corrected read-only comparison" }, "metacog");
    expect(second.planningMemory).toMatchObject({ mode: "metacog", summary: "Corrected read-only comparison", truncated: false });
    expect(second.planningMemory!.runId).not.toBe(memory.runId);
  });
  it("initializes one root goal and a readable generated projection", () => {
    const store = openStore();
    expect(store.snapshot()).toMatchObject({ revision: 0, status: "idle", outcome: null, facts: [], usage: { input: 0, output: 0, cost: 0 }, goals: [{ id: "G0", status: "active", parentId: null }] });
    expect(store.events().map(event => event.kind)).toEqual(["initialized"]);
    expect(readFileSync(store.projectionPath, "utf8")).toContain("SQLite is authoritative");
  });

  it("rolls back graph, run completion, usage and audit event together on invalid references", () => {
    const store = openStore();
    store.setStatus("running", "Test");
    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const eventsBefore = store.events();
    expect(() => store.applyDecision(runId, { summary: "Bad plan", goals: [{ id: "G1", parentId: "G0", description: "Must roll back" }], steps: [{ goalId: "G1", from: ["missing-fact"], description: "Invalid reference", successSignal: "None", evidencePlan: "None", priority: 1 }] }, usage)).toThrow(/Unknown fact reference/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
    expect(store.applyDecision(runId, { summary: "Corrected plan" }, usage).usage).toEqual(usage);
    expect(() => store.applyDecision(runId, { summary: "Duplicate submission" }, usage)).toThrow(/already committed/);
  });

  it("reuses an identical active Goal declaration while committing its new plan", () => {
    const store = openStore();
    const goal = { id: "G2", parentId: "G0", description: "Compare synthetic fixture labels" };
    const first = runDecision(store, { summary: "Create fixture subgoal", goals: [goal] });
    const board = runDecision(store, { summary: "Continue the existing subgoal", goals: [goal], steps: [{
      goalId: "G2", from: [], description: "Inspect another fixture label", successSignal: "Label observed", evidencePlan: "Save fixture", priority: 1,
    }] });
    expect(board.goals).toEqual(first.goals);
    expect(board.steps).toHaveLength(1);
    expect(board.steps[0]).toMatchObject({ goalId: "G2", status: "ready" });
    expect(store.runs().every(run => run.status === "completed")).toBe(true);
  });

  it.each(["satisfied", "abandoned"] as const)("retains a repeated %s Goal's state and fact links without reopening it", status => {
    const store = openStore();
    const hit = produceHit(store);
    const goal = { id: "G2", parentId: "G0", description: "Compare synthetic fixture labels" };
    runDecision(store, { summary: "Create fixture subgoal", goals: [goal] });
    const previous = runDecision(store, { summary: "Resolve fixture subgoal", updateGoals: [{
      id: goal.id, status, factIds: [hit.facts[0].id], reason: "Synthetic result recorded",
    }] });
    const repeated = runDecision(store, { summary: "Repeat public goal declaration", goals: [goal] });
    expect(repeated.goals).toEqual(previous.goals);
    expect(repeated.facts).toEqual(previous.facts);
    expect(repeated.evidence).toEqual(previous.evidence);

    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    expect(() => store.applyDecision(runId, { summary: "Cannot reopen history by redeclaring it", goals: [goal], steps: [{
      goalId: goal.id, from: [], description: "Must not run under a resolved Goal", successSignal: "None", evidencePlan: "None", priority: 1,
    }] }, usage)).toThrow("Step requires an active goal");
    expect(store.snapshot()).toEqual(before);
    expect(() => store.applyDecision(runId, { summary: "Cannot create a child under resolved history", goals: [goal,
      { id: "G-child", parentId: goal.id, description: "Must not reopen parent" },
    ] }, usage)).toThrow(`has status ${status}`);
    expect(store.snapshot()).toEqual(before);
  });

  it("deduplicates identical same-batch declarations and permits their child Goal", () => {
    const store = openStore();
    const goal = { id: "G2", parentId: "G0", description: "Synthetic parent" };
    const board = runDecision(store, { summary: "Declare parent twice before child", goals: [goal, goal,
      { id: "G3", parentId: "G2", description: "Synthetic child" },
    ] });
    expect(board.goals.map(item => item.id)).toEqual(["G0", "G2", "G3"]);
    expect(board.goals.every(item => item.status === "active")).toBe(true);
  });

  it.each(["description", "parent", "same-batch"] as const)("atomically rejects a conflicting Goal %s without replacing existing records", conflict => {
    const store = openStore();
    const goal = { id: "G2", parentId: "G0", description: "Existing synthetic subgoal" };
    if (conflict !== "same-batch") runDecision(store, { summary: "Create fixture subgoal", goals: [goal] });
    else store.setStatus("running", "Synthetic same-batch conflict");
    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const events = store.events();
    expect(() => store.applyDecision(runId, { summary: "Invalid declaration after a valid new Goal", goals: [
      { id: "G-other", parentId: "G0", description: "Must also roll back" },
      ...(conflict === "same-batch" ? [goal] : []),
      { ...goal, ...(conflict === "parent" ? { parentId: "G-other" } : { description: "Different synthetic subgoal" }) },
    ] }, usage)).toThrow("Goal G2 already exists with a different description or parent");
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rolls back evidence references and step completion for invalid Execute output", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture response");
    const before = store.snapshot();
    const eventsBefore = store.events();
    const output = hitOutput();
    output.facts![0].evidenceRefs = ["missing-evidence"];
    expect(() => store.applyExecution(runId, output, usage)).toThrow(/Unknown evidence reference/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it.each(["abandon", "prioritize"] as const)("keeps Store strict and rolls back direct %s of a settled blocked Step", action => {
    const store = openStore();
    const execution = claimStep(store);
    writeFileSync(path.join(execution.artifacts, "response.txt"), "SYNTHETIC LOCAL FIXTURE ONLY");
    store.applyExecution(execution.runId, { ...hitOutput(), result: "blocked" }, usage);
    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const events = store.events();
    expect(() => store.applyDecision(runId, {
      summary: "Attempt to change settled history",
      goals: [{ id: "G1", parentId: "G0", description: "Must roll back with the invalid update" }],
      updateSteps: [{ id: execution.step.id, action, priority: 300, reason: "Historical cleanup is not a ready Step update" }],
    }, usage)).toThrow(`Only ready steps may be changed. Step ${execution.step.id} has status blocked.`);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
    expect(store.snapshot().steps[0]).toMatchObject({ status: "blocked", attempts: 1, runId: execution.runId });
    expect(store.snapshot().evidence).toHaveLength(1);
  });

  it("distinguishes a truncated Step ID from a real Step's status and rolls back preceding updates", () => {
    const store = openStore();
    const planned = runDecision(store, { summary: "Plan ready fixture steps", steps: ["first", "second"].map(description => ({
      goalId: "G0", from: [], description, successSignal: "Fixture observed", evidencePlan: "Synthetic fixture", priority: 1,
    })) });
    const runId = nextRun();
    store.beginRun(runId, "decide");
    const before = store.snapshot();
    const events = store.events();
    const truncated = planned.steps[1].id.slice(0, -1);
    expect(() => store.applyDecision(runId, { summary: "One valid update and one truncated ID", updateSteps: [
      { id: planned.steps[0].id, action: "abandon", reason: "Superseded fixture plan" },
      { id: truncated, action: "prioritize", priority: 3, reason: "A different fixture condition" },
    ] }, usage)).toThrow(`Unknown Step reference: ${truncated}. Copy an exact committed Step ID.`);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(events);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rejects unsupported facts and keeps them out of authoritative state", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    expect(() => store.applyExecution(runId, { summary: "Unsupported statement", result: "done", facts: [{ ref: "f1", description: "An agent thinks this is true", evidenceRefs: [] }] }, usage)).toThrow(/Facts require original evidence/);
    expect(store.snapshot().facts).toEqual([]);
    expect(store.snapshot().steps[0].status).toBe("claimed");
  });

  it("rejects a technical hit without evidence-backed facts", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    expect(() => store.applyExecution(runId, { summary: "No evidence", result: "done", findings: [{ key: "unsupported", title: "Unsupported hit", target: "fixture", status: "technical_hit", factRefs: [], evidenceRefs: [], next: "Verify" }] }, usage)).toThrow(/technical hit requires evidence-backed facts/);
  });

  it("attaches a new finding's complete fact provenance even when explicit evidence omits it", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture evidence E1");
    writeFileSync(path.join(artifacts, "grounding.txt"), "fixture evidence E2 grounding the fact");
    const output = hitOutput();
    output.evidence!.push({ ref: "e2", path: "grounding.txt", description: "Actual fact grounding" });
    output.facts![0].evidenceRefs = ["e1", "e2"];
    const board = store.applyExecution(runId, output, usage);
    expect(board.findings[0].evidenceIds).toEqual(board.facts[0].evidenceIds);
    expect(board.findings[0].evidenceIds).toHaveLength(2);
    expect(board.findings[0].factIds).toEqual([board.facts[0].id]);
    expect(board.findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
    expect(store.runs().find(run => run.id === runId)?.status).toBe("completed");
  });

  it("inherits a newly added fact's evidence into an existing finding while retaining prior evidence", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId, artifacts } = claimStep(store, "Add another grounded observation");
    writeFileSync(path.join(artifacts, "new-grounding.txt"), "new fixture evidence missing from finding");
    const output: Execution = {
      summary: "Incomplete provenance", result: "done",
      evidence: [{ ref: "new-e", path: "new-grounding.txt", description: "New fact grounding" }],
      facts: [{ ref: "new-f", description: "A fact grounded in new-e", evidenceRefs: ["new-e"] }],
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: ["new-f"], evidenceRefs: [first.evidence[0].id], next: "Review new fact" }],
    };
    const board = store.applyExecution(runId, output, usage);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0].id).toBe(first.findings[0].id);
    expect(board.findings[0].factIds).toEqual(board.facts.map(fact => fact.id));
    expect(board.findings[0].evidenceIds).toEqual(board.evidence.map(evidence => evidence.id));
    expect(board.findings[0].evidenceIds).toHaveLength(2);
  });

  it("inherits verified evidence from a previously committed fact without requiring duplicate refs", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Reuse a committed fact in another finding");
    const board = store.applyExecution(runId, {
      summary: "Use existing provenance", result: "done",
      findings: [{ key: "second-observation", title: "Another fixture interpretation", target: "fixture", status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [], pocEvidenceRef: first.evidence[0].id, next: "Review inherited evidence" }],
    }, usage);
    expect(board.findings[1].factIds).toEqual([first.facts[0].id]);
    expect(board.findings[1].evidenceIds).toEqual(first.facts[0].evidenceIds);
    expect(board.findings[1].pocEvidenceId).toBe(first.evidence[0].id);
    expect(board.facts).toEqual(first.facts);
    expect(board.evidence).toEqual(first.evidence);
  });

  it.each(["unknown fact", "unknown evidence", "unattached PoC"])("still rolls back inherited finding provenance for %s", failure => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture fact evidence");
    writeFileSync(path.join(artifacts, "unrelated.txt"), "unrelated fixture evidence");
    const output = hitOutput();
    output.evidence!.push({ ref: "unrelated", path: "unrelated.txt", description: "Not backing the finding" });
    output.findings![0].evidenceRefs = failure === "unknown evidence" ? ["missing-e"] : [];
    if (failure === "unknown fact") output.findings![0].factRefs = ["missing-f"];
    if (failure === "unattached PoC") output.findings![0].pocEvidenceRef = "unrelated";
    const before = store.snapshot();
    const eventsBefore = store.events();
    expect(() => store.applyExecution(runId, output, usage)).toThrow(failure === "unknown fact" ? /Unknown fact reference: missing-f/ : failure === "unknown evidence" ? /Unknown evidence reference: missing-e/ : /PoC evidence must be attached/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it.each(["tampered", "missing"])("rejects %s evidence inherited from a previously committed fact", damage => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Reference a fact with damaged archived evidence");
    const archive = path.join(store.dataDir, first.evidence[0].path);
    if (damage === "tampered") writeFileSync(archive, "changed fixture archive");
    else rmSync(archive);
    const before = store.snapshot();
    const eventsBefore = store.events();
    expect(() => store.applyExecution(runId, {
      summary: "Reuse damaged provenance", result: "done",
      findings: [{ key: "second-observation", title: "Another fixture interpretation", target: "fixture", status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [], next: "Verify original bytes" }],
    }, usage)).toThrow(damage === "tampered" ? /Evidence changed/ : /ENOENT/);
    expect(store.snapshot()).toEqual(before);
    expect(store.events()).toEqual(eventsBefore);
  });

  it("accepts fact provenance already covered by an existing finding's merged evidence", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Interpret an already attached fixture response");
    const board = store.applyExecution(runId, {
      summary: "New grounded observation from existing attached evidence", result: "done",
      facts: [{ ref: "new-f", description: "A distinct observation about the same fixture response", evidenceRefs: [first.evidence[0].id] }],
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "lead", factRefs: ["new-f"], evidenceRefs: [], next: "Review both grounded observations" }],
    }, usage);
    expect(board.findings[0].factIds).toHaveLength(2);
    expect(board.findings[0].evidenceIds).toEqual(first.findings[0].evidenceIds);
    expect(board.findings[0].status).toBe("technical_hit");
  });

  it("deduplicates normalized steps and does not replay finished equivalents", () => {
    const store = openStore();
    const { runId } = claimStep(store, "Compare   Fixture Accounts");
    store.applyExecution(runId, { summary: "No new evidence", result: "done" }, usage);
    const board = runDecision(store, { summary: "Repeated proposal", steps: [{ goalId: "G0", from: [], description: " compare fixture accounts ", successSignal: "Compare", evidencePlan: "Save", priority: 5 }] });
    expect(board.steps).toHaveLength(1);
    expect(board.steps[0]).toMatchObject({ status: "no_progress", attempts: 1 });
    expect(board.noProgressCount).toBe(1);
  });

  it("returns detached snapshots, not writable authority", () => {
    const store = openStore();
    const snapshot = store.snapshot();
    snapshot.goals[0].description = "mutated externally";
    snapshot.config.goal = "changed";
    expect(store.snapshot().goals[0].description).toBe("Validate local test fixtures");
  });

  it.each(["decide", "metacog"] as Mode[])("does not permit %s to claim an Execute step", (mode) => {
    const store = openStore();
    store.setStatus("running", "Test");
    expect(() => store.beginRun(nextRun(), mode, "some-step")).toThrow(/Only Execute may claim/);
    expect(store.runs()).toEqual([]);
  });
});

describe("evidence boundaries and integrity", () => {
  it.each(["final", "checkpoint"] as const)("archives empty stderr alongside its command result through %s submission", route => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "command.json"), '{"command":"node --version","exitCode":0}');
    writeFileSync(path.join(artifacts, "stderr.txt"), "");
    const output: Execution = { summary: "Command returned exit code 0 with no stderr bytes", result: "done",
      evidence: [{ ref: "command", path: "command.json", description: "Recorded command and exit code" },
        { ref: "stderr", path: "stderr.txt", description: "Original empty stderr" }],
      facts: [{ ref: "result", description: "Recorded command exited with code 0 and empty stderr", evidenceRefs: ["command", "stderr"] }],
    };
    const board = route === "final" ? store.applyExecution(runId, output, usage)
      : store.applyExecutionCheckpoint(runId, "empty-stderr", output, usage);
    expect(board).toMatchObject({ status: "running", outcome: null, completedSteps: route === "final" ? 1 : 0 });
    expect(board.steps[0].status).toBe(route === "final" ? "done" : "claimed");
    expect(board.evidence).toHaveLength(2);
    expect(board.facts[0].evidenceIds).toEqual(board.evidence.map(item => item.id));
    const empty = board.evidence.find(item => item.bytes === 0)!;
    expect(empty).toMatchObject({ sha256: createHash("sha256").update("").digest("hex"), excerpt: "", runId });
    const archived = path.join(store.dataDir, empty.path);
    expect(readFileSync(archived)).toEqual(Buffer.alloc(0));
    writeFileSync(path.join(artifacts, "stderr.txt"), "source changed after collection");
    expect(() => store.verifyEvidence(empty)).not.toThrow();
    writeFileSync(archived, "archive tampered");
    expect(() => store.verifyEvidence(empty)).toThrow("Evidence changed");
  });

  it("archives original bytes with a verifiable SHA-256 independent of the mutable source", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const bytes = Buffer.from("TEST FIXTURE 原始响应\r\n");
    writeFileSync(path.join(artifacts, "response.txt"), bytes);
    const board = store.applyExecution(runId, hitOutput(), usage);
    const evidence = board.evidence[0];
    expect(evidence.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(evidence.bytes).toBe(bytes.length);
    expect(readFileSync(path.join(store.dataDir, evidence.path))).toEqual(bytes);
    writeFileSync(path.join(artifacts, "response.txt"), "source changed after collection");
    expect(() => store.verifyEvidence(evidence)).not.toThrow();
  });

  it.each(["relative traversal", "absolute path"])("rejects evidence outside run artifacts via %s", (form) => {
    const store = openStore();
    const { runId } = claimStep(store);
    const outside = path.join(store.dataDir, "outside.txt");
    writeFileSync(outside, "outside fixture");
    const source = form === "absolute path" ? outside : path.relative(path.join(store.dataDir, "runs", runId, "artifacts"), outside);
    expect(() => store.applyExecution(runId, hitOutput(source), usage)).toThrow(/inside this run's artifacts/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("rejects a directory junction escape from the artifacts directory", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const outside = path.join(store.dataDir, "outside-directory");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "response.txt"), "outside fixture");
    symlinkSync(outside, path.join(artifacts, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => store.applyExecution(runId, hitOutput(path.join("escape", "response.txt")), usage)).toThrow(/inside this run's artifacts/);
  });

  it.each(["oversized", "directory"])("rejects %s evidence", (form) => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const file = path.join(artifacts, "response.txt");
    if (form === "directory") mkdirSync(file);
    else writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(() => store.applyExecution(runId, hitOutput(), usage)).toThrow(/Evidence must/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("rejects more than 50 MiB of aggregate evidence in one Execute output", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    const evidence: NonNullable<Execution["evidence"]> = [];
    for (let index = 0; index < 6; index++) {
      const filename = `fixture-${index}.bin`;
      writeFileSync(path.join(artifacts, filename), Buffer.alloc(9 * 1024 * 1024, index + 1));
      evidence.push({ ref: `e${index}`, path: filename, description: "Large synthetic fixture artifact" });
    }
    const before = store.snapshot();
    expect(() => store.applyExecution(runId, { summary: "Oversized aggregate evidence", result: "done", evidence }, usage)).toThrow();
    expect(store.snapshot()).toEqual(before);
    expect(store.runs().find(run => run.id === runId)?.status).toBe("running");
  });

  it("rejects duplicate local evidence aliases atomically", () => {
    const store = openStore();
    const { runId, artifacts } = claimStep(store);
    writeFileSync(path.join(artifacts, "response.txt"), "fixture");
    const output = hitOutput();
    output.evidence!.push({ ...output.evidence![0] });
    expect(() => store.applyExecution(runId, output, usage)).toThrow(/Duplicate or ambiguous evidence ref/);
    expect(store.snapshot().evidence).toEqual([]);
  });

  it("detects archive tampering before a finding can be verified", () => {
    const store = openStore();
    const board = produceHit(store);
    writeFileSync(path.join(store.dataDir, board.evidence[0].path), "tampered");
    expect(() => store.verifyEvidence(board.evidence[0])).toThrow(/Evidence changed/);
    expect(() => runDecision(store, verifiedDecision(store), "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
  });

  it("detects tampering again at final VULN_FOUND validation", () => {
    const store = openStore();
    produceHit(store);
    const reviewed = runDecision(store, verifiedDecision(store));
    writeFileSync(path.join(store.dataDir, reviewed.evidence[0].path), "tampered after review");
    expect(() => runDecision(store, completeGoal(store), "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().outcome).toBeNull();
  });

  it.each(["NOT_REPRODUCED", "LOW_ROI"] as const)("rehashes original evidence before final %s", (outcome) => {
    const store = openStore();
    const board = produceHit(store);
    const review: Decision = outcome === "LOW_ROI" ? verifiedDecision(store, "info") : {
      summary: "Close a validated fixture hypothesis",
      reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "Fixture counterexample refutes the hypothesis; reopen for a new identity" }],
    };
    const reviewed = runDecision(store, review);
    writeFileSync(path.join(store.dataDir, reviewed.evidence[0].path), "tampered after review");
    expect(() => runDecision(store, completeGoal(store, outcome), "metacog")).toThrow(/Evidence changed/);
    expect(store.snapshot().outcome).toBeNull();
  });
});

describe("findings and outcome gates", () => {
  it("deduplicates finding keys, facts and evidence while retaining unrated technical hits", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "A distinct variable with existing evidence");
    const board = store.applyExecution(runId, {
      summary: "Repeated observation with no new evidence", result: "done",
      facts: [{ ref: "f2", description: "  mock RESPONSE difference ", evidenceRefs: [first.evidence[0].id] }],
      findings: [{ key: "  FIXTURE-OWNERSHIP ", title: "Repeated lead", target: "FIXTURE IDENTITY B × OBJECT A", status: "lead", factRefs: ["f2"], evidenceRefs: [first.evidence[0].id], next: "Validate fixture impact" }],
    }, usage);
    expect(board.evidence).toHaveLength(1);
    expect(board.facts).toHaveLength(1);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ id: first.findings[0].id, status: "technical_hit", rating: "unrated" });
    expect(board.noProgressCount).toBe(1);
  });

  it("rejects reuse of a finding key for a different target", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store);
    const before = store.snapshot();
    expect(() => store.applyExecution(runId, { summary: "Conflicting target", result: "done", findings: [{ key: "fixture-ownership", title: "Other target", target: "unrelated fixture", status: "lead", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Verify" }] }, usage))
      .toThrow(`committed target=${JSON.stringify(first.findings[0].target)}. To update this finding, omit target`);
    expect(store.snapshot()).toEqual(before);
  });

  it.each(["final", "checkpoint"] as const)("updates an existing finding without restating target through %s submission", mode => {
    const store = openStore();
    const first = produceHit(store);
    const { runId, artifacts } = claimStep(store, "Inspect a second fixture observation");
    writeFileSync(path.join(artifacts, "additional.txt"), "SYNTHETIC second observation on the same fixture");
    const update: Execution = {
      summary: "Additional fixture observation", result: "done",
      evidence: [{ ref: "e2", path: "additional.txt", description: "Synthetic second observation" }],
      facts: [{ ref: "f2", description: "Another result for the same fixture identity", evidenceRefs: ["e2"] }],
      findings: [{ key: " FIXTURE-OWNERSHIP ", title: "Further fixture observation", status: "technical_hit",
        factRefs: ["f2"], evidenceRefs: [], next: "Review both original fixture observations" }],
    };
    const board = mode === "checkpoint" ? store.applyExecutionCheckpoint(runId, "fixture-update", update, usage) : store.applyExecution(runId, update, usage);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ id: first.findings[0].id, key: first.findings[0].key, target: first.findings[0].target,
      status: "technical_hit", rating: "unrated", next: update.findings![0].next });
    expect(board.findings[0].factIds).toEqual(board.facts.map(fact => fact.id));
    expect(board.findings[0].evidenceIds).toEqual(board.evidence.map(evidence => evidence.id));
    expect(board.facts).toHaveLength(2);
    if (mode === "checkpoint") expect(store.applyExecutionCheckpoint(runId, "fixture-update", update, usage)).toEqual(board);
  });

  it("retains a target introduced earlier in the same batch when updating its key", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    const lead = { key: "fixture-new", title: "Synthetic hypothesis", status: "lead" as const, factRefs: [], evidenceRefs: [], next: "Inspect fixture" };
    const board = store.applyExecution(runId, { summary: "Record and clarify a hypothesis", result: "done",
      findings: [{ ...lead, target: "local fixture" }, { ...lead, next: "Compare another fixture state" }] }, usage);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ target: "local fixture", next: "Compare another fixture state" });
  });

  it.each(["final", "checkpoint"] as const)("rejects a new key missing target and atomically rolls back its %s batch", mode => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store);
    const before = store.snapshot();
    const update = { key: "fixture-ownership", title: "Synthetic hypothesis", status: "lead" as const,
      factRefs: [first.facts[0].id], evidenceRefs: [], next: "This change must roll back" };
    const output: Execution = { summary: "Mistyped existing key", result: "done", findings: [update, { ...update, key: "fixture-ownershi" }] };
    expect(() => mode === "checkpoint" ? store.applyExecutionCheckpoint(runId, "invalid-target", output, usage) : store.applyExecution(runId, output, usage))
      .toThrow('New finding key "fixture-ownershi" requires target');
    expect(store.snapshot()).toEqual(before);
  });

  it("does not treat changing next-action prose as new evidence or progress", () => {
    const store = openStore();
    const first = produceHit(store);
    const { runId } = claimStep(store, "Repeated observation with a reworded next action");
    const board = store.applyExecution(runId, {
      summary: "No additional observation", result: "done",
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Reworded guidance without any new evidence", impact: { ...impact, result: "Still only a textual hypothesis" } }],
    }, usage);
    expect(board.findings[0].next).toBe("Reworded guidance without any new evidence");
    expect(board.steps.find(step => step.runId === runId)?.status).toBe("no_progress");
    expect(board.noProgressCount).toBe(1);
  });

  it("keeps a reopened finding but requires actual new conditions or facts before crediting progress", () => {
    const store = openStore();
    const first = produceHit(store);
    runDecision(store, { summary: "Close initial fixture hypothesis", reviews: [{ findingId: first.findings[0].id, status: "closed", rating: "unrated", reason: "Initial variable refuted; reopen under a new fixture state" }] });
    const { runId } = claimStep(store, "New fixture state reopens this hypothesis");
    const board = store.applyExecution(runId, {
      summary: "Reopened following a changed fixture state", result: "done",
      findings: [{ key: "fixture-ownership", title: "Fixture ownership difference", target: first.findings[0].target, status: "technical_hit", factRefs: [first.facts[0].id], evidenceRefs: [first.evidence[0].id], next: "Validate reopened fixture state" }],
    }, usage);
    expect(board.findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
    expect(board.findings[0].review).toBeUndefined();
    expect(board.steps.find(step => step.runId === runId)?.status).toBe("no_progress");
    expect(board.noProgressCount).toBe(1);
  });

  it("requires technical validation before a lead may be impact verified", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    store.applyExecution(runId, { summary: "Unverified lead", result: "done", findings: [{ key: "lead", title: "Unverified", target: "fixture", status: "lead", factRefs: [], evidenceRefs: [], next: "Validate" }] }, usage);
    expect(() => runDecision(store, verifiedDecision(store), "metacog")).toThrow(/lead cannot skip/);
  });

  it.each(["rating", "impact", "poc"])("requires %s before verified impact", (missing) => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    if (missing === "rating") decision.reviews![0].rating = "unrated";
    if (missing === "impact") delete decision.reviews![0].impact;
    if (missing === "poc") delete decision.reviews![0].pocEvidenceId;
    expect(() => runDecision(store, decision, "metacog")).toThrow(/Verified impact requires/);
    expect(store.snapshot().findings[0].rating).toBe("unrated");
  });

  it("rejects final outcomes from ordinary Decide even with a complete fixture review", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Premature final result" };
    expect(() => runDecision(store, decision)).toThrow(/fresh metacognitive review/);
    expect(store.snapshot().findings[0].rating).toBe("unrated");
  });

  it("commits a structurally complete mock lifecycle only after metacognitive review", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store);
    decision.updateGoals = completeGoal(store).updateGoals;
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Mock lifecycle complete; fixture test only" };
    const board = runDecision(store, decision, "metacog");
    expect(board).toMatchObject({ status: "completed", outcome: "VULN_FOUND", lastMetaStep: 1 });
    expect(board.lastMetaRevision).toBe(board.revision);
    expect(board.findings[0]).toMatchObject({ status: "impact_verified", rating: "P3", impact });
    expect(board.goals[0]).toMatchObject({ status: "satisfied", factIds: board.facts.map(fact => fact.id) });
    expect(board.usage).toEqual({ input: 30, output: 15, cost: 0.003 });
    expect(store.events().map(event => event.kind)).toContain("execution");
  });

  it.each(["VULN_FOUND", "NOT_REPRODUCED", "LOW_ROI"] as const)("rejects %s when technical impact remains unreviewed", (outcome) => {
    const store = openStore();
    produceHit(store);
    expect(() => runDecision(store, completeGoal(store, outcome), "metacog")).toThrow();
    expect(store.snapshot().outcome).toBeNull();
  });

  it("refuses final completion while proposed steps remain pending", () => {
    const store = openStore();
    produceHit(store);
    runDecision(store, { summary: "Additional validation", steps: [{ goalId: "G0", from: [], description: "Check a second variable", successSignal: "Observed", evidencePlan: "Save", priority: 10 }] });
    const decision = verifiedDecision(store);
    decision.conclusion = { outcome: "VULN_FOUND", reason: "Incomplete coverage" };
    expect(() => runDecision(store, decision, "metacog")).toThrow(/Pending steps/);
  });

  it("permits LOW_ROI only after info impact validation", () => {
    const store = openStore();
    produceHit(store);
    const decision = verifiedDecision(store, "info");
    decision.updateGoals = completeGoal(store).updateGoals;
    decision.conclusion = { outcome: "LOW_ROI", reason: "Fixture shows test-only impact" };
    expect(runDecision(store, decision, "metacog")).toMatchObject({ outcome: "LOW_ROI", status: "completed" });
  });

  it("permits an evidence-backed closed fixture hypothesis to conclude NOT_REPRODUCED", () => {
    const store = openStore();
    const board = produceHit(store);
    const closed = runDecision(store, {
      summary: "Fixture comparison refuted the hypothesis",
      updateGoals: completeGoal(store).updateGoals,
      reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "Counterexample in fixture responses; reopen on new object or identity" }],
      conclusion: { outcome: "NOT_REPRODUCED", reason: "Mock hypothesis closed with fixture evidence" },
    }, "metacog");
    expect(closed).toMatchObject({ outcome: "NOT_REPRODUCED", status: "completed" });
    expect(closed.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(closed.findings[0].next).toContain("reopen");
  });

  it("keeps missing-input hypotheses unrated and pauses instead of declaring completion", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    store.applyExecution(runId, { summary: "Missing second fixture identity", result: "blocked", findings: [{ key: "ownership", title: "Ownership lead", target: "fixture object", status: "lead", factRefs: [], evidenceRefs: [], next: "Need user to provide a second authorized fixture account" }] }, usage);
    const board = runDecision(store, { summary: "Input genuinely unavailable", conclusion: { outcome: "NEED_INPUT", reason: "Second account required" } }, "metacog");
    expect(board).toMatchObject({ outcome: "NEED_INPUT", status: "paused" });
    expect(board.goals[0]).toMatchObject({ status: "active", factIds: [] });
    expect(board.findings[0]).toMatchObject({ status: "lead", rating: "unrated" });
    expect(store.setStatus("running", "Second account supplied").outcome).toBeNull();
  });

  it("does not fabricate NEED_INPUT for an empty blackboard", () => {
    const store = openStore();
    expect(() => runDecision(store, { summary: "No work yet", conclusion: { outcome: "NEED_INPUT", reason: "Unjustified" } }, "metacog")).toThrow(/unresolved lead/);
  });

  it("requires original validation evidence before NOT_REPRODUCED, not merely a closed unsupported lead", () => {
    const store = openStore();
    const { runId } = claimStep(store);
    const board = store.applyExecution(runId, { summary: "Only a hypothesis; no request performed", result: "done", findings: [{ key: "unvalidated", title: "No validation yet", target: "fixture", status: "lead", factRefs: [], evidenceRefs: [], next: "Perform actual validation" }] }, usage);
    expect(() => runDecision(store, { summary: "Unsupported closure", reviews: [{ findingId: board.findings[0].id, status: "closed", rating: "unrated", reason: "No observation; reopen with another identity" }], conclusion: { outcome: "NOT_REPRODUCED", reason: "No evidence supplied" } }, "metacog")).toThrow();
  });
});

describe("root goal completion", () => {
  it.each(["VULN_FOUND", "NOT_REPRODUCED", "LOW_ROI"] as const)("does not let an individual %s finding complete an active root goal", (outcome) => {
    const store = openStore();
    const hit = produceHit(store);
    const review = outcome === "NOT_REPRODUCED" ? {
      summary: "One fixture hypothesis closed",
      reviews: [{ findingId: hit.findings[0].id, status: "closed" as const, rating: "unrated" as const, reason: "Fixture evidence refutes the hypothesis; reopen for a new identity" }],
    } : verifiedDecision(store, outcome === "LOW_ROI" ? "info" : "P3");
    runDecision(store, review);
    expect(() => runDecision(store, { summary: "Premature task completion", conclusion: { outcome, reason: "One finding resolved" } }, "metacog")).toThrow(/root goal G0 to be satisfied/);
    expect(store.snapshot()).toMatchObject({ status: "running", outcome: null, goals: [{ id: "G0", status: "active", factIds: [] }] });
  });

  it.each(["decide", "metacog"] as const)("does not allow %s to abandon the root goal", (mode) => {
    const store = openStore();
    expect(() => runDecision(store, { summary: "Stop without completing the goal", updateGoals: [{ id: "G0", status: "abandoned", factIds: [], reason: "Unfinished fixture work" }] }, mode)).toThrow(/root goal cannot be abandoned/);
    expect(store.snapshot().goals[0].status).toBe("active");
  });

  it("does not allow ordinary Decide to satisfy the root, even with evidence and a proposed conclusion", () => {
    const store = openStore();
    produceHit(store);
    expect(() => runDecision(store, { ...verifiedDecision(store), ...completeGoal(store) })).toThrow(/Root goal completion requires a fresh metacognitive review/);
    expect(store.snapshot().goals[0].status).toBe("active");
    expect(store.snapshot().findings[0].status).toBe("technical_hit");
  });

  it.each(["none", "NEED_INPUT"] as const)("does not satisfy the root when the same metacognitive review's conclusion is %s", (outcome) => {
    const store = openStore();
    produceHit(store);
    const decision = completeGoal(store);
    if (outcome === "none") delete decision.conclusion;
    else decision.conclusion = { outcome, reason: "Need a second fixture identity" };
    expect(() => runDecision(store, decision, "metacog")).toThrow(/final conclusion in the same review/);
    expect(store.snapshot()).toMatchObject({ outcome: null, goals: [{ id: "G0", status: "active" }] });
  });

  it.each(["no facts", "unknown fact"])("requires root completion to reference evidence-backed facts: %s", (missing) => {
    const store = openStore();
    produceHit(store);
    const decision = { ...verifiedDecision(store), ...completeGoal(store) };
    decision.updateGoals![0].factIds = missing === "no facts" ? [] : ["missing-fact"];
    expect(() => runDecision(store, decision, "metacog")).toThrow(missing === "no facts" ? /Satisfied goals require evidence-backed facts/ : /Unknown fact reference/);
    expect(store.snapshot().outcome).toBeNull();
    expect(store.snapshot().goals[0].status).toBe("active");
  });

  it("requires active child goals to be resolved before the root can be satisfied", () => {
    const store = openStore();
    produceHit(store);
    runDecision(store, { summary: "Additional user-goal coverage", goals: [{ id: "G1", parentId: "G0", description: "A remaining fixture boundary" }] });
    expect(() => runDecision(store, { ...verifiedDecision(store), ...completeGoal(store) }, "metacog")).toThrow(/Resolve active child goals first/);
    expect(store.snapshot().goals.map(goal => goal.status)).toEqual(["active", "active"]);
  });

  it("does not satisfy the root while an Execute step remains ready", () => {
    const store = openStore();
    produceHit(store);
    runDecision(store, { summary: "Remaining fixture validation", steps: [{ goalId: "G0", from: [], description: "Check another fixture object", successSignal: "Result archived", evidencePlan: "Save original comparison", priority: 20 }] });
    expect(() => runDecision(store, { ...verifiedDecision(store), ...completeGoal(store) }, "metacog")).toThrow(/Resolve a goal's pending steps first/);
    expect(store.snapshot().goals[0].status).toBe("active");
    expect(store.snapshot().steps.some(step => step.status === "ready")).toBe(true);
  });

  it("rolls back root satisfaction together with an invalid terminal conclusion", () => {
    const store = openStore();
    produceHit(store);
    expect(() => runDecision(store, completeGoal(store), "metacog")).toThrow(/VULN_FOUND requires verified impact/);
    expect(store.snapshot()).toMatchObject({ outcome: null, goals: [{ id: "G0", status: "active", factIds: [] }] });
    expect(store.runs().at(-1)?.status).toBe("running");
  });

  it("can resolve an evidence-backed child hierarchy and finish the root atomically", () => {
    const store = openStore();
    const hit = produceHit(store);
    runDecision(store, { summary: "Model fixture goal hierarchy", goals: [
      { id: "G1", parentId: "G0", description: "Fixture ownership coverage" },
      { id: "G2", parentId: "G1", description: "Fixture identity comparison" },
    ] });
    const decision = { ...verifiedDecision(store), ...completeGoal(store) };
    decision.updateGoals!.unshift(
      { id: "G2", status: "satisfied", factIds: [hit.facts[0].id], reason: "Fixture identity comparison evidenced" },
      { id: "G1", status: "satisfied", factIds: [hit.facts[0].id], reason: "Fixture ownership coverage evidenced" },
    );
    const board = runDecision(store, decision, "metacog");
    expect(board).toMatchObject({ status: "completed", outcome: "VULN_FOUND" });
    expect(board.goals.every(goal => goal.status === "satisfied")).toBe(true);
  });

  it.each(["changed", "missing"] as const)("verifies %s evidence referenced only by root-goal facts before final completion", (damage) => {
    const store = openStore();
    produceHit(store);
    runDecision(store, verifiedDecision(store));
    const { runId, artifacts } = claimStep(store, "Check remaining fixture coverage");
    writeFileSync(path.join(artifacts, "coverage.txt"), "Original fixture goal coverage observation");
    const board = store.applyExecution(runId, {
      summary: "Remaining fixture coverage recorded", result: "done",
      evidence: [{ ref: "coverage-e", path: "coverage.txt", description: "Fixture coverage evidence independent of the finding" }],
      facts: [{ ref: "coverage-f", description: "Remaining fixture coverage observed", evidenceRefs: ["coverage-e"] }],
    }, usage);
    const evidence = board.evidence.find(item => !board.findings[0].evidenceIds.includes(item.id))!;
    const archived = path.join(store.dataDir, evidence.path);
    if (damage === "changed") writeFileSync(archived, "tampered coverage evidence");
    else rmSync(archived);
    const decision = completeGoal(store);
    const rootFact = board.facts.find(fact => fact.evidenceIds.includes(evidence.id))!;
    decision.updateGoals![0].factIds = [rootFact.id];
    expect(() => runDecision(store, decision, "metacog")).toThrow(damage === "changed" ? /Evidence changed/ : /ENOENT/);
    expect(store.snapshot()).toMatchObject({ outcome: null, goals: [{ id: "G0", status: "active", factIds: [] }] });
    expect(store.snapshot().findings[0].status).toBe("impact_verified");
  });

  it("keeps the whole unfinished goal tree active when input is missing", () => {
    const store = openStore();
    produceHit(store);
    runDecision(store, { summary: "Missing fixture account blocks remaining coverage", goals: [{ id: "G1", parentId: "G0", description: "Await second fixture account" }] });
    const board = runDecision(store, { summary: "Missing fixture identity", conclusion: { outcome: "NEED_INPUT", reason: "User must supply second fixture account" } }, "metacog");
    expect(board).toMatchObject({ status: "paused", outcome: "NEED_INPUT" });
    expect(board.goals.every(goal => goal.status === "active")).toBe(true);
    expect(board.findings[0]).toMatchObject({ status: "technical_hit", rating: "unrated" });
  });
});

describe("single controller and restart recovery", () => {
  it.each(["satisfied", "abandoned"] as const)("reopens a legacy %s root once without losing state or replaying steps", (rootStatus) => {
    const store = openStore();
    produceHit(store);
    store.setStatus("paused", "Original legacy pause reason");
    const previous = legacyFixture(store, board => {
      board.goals[0].status = rootStatus;
      board.goals[0].factIds = board.facts.map(fact => fact.id);
    });
    const recovered = openStore(store.workspace);
    const board = recovered.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: previous.completedSteps, noProgressCount: previous.noProgressCount });
    expect(board.goals[0]).toEqual({ ...previous.goals[0], status: "active" });
    for (const field of ["steps", "evidence", "facts", "findings", "usage", "elapsedMs"] as const) expect(board[field]).toEqual(previous[field]);
    expect(board.reason).toMatch(/Legacy inactive root Goal reopened/);
    const events = recovered.events().filter(event => event.kind === "legacy_goal_recovered");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ prior: { status: previous.status, outcome: previous.outcome, rootStatus, reason: previous.reason } });
    const runs = recovered.runs();
    recovered.close();
    const reopened = openStore(store.workspace);
    expect(reopened.snapshot()).toEqual(board);
    expect(reopened.events().filter(event => event.kind === "legacy_goal_recovered")).toHaveLength(1);
    expect(reopened.runs()).toEqual(runs);
  });

  it("allows /start to plan again after reopening an abandoned legacy root", async () => {
    const store = openStore();
    legacyFixture(store, board => { board.goals[0].status = "abandoned"; board.status = "paused"; });
    const recovered = openStore(store.workspace);
    const modes: Mode[] = [];
    const controller = new LoopController(recovered, {
      async run(request) {
        modes.push(request.mode);
        expect(request.snapshot.goals[0].status).toBe("active");
        return {
          output: request.mode === "decide" ? { summary: "Fresh planning accepted", goals: [{ id: "G-resumed", parentId: "G0", description: "Reassess remaining fixture work" }] } : { summary: "Fixture stops before execution" },
          usage,
        };
      },
    });
    await controller.start();
    expect(modes).toEqual(["decide", "metacog"]);
    expect(recovered.snapshot().goals).toContainEqual({ id: "G-resumed", parentId: "G0", description: "Reassess remaining fixture work", status: "active", factIds: [] });
    expect(recovered.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0 });
  });

  it.each(["active", "abandoned"] as const)("requires fresh review of legacy completion with a %s root and never starts execution on open", (rootStatus) => {
    const store = openStore();
    produceHit(store);
    runDecision(store, verifiedDecision(store));
    const previous = legacyFixture(store, board => {
      board.status = "completed";
      board.outcome = "VULN_FOUND";
      board.reason = "Legacy finding-only completion";
      board.goals[0].status = rootStatus;
    });
    const recovered = openStore(store.workspace);
    const board = recovered.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: previous.completedSteps, goals: [{ id: "G0", status: "active" }] });
    expect(board.reason).toMatch(/Legacy completion requires a fresh Goal review/);
    expect(board.reason).toContain("/start");
    expect(board.findings).toEqual(previous.findings);
    expect(board.facts).toEqual(previous.facts);
    expect(board.evidence).toEqual(previous.evidence);
    expect(board.steps).toEqual(previous.steps);
    expect(recovered.runs().every(run => run.status === "completed")).toBe(true);
    expect(recovered.runs()).toHaveLength(3);
    const event = recovered.events().find(event => event.kind === "legacy_goal_recovered")!;
    expect(JSON.parse(event.payload)).toEqual({ prior: { status: "completed", outcome: "VULN_FOUND", rootStatus, reason: previous.reason } });
    recovered.close();
    expect(openStore(store.workspace).snapshot()).toEqual(board);
  });

  it("preserves an already valid completed and satisfied root unchanged", () => {
    const store = openStore();
    produceHit(store);
    const completed = runDecision(store, { ...verifiedDecision(store), ...completeGoal(store) }, "metacog");
    const events = store.events();
    store.close();
    const reopened = openStore(store.workspace);
    expect(reopened.snapshot()).toEqual(completed);
    expect(reopened.events()).toEqual(events);
  });

  it.each(["missing", "not a root"])("does not guess a legacy repair when G0 is %s", (form) => {
    const store = openStore();
    const previous = legacyFixture(store, board => {
      board.status = "completed";
      board.outcome = "VULN_FOUND";
      if (form === "missing") board.goals = [];
      else board.goals[0].parentId = "unknown-parent";
    });
    const reopened = openStore(store.workspace);
    expect(reopened.snapshot()).toEqual(previous);
    expect(reopened.events().some(event => event.kind === "legacy_goal_recovered")).toBe(false);
  });

  it("refuses a second writer, preserving the first lock and database", () => {
    const store = openStore();
    const lock = path.join(store.dataDir, "controller.lock");
    const lockContents = readFileSync(lock, "utf8");
    expect(() => openStore(store.workspace)).toThrow(/Another controller owns/);
    expect(readFileSync(lock, "utf8")).toBe(lockContents);
    expect(store.hint("Still owned by first controller").hints).toHaveLength(1);
    store.close();
    expect(existsSync(lock)).toBe(false);
    expect(openStore(store.workspace).snapshot().hints).toHaveLength(1);
  });

  it("recovers interrupted Execute as failed and never restores its ready status", () => {
    const store = openStore();
    const { runId, step } = claimStep(store);
    expect(store.snapshot().steps[0]).toMatchObject({ status: "claimed", attempts: 1, runId });
    store.close();
    const recovered = openStore(store.workspace);
    const board = recovered.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 0, outcome: null });
    expect(board.steps.find(item => item.id === step.id)).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(board.steps[0].result).toMatch(/side effects may have occurred/i);
    expect(recovered.runs().find(run => run.id === runId)?.status).toBe("interrupted");
    recovered.setStatus("running", "Inspect before continuing");
    expect(() => recovered.beginRun(nextRun(), "execute", step.id)).toThrow(/not ready/);
    const dedup = runDecision(recovered, { summary: "Same work must not automatically replay", steps: [{ goalId: "G0", from: [], description: step.description, successSignal: step.successSignal, evidencePlan: step.evidencePlan, priority: step.priority }] });
    expect(dedup.steps).toHaveLength(1);
    expect(dedup.steps[0].status).toBe("failed");
  });

  it.each([null, 180])("preserves elapsed time and a valid lease across interrupted recovery with run timeout %s", stepTimeoutSeconds => {
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const config = defaultConfig("Validate local test fixtures");
      config.limits.stepTimeoutSeconds = stepTimeoutSeconds;
      const store = new BlackboardStore(workspace(), config);
      stores.push(store);
      const { runId, step } = claimStep(store);
      expect(store.snapshot().steps.find(item => item.id === step.id)?.leaseUntil).toBe(stepTimeoutSeconds === null ? null : start + 180_000);
      store.close();
      now += 10 * 60_000;
      const recovered = new BlackboardStore(store.workspace, config);
      stores.push(recovered);
      const board = recovered.snapshot();
      expect(board.elapsedMs).toBe(stepTimeoutSeconds === null ? 600_000 : 180_000);
      expect(Number.isFinite(board.elapsedMs)).toBe(true);
      expect(board.steps.find(item => item.id === step.id)).toMatchObject({ status: "failed", leaseUntil: null, attempts: 1 });
      expect(recovered.runs().find(run => run.id === runId)?.status).toBe("interrupted");
    } finally { clock.mockRestore(); }
  });

  it("does not overwrite user-owned state/blackboard.md and records projection failure", () => {
    const root = workspace();
    mkdirSync(path.join(root, "state"));
    const projection = path.join(projectDirectory(root), "blackboard.md");
    const original = "# Existing user research\nDo not overwrite this file.\n";
    mkdirSync(path.dirname(projection), { recursive: true });
    writeFileSync(projection, original);
    const store = openStore(root);
    expect(store.projectionError).toMatch(/Preserving existing/);
    store.hint("This state still commits to SQLite");
    expect(readFileSync(projection, "utf8")).toBe(original);
    expect(store.snapshot().hints).toHaveLength(1);
  });

  it("rejects a different goal without destroying state or retaining its failed-constructor lock", () => {
    const store = openStore();
    store.hint("Preserve this task");
    store.close();
    expect(() => new BlackboardStore(store.workspace, defaultConfig("A different task"))).toThrow(/different goal\/scope/);
    expect(existsSync(path.join(store.dataDir, "controller.lock"))).toBe(false);
    expect(openStore(store.workspace).snapshot().hints[0].content).toBe("Preserve this task");
  });
});
