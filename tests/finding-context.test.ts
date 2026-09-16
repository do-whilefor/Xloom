import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { projectContext } from "../src/loop/context.js";
import { validateDecisionReferences } from "../src/loop/references.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { renderBlackboard } from "../src/store.js";
import type { Attempt, Evidence, Fact, Finding, RunRequest, Step } from "../src/types.js";

const step = (id: string, from: string[] = []): Step => ({ id, goalId: "G0", from, description: "Fixture", successSignal: "Observed control",
  evidencePlan: "Retain fixture", priority: 1, status: "done", attempts: 1, runId: "PRIVATE_RUN", leaseUntil: 123 });
const evidence = (id: string, stepId: string): Evidence => ({ id, stepId, path: `evidence/${id}.bin`, pathBase: "task",
  sha256: "a".repeat(64), bytes: 100, description: "Synthetic fixture", runId: "PRIVATE_RUN", excerpt: "raw fixture" });
const fact = (id: string, stepId: string, evidenceIds: string[]): Fact => ({ id, stepId, evidenceIds, description: `Observed synthetic ${id}` });
const finding = (id: string, factIds: string[], evidenceIds: string[]): Finding => ({ id, key: `key-${id}`, factIds, evidenceIds,
  title: "Same title is not a relationship", target: "same fixture label", status: "technical_hit", rating: "unrated", next: "Inspect prerequisite" });
const attempt = (id: string, stepId: string, hypothesis: string, evidenceIds: string[]): Attempt => ({ id, stepId, hypothesis, evidenceIds,
  scope: "tenant B", identity: "bob", stateVersion: "v2", baseline: "valid normal request", changedVariable: "object", outcome: "refutes",
  observation: "Synthetic denial", conditionKey: "PRIVATE_CONDITION", outcomeKey: "PRIVATE_OUTCOME", runId: "PRIVATE_RUN" });

function request(mode: RunRequest["mode"] = "execute"): RunRequest {
  const workspace = resolve("synthetic-finding-workspace");
  const current = { ...step("CURRENT", ["F0"]), status: "claimed" as const };
  return { id: "fixture", mode, workspace, runDir: join(workspace, "task", "runs", "current"),
    blackboardPath: join(workspace, "task", "blackboard.md"), step: current, signal: new AbortController().signal, onEvent() {},
    snapshot: { revision: 10, config: defaultConfig("Synthetic evidence navigation"), status: "running", outcome: null, reason: "",
      goals: [{ id: "G0", description: "Fixture", parentId: null, status: "active", factIds: [] }],
      steps: [step("S0"), step("S1"), step("S2"), step("S3"), current],
      facts: [0, 1, 2, 3].map(i => fact(`F${i}`, `S${i}`, [`E${i}`])),
      evidence: [0, 1, 2, 3].map(i => evidence(`E${i}`, `S${i}`)),
      findings: [finding("V0", ["F0", "F1"], ["E0", "E1"]), finding("Vpeer", ["F1", "F2"], ["E1", "E2"]), finding("Vunrelated", ["F3"], ["E3"])],
      hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 1, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
    },
  };
}
const view = (input: RunRequest) => projectContext(input).findingContext!;

describe("Finding evidence navigation", () => {
  it("gives reviewers exact attached PoC choices, keeping related and missing evidence out", () => {
    const input = request("metacog");
    input.snapshot.findings[0].pocEvidenceId = "E0";
    const original = structuredClone(input.snapshot);
    expect(view(input).items.find(item => item.findingId === "V0")!.reviewEvidence).toEqual({ attachedIds: ["E0", "E1"], recordedPocId: "E0" });
    expect(input.snapshot).toEqual(original);
    input.snapshot.evidence = input.snapshot.evidence.filter(item => item.id !== "E0");
    expect(view(input).items.find(item => item.findingId === "V0")!.reviewEvidence).toEqual({ attachedIds: ["E1"] });
    expect(view({ ...input, mode: "execute" }).items[0].reviewEvidence).toBeUndefined();
  });

  it("separates linked support from one-hop candidates and supplies original artifact locators", () => {
    const input = request();
    const original = structuredClone(input.snapshot);
    const context = projectContext(input);
    expect(context.findings.map(item => item.id)).toEqual(["V0"]);
    expect(context.findingContext!.items.map(item => item.findingId)).toEqual(["V0"]);
    expect(context.findings[0]!.evidenceIds).toEqual(["E0", "E1"]);
    expect(context.findingContext!.items[0]!.related).toContainEqual({ kind: "shared_finding", id: "Vpeer", via: { factId: "F1" },
      candidateFactIds: ["F2"], candidateEvidenceIds: ["E2"] });
    expect(context.findingContext!.facts.map(item => item.id)).toEqual(["F2"]);
    expect(context.findingContext!.evidence).toEqual([{ id: "E2", path: join(input.workspace, "task", "evidence", "E2.bin"), sha256: "a".repeat(64), bytes: 100 }]);
    expect(JSON.stringify(context.findingContext)).not.toContain("Vunrelated");
    expect(() => validateDecisionReferences(input.snapshot, { summary: "Cannot promote a candidate", reviews: [
      { findingId: "V0", status: "impact_verified", rating: "info", reason: "Synthetic", pocEvidenceId: "E2" },
    ] })).toThrow("must belong to Finding");
    expect(input.snapshot).toEqual(original);
  });

  it("does not expand shared Findings transitively or match titles, targets or method names", () => {
    const input = request();
    input.snapshot.findings.push(finding("Vtransitive", ["F2", "F3"], ["E2", "E3"]));
    for (const item of input.snapshot.steps) item.methodIds = ["baseline-authz"];
    const data = view(input);
    expect(data.items[0]!.related.map(item => item.id)).toEqual(["Vpeer"]);
    expect(data.evidence.map(item => item.id)).toEqual(["E2"]);
    expect(JSON.stringify(data)).not.toContain("Vtransitive");
  });

  it("locates unlinked outputs from source Steps and Steps that explicitly reference a linked Fact", () => {
    const input = request();
    input.snapshot.findings = [input.snapshot.findings[0]!];
    input.snapshot.steps.push(step("LATER", ["F0"]));
    input.snapshot.facts.push(fact("F-later", "LATER", ["E-later"]), fact("F-sibling", "S0", ["E-sibling"]));
    input.snapshot.evidence.push(evidence("E-later", "LATER"), evidence("E-sibling", "S0"));
    expect(view(input).items[0]!.related).toEqual([
      { kind: "referencing_step", id: "LATER", via: { factId: "F0" }, candidateFactIds: ["F-later"], candidateEvidenceIds: ["E-later"] },
      { kind: "source_step", id: "S0", via: { evidenceId: "E0" }, candidateFactIds: ["F-sibling"], candidateEvidenceIds: ["E-sibling"] },
    ]);
  });

  it("preserves multi-hop revisions and terminates cycles without rewriting attached support", () => {
    const input = request();
    input.snapshot.facts.push({ ...fact("R1", "S2", ["E2"]), supersedes: "F0" }, { ...fact("R2", "S3", ["E3"]), supersedes: "R1" });
    input.snapshot.facts[0]!.supersedes = "R2";
    const data = view(input).items.find(item => item.findingId === "V0")!;
    expect(data.revisions).toHaveLength(3);
    expect(data.revisions).toEqual(expect.arrayContaining([{ previous: "F0", replacement: "R1" }, { previous: "R1", replacement: "R2" }, { previous: "R2", replacement: "F0" }]));
    expect(input.snapshot.findings[0]!.factIds).toEqual(["F0", "F1"]);
    expect(input.snapshot.findings[0]!.status).toBe("technical_hit");
  });

  it("shows declared counterevidence and recorded attempts with their original conditions", () => {
    const input = request();
    input.snapshot.steps[0]!.combination = { requires: ["F1"], scope: "tenant A", stateVersion: "v1", missing: ["consumer acceptance"], expectedCapability: "Fixture", counterEvidence: ["F3"] };
    input.snapshot.attempts = [attempt("A-other-state", "S2", "key-V0", ["E2"]), attempt("A-unrelated", "S2", "something else", ["E2"])];
    const context = projectContext(input);
    const data = context.findingContext!;
    const item = data.items.find(item => item.findingId === "V0")!;
    expect(item.conditions).toEqual([{ stepId: "S0", scope: "tenant A", stateVersion: "v1", missing: ["consumer acceptance"], declaredCounterEvidence: ["F3"] }]);
    expect(item.attempts).toEqual([{ id: "A-other-state", via: "hypothesis_key" }]);
    expect([...context.attempts, ...data.attempts]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "A-other-state", scope: "tenant B", identity: "bob", stateVersion: "v2", outcome: "refutes", evidenceIds: ["E2"] }),
    ]));
    expect(data.notice).toContain("need scope/identity/state review");
    expect(input.snapshot.findings[0]!.status).toBe("technical_hit");
  });

  it("excludes an unrelated Step's Attempt that reuses the same Evidence bytes", () => {
    const input = request();
    input.snapshot.attempts = [attempt("A-unrelated", "S2", "independent-hypothesis", ["E0"])];
    const item = view(input).items.find(item => item.findingId === "V0")!;
    expect(item.attempts).toEqual([]);
    expect(item.unrecorded).toContain("structured_attempts");
  });

  it("locates an Attempt through a linked Fact's producing Step and Evidence", () => {
    const input = request();
    input.snapshot.findings[0]!.evidenceIds = [];
    input.snapshot.attempts = [attempt("A-source", "S0", "supporting-control", ["E0"])];
    expect(view(input).items.find(item => item.findingId === "V0")!.attempts).toEqual([{ id: "A-source", via: "linked_fact" }]);
    expect(input.snapshot.findings[0]!.evidenceIds).toEqual([]);
  });

  it("includes Attempts behind a causal Fact prerequisite without linking shared-byte experiments", () => {
    const input = request();
    input.snapshot.steps[0]!.from = ["F3"];
    input.snapshot.attempts = [attempt("A-prerequisite", "S3", "prerequisite-control", ["E3"]),
      attempt("A-unrelated", "S2", "independent-hypothesis", ["E0"])];
    expect(view(input).items.find(item => item.findingId === "V0")!.attempts).toEqual([{ id: "A-prerequisite", via: "linked_fact" }]);
  });

  it("matches normalized hypotheses across Steps for Evidence-only Findings", () => {
    const input = request("metacog");
    input.snapshot.findings = [finding("V0", [], ["E0"])];
    input.snapshot.findings[0]!.key = "key v0";
    input.snapshot.attempts = [attempt("A-shared-bytes", "S0", "independent-hypothesis", ["E0"]),
      attempt("A-hypothesis", "S2", "  KEY   V0 \n", ["E2"])];
    expect(view(input).items[0]!.attempts).toEqual([{ id: "A-hypothesis", via: "hypothesis_key" }]);
  });

  it("retains cross-Step contrary Attempts under the linked Fact's recorded conditions", () => {
    const input = request();
    input.snapshot.attempts = [{ ...attempt("A-source", "S0", "supporting-control", ["E0"]), outcome: "supports" },
      attempt("A-contrary", "S2", "supporting-control", ["E2"])];
    expect(view(input).items.find(item => item.findingId === "V0")!.attempts).toEqual([
      { id: "A-contrary", via: "linked_fact" }, { id: "A-source", via: "linked_fact" },
    ]);
  });

  it("reports missing records and invalid PoC links without treating unrecorded controls as absent", () => {
    const input = request();
    input.snapshot.findings[0]!.factIds.push("F-missing");
    input.snapshot.findings[0]!.evidenceIds.push("E-missing");
    input.snapshot.findings[0]!.pocEvidenceId = "E3";
    input.snapshot.facts[0]!.stepId = "S-missing";
    const item = view(input).items[0]!;
    expect(item.issues).toEqual(expect.arrayContaining([{ kind: "missing_fact", id: "F-missing" }, { kind: "missing_evidence", id: "E-missing" },
      { kind: "missing_step", id: "S-missing" }, { kind: "poc_not_linked", id: "E3" }]));
    expect(item.unrecorded).toEqual(["combination_conditions", "structured_attempts"]);
    expect(view(input).notice).toContain("unrecorded/omitted do not mean absent or disproved");
  });

  it("bounds optional candidate expansion and keeps a complete readable fallback", () => {
    const input = request();
    input.snapshot.findings = [input.snapshot.findings[0]!];
    for (let i = 0; i < 8; i++) {
      const facts = [], evidenceIds = [];
      const source = `EXTRA-${i}`;
      input.snapshot.steps.push(step(source));
      for (let j = 0; j < 10; j++) {
        const fid = `F-${i}-${j}`, eid = `E-${i}-${j}`;
        facts.push(fid); evidenceIds.push(eid);
        input.snapshot.facts.push(fact(fid, source, [eid]));
        input.snapshot.evidence.push({ ...evidence(eid, source), excerpt: "LARGE_UNRELATED_BODY".repeat(1000) });
      }
      input.snapshot.findings.push(finding(`PEER-${i}`, ["F1", ...facts], ["E1", ...evidenceIds]));
    }
    const data = view(input);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.related).toHaveLength(4);
    expect(data.items[0]!.omitted).toMatchObject({ related: 4 });
    for (const related of data.items[0]!.related) expect(related).toMatchObject({ omittedFacts: 4, omittedEvidence: 4 });
    expect(data.evidence).toHaveLength(24);
    expect(JSON.stringify(data).length).toBeLessThan(15_000);
    expect(JSON.stringify(data)).not.toContain("LARGE_UNRELATED_BODY");
    const rendered = renderBlackboard(input.snapshot, join(input.workspace, "task"), input.workspace);
    const records = rendered.split("```jsonl\n")[1]!.split("\n```")[0]!.split("\n").map(line => JSON.parse(line));
    expect(records.find(record => record.id === "PEER-0").evidenceIds).toContain("E-0-9");
    expect(records.find(record => record.id === "F-0-9").stepId).toBe("EXTRA-0");
    expect(rendered).toContain(join(input.workspace, "task", "evidence", "E-0-9.bin"));
  });

  it("deduplicates supplemental indexes and excludes accidental private fields", () => {
    const input = request();
    input.snapshot.findings.push(finding("Vsecond", ["F0", "F1"], ["E0", "E1"]));
    input.snapshot.attempts = [attempt("A", "S2", "key-V0", ["E2"])];
    for (const collection of [input.snapshot.steps, input.snapshot.facts, input.snapshot.evidence, input.snapshot.findings, input.snapshot.attempts]) {
      for (const item of collection) Object.assign(item, { messages: ["PRIVATE_MESSAGE"], apiKey: "PRIVATE_KEY" });
    }
    const original = structuredClone(input.snapshot);
    const data = view(input);
    expect(data.facts.map(item => item.id)).toEqual(["F2"]);
    expect(data.evidence.map(item => item.id)).toEqual(["E2"]);
    for (const secret of ["PRIVATE_MESSAGE", "PRIVATE_KEY", "PRIVATE_RUN", "PRIVATE_CONDITION", "PRIVATE_OUTCOME", "leaseUntil", "runId"]) {
      expect(JSON.stringify(data)).not.toContain(secret);
      expect(renderBlackboard(input.snapshot, join(input.workspace, "task"), input.workspace)).not.toContain(secret);
    }
    data.facts[0]!.evidenceIds.push("changed");
    data.items[0]!.related[0]!.candidateEvidenceIds.push("changed");
    data.attempts[0]!.evidenceIds.push("changed");
    expect(input.snapshot).toEqual(original);
  });

  it("uses the effective assigned Step and preserves complete condition text", () => {
    const input = request();
    const missing = "A precisely scoped prerequisite ".repeat(30);
    input.step = { ...input.step!, combination: { requires: ["F0"], scope: "tenant A", stateVersion: "current-session",
      missing: [missing], expectedCapability: "Unverified consumer", counterEvidence: ["F3"] } };
    const item = view(input).items.find(item => item.findingId === "V0")!;
    expect(item.conditions).toContainEqual({ stepId: "CURRENT", scope: "tenant A", stateVersion: "current-session", missing: [missing], declaredCounterEvidence: ["F3"] });
    expect(input.snapshot.steps.find(step => step.id === "CURRENT")?.combination).toBeUndefined();
  });

  it("reports omitted conditions and attempts while leaving all recorded metadata in the fallback", () => {
    const input = request();
    input.snapshot.attempts = [];
    for (let i = 0; i < 6; i++) {
      const source = step(`CONDITION-${i}`, ["F0"]);
      source.combination = { requires: ["F0"], missing: [`required-${i}`], scope: `tenant-${i}`, stateVersion: `v${i}`, expectedCapability: "Fixture", counterEvidence: ["F3"] };
      input.snapshot.steps.push(source);
      input.snapshot.attempts.push(attempt(`A-${i}`, source.id, "key-V0", ["E2"]));
    }
    const item = view(input).items.find(item => item.findingId === "V0")!;
    expect(item.conditions).toHaveLength(4);
    expect(item.attempts).toHaveLength(4);
    expect(item.omitted).toMatchObject({ conditions: 2, attempts: 2 });
    const fallback = renderBlackboard(input.snapshot, join(input.workspace, "task"), input.workspace);
    for (let i = 0; i < 6; i++) {
      expect(fallback).toContain(`required-${i}`);
      expect(fallback).toContain(`A-${i}`);
    }
  });

  it.each(["decide", "execute", "metacog"] as const)("rebuilds the %s view each call and adds no guidance when there are no Findings", mode => {
    const input = request(mode);
    const initial = projectContext(input);
    expect(initial.findingContext?.items.map(item => item.findingId)).toEqual(initial.findings.map(item => item.id));
    expect(initial.findingContext).toEqual(projectContext(input).findingContext);
    const withFindings = buildRunPrompt(input);
    input.snapshot.findings = [];
    const without = buildRunPrompt(input);
    expect(without.systemPrompt).toBe(withFindings.systemPrompt);
    expect(without.userPrompt.split("\n\n")[0]).toBe(withFindings.userPrompt.split("\n\n")[0]);
    expect(JSON.parse(without.userPrompt.split("\n").at(-1)!).blackboard).not.toHaveProperty("findingContext");
  });
});
