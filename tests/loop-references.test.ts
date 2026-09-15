import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { validateDecisionReferences } from "../src/loop/references.js";
import type { BoardSnapshot, Decision, StepStatus } from "../src/types.js";

function board(): BoardSnapshot {
  return {
    revision: 1, config: defaultConfig("Synthetic reference validation"), status: "running", outcome: null, reason: "",
    goals: [{ id: "G0", description: "Synthetic fixture", parentId: null, status: "active", factIds: [] }],
    facts: [{ id: "F-fixture", description: "Synthetic observation", stepId: null, evidenceIds: ["E-fixture"] }],
    steps: [{ id: "S-fixture", goalId: "G0", from: [], description: "Synthetic check", successSignal: "Compare labels", evidencePlan: "Save fixture", priority: 1,
      status: "ready", attempts: 0, runId: null, leaseUntil: null }],
    findings: [{ id: "V-fixture", key: "fixture", target: "synthetic fixture", title: "Fixture", status: "technical_hit", rating: "unrated", factIds: ["F-fixture"], evidenceIds: ["E-fixture"], next: "Review fixture" }],
    evidence: ["E-fixture", "E-other"].map(id => ({ id, path: "synthetic.txt", sha256: "fixture", bytes: 1, description: "Synthetic artifact", runId: "r1", stepId: "S-fixture" })),
    hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
  };
}

describe("Decision reference validation", () => {
  it("requires root satisfaction and a terminal conclusion together only at the final review", () => {
    const snapshot = board(), original = structuredClone(snapshot);
    const update = { id: "G0", status: "satisfied" as const, factIds: ["F-fixture"], reason: "Fixture comparison completed" };
    const terminal: Decision["conclusion"] = { outcome: "NOT_REPRODUCED", reason: "Synthetic fixture checked" };
    const completion: Decision = { summary: "Complete fixture", updateGoals: [update], conclusion: terminal };
    expect(() => validateDecisionReferences(snapshot, completion, "metacog")).not.toThrow();
    for (const conclusion of [undefined, { outcome: "NEED_INPUT" as const, reason: "Fixture input is missing" }]) {
      expect(() => validateDecisionReferences(snapshot, { ...completion, conclusion }, "metacog")).toThrow("final conclusion in the same review");
    }
    expect(() => validateDecisionReferences(snapshot, { ...completion, updateGoals: undefined }, "metacog")).toThrow("root goal G0 to be satisfied");
    expect(() => validateDecisionReferences(snapshot, { ...completion, updateGoals: [{ ...update, status: "abandoned" }] }, "metacog")).toThrow("root goal cannot be abandoned");
    expect(() => validateDecisionReferences(snapshot, { ...completion, updateGoals: [{ ...update, factIds: [] }] }, "metacog")).toThrow("Satisfied goals require evidence-backed facts");
    // Ordinary Decide proposals still request a fresh review through the controller.
    expect(() => validateDecisionReferences(snapshot, { ...completion, conclusion: undefined }, "decide")).not.toThrow();
    expect(() => validateDecisionReferences(snapshot, { ...completion, updateGoals: undefined }, "decide")).not.toThrow();
    expect(() => validateDecisionReferences(snapshot, { summary: "Continue research" }, "metacog")).not.toThrow();
    expect(() => validateDecisionReferences(snapshot, { summary: "Waiting", conclusion: { outcome: "NEED_INPUT", reason: "Specific fixture input missing" } }, "metacog")).not.toThrow();
    expect(snapshot).toEqual(original);
  });

  it("accepts an already satisfied root and leaves child-only satisfaction compatible with NEED_INPUT", () => {
    const snapshot = board();
    snapshot.goals[0]!.status = "satisfied"; snapshot.goals[0]!.factIds = ["F-fixture"];
    expect(() => validateDecisionReferences(snapshot, { summary: "Complete fixture", conclusion: { outcome: "NOT_REPRODUCED", reason: "Fixture checked" } }, "metacog")).not.toThrow();
    snapshot.goals[0]!.status = "active";
    snapshot.goals.push({ id: "G-child", description: "Local check", parentId: "G0", status: "active", factIds: [] });
    expect(() => validateDecisionReferences(snapshot, { summary: "Child completed; root needs another input", updateGoals: [{ id: "G-child", status: "satisfied", factIds: ["F-fixture"], reason: "Child fixture checked" }],
      conclusion: { outcome: "NEED_INPUT", reason: "Specific fixture input missing" } }, "metacog")).not.toThrow();
  });

  it("diagnoses review lifecycle and reference errors together without promoting a lead", () => {
    const snapshot = board();
    snapshot.findings[0]!.status = "lead";
    const original = structuredClone(snapshot);
    const proposal: Decision = { summary: "Both logged failure families", updateSteps: [{ id: "S-truncated", action: "abandon", reason: "Fixture" }], reviews: [
      { findingId: "V-fixture", status: "closed", rating: "info", reason: "Fixture", pocEvidenceId: "E-unknown" },
      { findingId: "V-fixture", status: "impact_verified", rating: "P2", reason: "Fixture", pocEvidenceId: "E-fixture" },
    ] };
    let error: Error | undefined;
    try { validateDecisionReferences(snapshot, proposal); } catch (failure) { error = failure as Error; }
    for (const text of ["updateSteps[0].id", "reviews[0].rating", "Closed findings remain unrated", "reviews[0].pocEvidenceId", "reviews[1].status", "A lead cannot skip technical validation", "Missing: impact", "existing Finding key"]) expect(error?.message).toContain(text);
    expect(snapshot).toEqual(original);
  });

  it("retains ordered review transitions and does not infer technical validation from evidence", () => {
    const snapshot = board();
    const impact = { capability: "Fixture", object: "Fixture", result: "Fixture", scope: "Local", prerequisites: "Fixture" };
    const verify = { findingId: "V-fixture", status: "impact_verified" as const, rating: "info" as const, reason: "Fixture", impact, pocEvidenceId: "E-fixture" };
    snapshot.findings[0]!.status = "lead";
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [verify] })).toThrow('currently has status "lead"');
    snapshot.findings[0]!.status = "technical_hit";
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [verify] })).not.toThrow();
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [
      { findingId: "V-fixture", status: "closed", rating: "unrated", reason: "Fixture" }, verify,
    ] })).toThrow('currently has status "closed"');
    snapshot.findings[0]!.factIds = [];
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [
      { findingId: "V-fixture", status: "closed", rating: "unrated", reason: "Fixture" },
    ] })).toThrow("evidence-backed validation");
  });

  it("reports all reference families together without changing IDs, records or state", () => {
    const snapshot = board();
    const proposal: Decision = {
      summary: "Synthetic invalid references",
      goals: [{ id: "G-new", parentId: "G-unknown", description: "Invalid parent" }],
      steps: [{ goalId: "G-missing", from: ["F-invented"], description: "Synthetic check", successSignal: "Compare", evidencePlan: "Save", priority: 1 }],
      updateSteps: [{ id: "S-fixtur", action: "abandon", reason: "Truncated ID" }],
      updateGoals: [{ id: "G-missing", status: "satisfied", factIds: ["E-fixture"], reason: "Wrong ID family" }],
      reviews: [{ findingId: "V-missing", status: "closed", rating: "unrated", reason: "Unknown review", pocEvidenceId: "E-missing" }],
    };
    const original = structuredClone({ snapshot, proposal });
    const error = (() => { try { validateDecisionReferences(snapshot, proposal); } catch (failure) { return failure as Error; } })();
    for (const field of ["goals[0].parentId", "steps[0].goalId", "steps[0].from[0]", "updateSteps[0].id", "updateGoals[0].id", "updateGoals[0].factIds[0]", "reviews[0].findingId", "reviews[0].pocEvidenceId"]) {
      expect(error?.message).toContain(field);
    }
    expect({ snapshot, proposal }).toEqual(original);
  });

  it("aggregates conflicting Goal declarations with all other invalid references before repair", () => {
    const snapshot = board();
    snapshot.goals.push({ id: "G2", parentId: "G0", description: "Existing fixture goal", status: "active", factIds: [] });
    const proposal: Decision = {
      summary: "Conflicting Goal and incorrect Fact/Step references",
      goals: [{ id: "G2", parentId: "G0", description: "A different fixture goal" }],
      steps: [{ goalId: "G2", from: ["F-missing"], description: "Synthetic check", successSignal: "Compare", evidencePlan: "Save", priority: 1 }],
      updateSteps: [{ id: "S-missing", action: "abandon", reason: "Incorrect fixture ID" }],
    };
    const original = structuredClone({ snapshot, proposal });
    let error: Error | undefined;
    try { validateDecisionReferences(snapshot, proposal); } catch (failure) { error = failure as Error; }
    expect(error?.message).toContain("Goal G2 already exists with a different description or parent");
    for (const field of ["goals[0].id", "steps[0].from[0]", "updateSteps[0].id"]) expect(error?.message).toContain(field);
    expect({ snapshot, proposal }).toEqual(original);
  });

  it("accepts exact references and goals created earlier in the same proposal", () => {
    const proposal: Decision = {
      summary: "Synthetic reference plan",
      goals: [{ id: "G-parent", parentId: "G0", description: "New parent" }, { id: "G-child", parentId: "G-parent", description: "New child" }],
      steps: [{ goalId: "G-child", from: ["F-fixture"], description: "Synthetic comparison", successSignal: "Label", evidencePlan: "Save", priority: 1 }],
      updateSteps: [{ id: "S-fixture", action: "prioritize", priority: 2, reason: "Order fixture" }],
      updateGoals: [{ id: "G-parent", status: "satisfied", factIds: ["F-fixture"], reason: "Known fact" }],
      reviews: [{ findingId: "V-fixture", status: "impact_verified", rating: "info", reason: "Synthetic reference check", pocEvidenceId: "E-fixture",
        impact: { capability: "Fixture", object: "Fixture", result: "Fixture", scope: "Local", prerequisites: "Fixture" } }],
    };
    // Store still checks goal lifecycle and evidence files.
    expect(() => validateDecisionReferences(board(), proposal)).not.toThrow();
  });

  it("does not accept a goal parent that is only created later in the batch", () => {
    const proposal: Decision = { summary: "Forward parent", goals: [
      { id: "G-child", parentId: "G-parent", description: "Child before parent" },
      { id: "G-parent", parentId: "G0", description: "Later parent" },
    ] };
    expect(() => validateDecisionReferences(board(), proposal)).toThrow("goals[0].parentId");
  });

  it("rejects existing PoC evidence belonging to another finding", () => {
    const proposal: Decision = { summary: "Wrong evidence owner", reviews: [
      { findingId: "V-fixture", status: "impact_verified", rating: "info", reason: "Synthetic check", pocEvidenceId: "E-other" },
    ] };
    expect(() => validateDecisionReferences(board(), proposal)).toThrow('must belong to Finding "V-fixture"');
    const snapshot = board();
    const original = structuredClone({ snapshot, proposal });
    expect(() => validateDecisionReferences(snapshot, proposal)).toThrow('Attached evidenceIds by Finding: {"V-fixture":["E-fixture"]}');
    expect(() => validateDecisionReferences(snapshot, proposal)).toThrow("Do not substitute IDs merely to pass validation");
    expect({ snapshot, proposal }).toEqual(original);
  });

  it("also provides empty or nonempty evidence links for an unknown PoC without guessing a replacement", () => {
    const snapshot = board();
    const review = { findingId: "V-fixture", status: "impact_verified" as const, rating: "info" as const, reason: "Fixture", pocEvidenceId: "E-missing" };
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [review] }))
      .toThrow('Attached evidenceIds by Finding: {"V-fixture":["E-fixture"]}');
    snapshot.findings[0]!.evidenceIds = [];
    expect(() => validateDecisionReferences(snapshot, { summary: "Fixture", reviews: [review] }))
      .toThrow('Attached evidenceIds by Finding: {"V-fixture":[]}');
  });

  it.each(["done", "no_progress", "blocked", "failed", "abandoned"] satisfies StepStatus[])("leaves %s Step updates to the controller history filter", status => {
    const snapshot = board();
    snapshot.steps[0]!.status = status;
    expect(() => validateDecisionReferences(snapshot, { summary: "Historical cleanup", updateSteps: [
      { id: "S-fixture", action: "abandon", reason: "Controller will retain history" },
    ] })).not.toThrow();
  });

  it("rejects claimed Step updates without guessing or altering the step", () => {
    const snapshot = board();
    snapshot.steps[0]!.status = "claimed";
    const original = structuredClone(snapshot);
    expect(() => validateDecisionReferences(snapshot, { summary: "Claimed update", updateSteps: [
      { id: "S-fixture", action: "abandon", reason: "Must remain owned by Execute" },
    ] })).toThrow('"S-fixture" is claimed');
    expect(snapshot).toEqual(original);
  });
});
