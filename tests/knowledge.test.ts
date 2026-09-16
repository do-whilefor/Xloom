import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { capabilityIssues, chainIssues, knowledgeChanges, validateKnowledgeSubmission } from "../src/knowledge/model.js";
import { discoverKnowledge } from "../src/knowledge/discovery.js";
import { knowledgeContext } from "../src/knowledge/context.js";
import { compareConditions, conditionsSchema, type CapabilityProposal, type ChainProposal, type Conditions } from "../src/knowledge/schema.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";
import { wikiIssues } from "../src/wiki/model.js";
import { wikiFilename } from "../src/wiki/format.js";
import { runLocal } from "../src/wiki/local.js";
import { auditWiki } from "../src/wiki/audit.js";
import { defaultLoopPolicy } from "../src/loop/policy.js";
import type { Execution, RunRequest } from "../src/types.js";

const opened: { root: string; store: BlackboardStore }[] = [];
const usage = { input: 2, output: 1, cost: 0 };
const conditions: Conditions = { scope: "synthetic", identity: "account-a", environment: "lab", stateVersion: "session-1" };
const port = (type: string) => ({ type, aliases: [], description: `Synthetic ${type}` });
function capability(id: string, provides: string[], needs: string[] = [], override: Partial<CapabilityProposal> = {}): CapabilityProposal {
  return { id, title: `Synthetic ${id}`, status: "available", provides: provides.map(port), needs: needs.map(port), conditions: { ...conditions }, factRefs: ["source"], counterFactRefs: [], changeReason: "Synthetic observation", ...override };
}
function chain(override: Partial<ChainProposal> = {}): ChainProposal {
  return { id: "CH-flow", title: "Synthetic export download flow", status: "verified", capabilityIds: ["C-export", "C-download"], conditions: { ...conditions },
    links: [{ producerId: "C-export", consumerId: "C-download", provideIndex: 0, needIndex: 0, status: "verified", factRefs: ["consumption"], conditions: { ...conditions }, note: "Synthetic fixture explicitly records consumption" }],
    result: "Synthetic final result recorded", resultFactRefs: ["result"], counterFactRefs: [], changeReason: "Synthetic test", ...override };
}
function begin(store: BlackboardStore, run = "run") {
  store.setStatus("running", "Synthetic test only"); store.beginRun(`plan-${run}`, "decide");
  store.applyDecision(`plan-${run}`, { summary: "Plan fixture", steps: [{ goalId: "G0", from: [], description: `Synthetic ${run}`, successSignal: "Recorded fixture", evidencePlan: "Local original", priority: 1 }] }, usage);
  const step = store.snapshot().steps.at(-1)!; store.beginRun(run, "execute", step.id);
  const directory = join(store.dataDir, "runs", run, "artifacts"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "original.txt"), `SYNTHETIC ONLY ${run}: export recorded, token consumed, final result observed. No target contacted.`);
  return step;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-knowledge-"));
  const store = new BlackboardStore(root, defaultConfig("Synthetic knowledge fixture"), { taskId: "task-knowledge" }); opened.push({ root, store }); begin(store); return { root, store };
}
function execution(extra: Partial<Execution> = {}): Execution {
  return { summary: "Synthetic recorded facts", result: "done", evidence: [{ ref: "e", path: "original.txt", description: "Local synthetic original" }],
    facts: ["source", "consumption", "result"].map(ref => ({ ref, description: `Synthetic ${ref} observation`, evidenceRefs: ["e"] })),
    capabilities: [capability("C-export", ["job-id"]), capability("C-download", ["download"], ["job-id"])], chains: [chain()],
    wikiPages: [{ id: "WK-flow", title: "Synthetic flow explanation", blocks: [{ id: "B-flow", title: "Observed connection", text: "This fixture demonstrates software contracts only, not a real vulnerability.", sources: [{ kind: "chain", id: "CH-flow" }] }] }], ...extra };
}
afterEach(() => { for (const { root, store } of opened.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });

describe("native capability and chain records", () => {
  it("commits same-batch references, Wiki and RAG sources in SQLite and restores them with consistent projections", () => {
    const { root, store } = fixture(); const output = execution();
    expect(() => validateKnowledgeSubmission(store.snapshot(), output)).not.toThrow();
    store.applyExecution("run", output, usage);
    const board = store.snapshot(), cap = board.capabilities![0]!, savedChain = board.chains![0]!;
    expect(cap.factIds).toEqual([board.facts[0]!.id]); expect(cap.basis.some(ref => ref.kind === "evidence")).toBe(true);
    expect(savedChain.links[0]!.factIds).toEqual([board.facts[1]!.id]); expect(chainIssues(board, savedChain)).toEqual([]);
    expect(wikiIssues(board, board.wikiPages![0]!)).toEqual([]);
    const result = retrieveWiki(board, store.dataDir, root, "", { anchors: [{ kind: "chain", id: savedChain.id }] });
    expect(result.hits).toContainEqual({ ref: { kind: "chain", id: savedChain.id }, reason: "exact_reference" });
    expect(JSON.stringify(result.records)).toContain(board.evidence[0]!.sha256);
    expect(JSON.stringify(result)).not.toContain("pending-archive");
    expect(board.goals[0]!.status).toBe("active"); expect(board.findings).toEqual([]);
    store.close();
    const reopened = new BlackboardStore(root, board.config, { taskId: "task-knowledge" }); opened.find(item => item.store === store)!.store = reopened;
    expect(reopened.snapshot().capabilities).toEqual(board.capabilities);
    expect(reopened.snapshot().chains).toEqual(board.chains);
    expect(auditWiki(reopened.snapshot(), reopened.dataDir, root).status).toBe("consistent");
  });

  it.each(["consumption", "result", "unknown", "conflict", "prerequisite", "cycle", "port", "reference", "duplicate"])("rejects invalid %s with no partial state or usage commit", problem => {
    const { store } = fixture(); const output = execution(); const link = output.chains![0]!.links[0]!;
    if (problem === "consumption") link.factRefs = [];
    if (problem === "result") output.chains![0]!.resultFactRefs = [];
    if (problem === "unknown") link.conditions.identity = null;
    if (problem === "conflict") output.capabilities![1]!.conditions.environment = "other";
    if (problem === "prerequisite") output.capabilities![1]!.needs.push(port("another-required-input"));
    if (problem === "cycle") output.chains![0]!.capabilityIds.reverse();
    if (problem === "port") link.provideIndex = 9;
    if (problem === "reference") output.capabilities![0]!.factRefs = ["missing-fact"];
    if (problem === "duplicate") output.chains![0]!.links.push(structuredClone(link));
    const before = store.snapshot(), events = store.events();
    expect(() => store.applyExecutionCheckpoint("run", "invalid", output, usage)).toThrow();
    expect(store.snapshot()).toEqual(before); expect(store.events()).toEqual(events);
  });

  it("keeps checkpoint replay idempotent and does not treat knowledge-only changes as evidence progress", () => {
    const { store } = fixture(); const output = execution(); store.applyExecutionCheckpoint("run", "checkpoint", output, usage);
    const committed = store.snapshot(); store.applyExecutionCheckpoint("run", "checkpoint", output, usage);
    expect(store.snapshot()).toEqual(committed);
    store.applyExecution("run", { summary: "Finish", result: "done" }, usage);
    const cap = structuredClone(store.snapshot().capabilities![0]!); begin(store, "organize"); const before = store.snapshot();
    store.applyExecution("organize", { summary: "Reword capability without a new experiment", result: "done", capabilities: [capability(cap.id, ["job-id"], [], { factRefs: cap.factIds, title: "Reworded capability", changeReason: "Clarify wording" })] }, usage);
    const after = store.snapshot(); expect(after.noProgressCount).toBe(before.noProgressCount + 1);
    expect(after.capabilities![0]!.history).toHaveLength(1); expect(after.chains![0]!.status).toBe("verified");
    expect(chainIssues(after, after.chains![0]!)).toContain("source_changed");
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, after.steps.at(-1)!.id)?.kind).toBe("knowledge_change");
  });

  it("propagates source corrections through capabilities, chains, Wiki and retrieval without changing historical observations", () => {
    const { store, root } = fixture(); store.applyExecution("run", execution(), usage); const before = store.snapshot();
    begin(store, "correction"); store.applyExecution("correction", execution({ facts: [{ ref: "replacement", description: "Synthetic capability revoked in a later observation", evidenceRefs: ["e"], supersedes: before.facts[0]!.id }], capabilities: [], chains: [], wikiPages: [] }), usage);
    const after = store.snapshot();
    expect(after.capabilities).toEqual(before.capabilities); expect(after.chains).toEqual(before.chains);
    expect(capabilityIssues(after, after.capabilities![0]!)).toContain("source_replaced");
    expect(chainIssues(after, after.chains![0]!)).toContain("source_changed");
    expect(wikiIssues(after, after.wikiPages![0]!).length).toBeGreaterThan(0);
    expect(knowledgeChanges(before, after).capabilityIds).toEqual(["C-export", "C-download"]);
    expect(readFileSync(join(store.dataDir, "wiki", "index.md"), "utf8")).toContain("待复核；原声明 verified");
    expect(discoverKnowledge(after).items[0]!.plan).toBeNull();
    const found = retrieveWiki(after, store.dataDir, root, "", { anchors: [{ kind: "capability", id: "C-export" }] });
    expect(JSON.stringify(found.records)).toContain("review_required");
    const board = store.snapshot(); runLocal(["discover", "--task", store.dataDir, "--workspace", root]); expect(store.snapshot()).toEqual(board);
  });

  it("reuses unchanged capability declarations without creating a revision", () => {
    const { store } = fixture(); store.applyExecution("run", execution(), usage); const cap = store.snapshot().capabilities![0]!;
    begin(store, "repeat"); store.applyExecution("repeat", { summary: "Same declaration", result: "no_progress", capabilities: [capability(cap.id, ["job-id"], [], { factRefs: cap.factIds })] }, usage);
    expect(store.snapshot().capabilities![0]).toEqual(cap);
  });
});

describe("whole-plan candidate discovery", () => {
  function withCapabilities(capabilities: CapabilityProposal[]) {
    const fixtureValue = fixture(); fixtureValue.store.applyExecution("run", execution({ capabilities, chains: [], wikiPages: [] }), usage); return fixtureValue;
  }
  it("backtracks across AND inputs to find compatible OR providers and preserves unknown conditions", () => {
    const { store } = withCapabilities([
      capability("C-a1", ["x"], [], { conditions: { ...conditions, environment: "v1" } }),
      capability("C-a2", ["x"], [], { conditions: { ...conditions, environment: "v2" } }),
      capability("C-b", ["y"], [], { conditions: { ...conditions, environment: "v2" } }),
      capability("C-consumer", ["result"], ["x", "y"], { conditions: { ...conditions, environment: null }, status: "candidate" }),
    ]);
    const result = discoverKnowledge(store.snapshot()); const plan = result.items[0]!.plan!;
    expect(result.evidence).toBe(false); expect(plan.capabilityIds).toEqual(["C-a2", "C-b", "C-consumer"]);
    expect(plan.conditions).toMatchObject({ status: "unknown", unknown: ["environment"], conflicts: [] });
    expect(plan.unverifiedCapabilityIds).toEqual(["C-consumer"]); expect(plan.actualConsumption).toBe("not_assessed");
    expect(result.items[0]!.inputs[0]!.alternatives).toHaveLength(2);
  });
  it("does not confuse pairwise input matches with a jointly possible plan", () => {
    const { store } = withCapabilities([
      capability("C-a", ["x"], [], { conditions: { ...conditions, environment: "v1" } }),
      capability("C-b", ["y"], [], { conditions: { ...conditions, environment: "v2" } }),
      capability("C-c", ["result"], ["x", "y"], { conditions: { ...conditions, environment: null } }),
    ]);
    const item = discoverKnowledge(store.snapshot()).items[0]!;
    expect(item.inputs.every(input => input.alternatives.length)).toBe(true); expect(item.plan).toBeNull();
  });
  it.each(["missing", "cycle", "unavailable"])("does not omit a producer's %s prerequisite", problem => {
    const producer = capability("C-a", ["x"], problem === "missing" ? ["absent"] : problem === "cycle" ? ["result"] : [], problem === "unavailable" ? { status: "unavailable" } : {});
    const { store } = withCapabilities([producer, capability("C-b", ["result"], ["x"])]);
    expect(discoverKnowledge(store.snapshot()).items.find(item => item.consumerId === "C-b")!.plan).toBeNull();
  });
  it("shares a provider across inputs without inventing a dependency between parallel branches", () => {
    const { store } = withCapabilities([capability("C-root", ["x", "y"]), capability("C-final", ["result"], ["x", "y"])]);
    const plan = discoverKnowledge(store.snapshot()).items[0]!.plan!;
    expect(plan.capabilityIds).toEqual(["C-root", "C-final"]); expect(plan.links).toHaveLength(2);
    expect(plan.links.every(link => link.producerId === "C-root" && link.consumerId === "C-final")).toBe(true);
  });
  it("uses explicit aliases, not similar words, and reports search/packing limits", () => {
    const { store } = withCapabilities([
      capability("C-source", ["jobIdentifier"], [], { provides: [{ type: "jobIdentifier", aliases: ["job-id"], description: "Explicit alias" }] }),
      capability("C-consumer", ["result"], ["job-id"]), capability("C-similar", ["result"], ["job-identifier-nearly"]),
    ]);
    const result = discoverKnowledge(store.snapshot());
    expect(result.items.find(item => item.consumerId === "C-consumer")!.plan).not.toBeNull();
    expect(result.items.find(item => item.consumerId === "C-similar")!.plan).toBeNull();
    expect(discoverKnowledge(store.snapshot(), { maxStates: 1 }).searchTruncated).toBe(true);
    expect(discoverKnowledge(store.snapshot(), { limit: 1 }).omittedConsumerIds).toHaveLength(1);
    const request = { id: "fresh", mode: "decide", snapshot: store.snapshot(), workspace: store.workspace, runDir: join(store.dataDir, "runs", "fresh"), blackboardPath: store.projectionPath } as RunRequest;
    const context = knowledgeContext(request)!;
    expect(context.local).toBeUndefined(); expect(context.authoringGuide).toContain("resources");
    const name = wikiFilename("capability", "C-source"); expect(readFileSync(join(store.dataDir, "wiki", "pages", name), "utf8")).toContain("Explicit alias");
  });
  it("does not equate unknown identity with a known identity or case-fold identity values", () => {
    expect(compareConditions([conditions, { ...conditions, identity: null }]).status).toBe("unknown");
    expect(compareConditions([conditions, { ...conditions, identity: "ACCOUNT-A" }]).status).toBe("conflict");
  });
  it.each([null, "", "  ", "unknown", " UNKNOWN ", "ｕｎｋｎｏｗｎ", "unspecified", "not_recorded", "not recorded", "未知", "未记录", "未确认"])("preserves unknown conditions for new and historical records: %s", value => {
    for (const key of ["scope", "identity", "environment", "stateVersion"] as const) {
      const unknown = { ...conditions, [key]: value };
      expect(conditionsSchema.parse(unknown)[key]).toBeNull();
      expect(compareConditions([unknown, unknown])).toEqual({ status: "unknown", conflicts: [], unknown: [key] });
      expect(compareConditions([unknown, conditions])).toEqual({ status: "unknown", conflicts: [], unknown: [key] });
    }
    expect(compareConditions([conditions, conditions]).status).toBe("compatible");
  });
  it("does not treat not-applicable labels as unknown or wildcard conditions", () => {
    expect(compareConditions([{ ...conditions, identity: "not_applicable" }, conditions]).status).toBe("conflict");
    expect(conditionsSchema.parse({ ...conditions, identity: "UnknownUser" }).identity).toBe("UnknownUser");
  });
  it("keeps legacy unknown providers unverified and rejects unknown verified chains atomically", () => {
    const { store } = withCapabilities([capability("C-export", ["job-id"]), capability("C-download", ["download"], ["job-id"])]);
    const board = store.snapshot();
    for (const cap of board.capabilities!) cap.conditions.identity = "unknown";
    expect(discoverKnowledge(board).items[0]!.plan!.conditions).toEqual({ status: "unknown", conflicts: [], unknown: ["identity"] });
    begin(store, "unknown-chain");
    const output = execution();
    for (const cap of output.capabilities!) cap.conditions.identity = "unknown";
    output.chains![0]!.conditions.identity = "unknown";
    output.chains![0]!.links[0]!.conditions.identity = "unknown";
    const before = store.snapshot(), events = store.events();
    expect(() => validateKnowledgeSubmission(before, output)).toThrow("known, jointly compatible");
    expect(() => store.applyExecutionCheckpoint("unknown-chain", "invalid-unknown", output, usage)).toThrow("known, jointly compatible");
    expect(store.snapshot()).toEqual(before); expect(store.events()).toEqual(events);
  });
});
