import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareValues } from "../src/observations/compare.js";
import { compareEvidence } from "../src/observations/read.js";
import { invalidateObservationReviews, observationChanges, observationConflicts } from "../src/observations/changes.js";
import { attemptKeys } from "../src/loop/attempts.js";
import { defaultLoopPolicy } from "../src/loop/policy.js";
import { defaultConfig } from "../src/config.js";
import { createTaskReader } from "../src/wiki/read.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { wikiDigest, wikiRecord } from "../src/wiki/model.js";
import type { Attempt, BoardSnapshot } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-compare-")) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
} });
const raw = (body: unknown) => ({ actor_ref: "account-A", environment: "lab-v1", session_generation: "1",
  request: { method: "POST", body: { object_id: "object-A" } }, response: { status: 200, body } });
function board(): BoardSnapshot {
  return { revision: 0, config: defaultConfig("Synthetic observation comparison"), status: "running", outcome: null, reason: "",
    goals: [], facts: [], evidence: [], findings: [], steps: [], hints: [], completedSteps: 0, lastMetaStep: 0, lastMetaRevision: 0, noProgressCount: 0, usage: { input: 0, output: 0, cost: 0 } };
}
function attempt(id: string, patch: Partial<Attempt> = {}): Attempt {
  const value = { id, hypothesis: "read-object", scope: "object-A", identity: "account-A", stateVersion: "v1", baseline: "owner allowed", changedVariable: "requester",
    outcome: "supports" as const, observation: "fixture response", evidenceIds: ["E-one"], stepId: "S-one", runId: "R-one", ...patch };
  return { ...value, ...attemptKeys(value) };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-compare-")); roots.push(root); mkdirSync(join(root, "evidence"));
  const snapshot = board();
  function add(id: string, value: unknown, plain = false) {
    const text = plain ? String(value) : JSON.stringify(value), path = `evidence/${id}.json`;
    writeFileSync(join(root, path), text);
    snapshot.evidence.push({ id, path, pathBase: "task", sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
      description: "Synthetic comparison source", stepId: "S-one", runId: "R-one" });
  }
  add("E-one", raw({ status: "denied" })); add("E-two", raw({ status: "accepted" }));
  return { root, snapshot, add };
}

describe("native observation comparison semantics", () => {
  it("compares business fields under the same HTTP code without a verdict", () => {
    const result = compareValues(raw({ status: "denied" }), raw({ status: "accepted" }), ["response.body.status", "response.body.status"]);
    expect(result).toMatchObject({ assessment: "comparison_only", response: { status: { equal: true }, body: { changedPaths: ["/response/body/status"] } },
      selectedFields: [{ path: "response.body.status", right: { value: "accepted" }, equal: false }] });
    expect(result.gaps.map(gap => gap.code)).toEqual(["controls_not_established", "business_outcome_not_established"]);
  });
  it("separates identity, conditions, requests, response metadata and timing noise", () => {
    const a = { ...raw("same"), time_total: 0.1 }, b = { ...raw("same"), time_total: 0.11, actor_ref: "account-B", environment: "lab-v2" };
    b.request.body.object_id = "object-B"; b.response.status = 403;
    const result = compareValues(a, b);
    expect(result.identity.changedPaths).toEqual(["/actor_ref"]); expect(result.conditions.changedPaths).toEqual(["/environment"]);
    expect(result.request.changedPaths).toEqual(["/request/body/object_id"]);
    expect(result.response.metadataChangedPaths).toEqual(["/response/status"]); expect(result.response.body.equal).toBe(true);
    expect(result.otherChangedPaths).toEqual(["/time_total"]); expect(result.assessment).toBe("comparison_only");
  });
  it("distinguishes missing, null, boolean, number and string without inherited fields", () => {
    const result = compareValues(raw({ flag: true }), raw({ flag: 1, detail: null }),
      ["response.body.flag", "response.body.detail", "response.body.unknown", "response.body.constructor", "response.body.toString"]);
    expect(result.selectedFields[0]!.equal).toBe(false);
    expect(result.selectedFields[1]).toMatchObject({ left: { present: false }, right: { present: true, value: null }, equal: false });
    expect(result.selectedFields.slice(2).every(field => field.equal === null)).toBe(true);
    expect(compareValues(raw(1), raw("1")).response.body.equal).toBe(false);
  });
  it("canonicalizes object order and preserves array indexes and escaped JSON pointers", () => {
    const result = compareValues(raw({ rows: [{ "a/b~c": 1 }], status: "same" }), raw({ status: "same", rows: [{ "a/b~c": 2 }, null] }),
      ["response.body.rows.0.a/b~c", "response.body.rows.1", "response.body.rows"]);
    expect(result.response.body.changedPaths).toEqual(["/response/body/rows/0/a~1b~0c", "/response/body/rows/1"]);
    expect(result.selectedFields[1]).toMatchObject({ right: { value: null }, left: { present: false } });
    expect(result.selectedFields[2]).toMatchObject({ right: { valueOmitted: true } });
    expect(compareValues(raw({ a: 1, b: 2 }), raw({ b: 2, a: 1 })).response.body.equal).toBe(true);
  });
  it("summarizes large bodies without truncating selected string leaves", () => {
    const body = "长响应".repeat(20000);
    const result = compareValues(raw(body), raw(body + "x"), ["response.body"]);
    expect(result.response.body.left).toMatchObject({ byteLength: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), encoding: "utf-8" });
    expect(JSON.stringify(result)).not.toContain(body);
    expect(compareValues(raw({ selected: body }), raw({ selected: body }), ["response.body.selected"]).selectedFields[0]!.left).toMatchObject({ value: body });
  });
  it("does not invent HTTP fields or identity for source/log observations", () => {
    const result = compareValues({ line: 12 }, raw(null));
    expect(result.identity.left).toEqual({}); expect(result.response.body.left).toEqual({ present: false });
    expect(result.response.body.right).toMatchObject({ type: "null" });
    expect(result.gaps).toContainEqual({ code: "missing_http_observation", side: "left", fields: ["request", "response.status", "response.body"] });
  });
  it.each(["response.body", ["response..body"], [null], [""], Array(65).fill("a")])("rejects invalid selection %j", fields => {
    expect(() => compareValues(raw({}), raw({}), fields)).toThrow("fields");
  });
  it.each([null, [], "text", { response: null }, { request: [] }])("rejects invalid observation schema %j", value => {
    expect(() => compareValues(raw({}), value)).toThrow("JSON object");
  });
});

describe("task-native comparison reader", () => {
  it("uses read on two verified originals without mutating public state or reading unrelated bytes", async () => {
    const { root, snapshot, add } = fixture(); add("E-unrelated", "damaged", true);
    writeFileSync(join(root, "evidence/E-unrelated.json"), "tampered");
    const before = structuredClone(snapshot), reader = createTaskReader(root, { dataDir: root, snapshot: () => snapshot });
    const path = `xloom://compare?${new URLSearchParams({ left: "E-one", right: "E-two", fields: JSON.stringify(["response.body.status"]) })}`;
    const result = reader(path) as ReturnType<typeof compareEvidence>;
    expect(result).toMatchObject({ status: "ready", sources: { left: { integrity: "verified" }, right: { integrity: "verified" } } });
    expect(snapshot).toEqual(before);
    const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => snapshot });
    expect(JSON.parse((await tool.execute("compare", { path })).content[0]!.text as string)).toMatchObject({ type: "observation_comparison", evidence: false });
    await expect(createWorkspaceReadTool(root).execute("private", { path })).rejects.toThrow("outside a research task");
    expect(() => reader("xloom://compare?left=E-one&right=E-foreign")).toThrow("Unknown comparison Evidence ID");
    expect(() => reader("xloom://compare?left=E-one&left=E-two&right=E-one")).toThrow("duplicate");
  });
  it.each(["tampered", "missing", "size", "escape"])("suppresses all content comparison for %s sources", failure => {
    const { root, snapshot } = fixture();
    if (failure === "tampered") writeFileSync(join(root, "evidence/E-one.json"), "tampered");
    if (failure === "missing") rmSync(join(root, "evidence/E-one.json"));
    if (failure === "size") snapshot.evidence[0]!.bytes++;
    if (failure === "escape") snapshot.evidence[0]!.path = "../foreign.json";
    const result = compareEvidence(snapshot, root, root, "E-one", "E-two");
    expect(result.status).toBe("unavailable"); expect(result).not.toHaveProperty("response");
    expect(result.sources.left.issues.length).toBeGreaterThan(0);
  });
  it("rejects non-JSON archives instead of parsing excerpts or fabricating HTTP", () => {
    const { root, snapshot, add } = fixture(); add("E-text", "GET synthetic request", true);
    expect(() => compareEvidence(snapshot, root, root, "E-text", "E-two")).toThrow("JSON object archive");
  });
  it.each(["9007199254740993", "1e400"])("rejects numeric precision loss in saved JSON (%s)", numeric => {
    const { root, snapshot, add } = fixture(); add("E-number", `{"response":{"body":{"id":${numeric}}}}`, true);
    expect(() => compareEvidence(snapshot, root, root, "E-number", "E-two")).toThrow("safe numeric values");
  });
});

describe("minimal observation change adapter", () => {
  function reviewedBoard(): BoardSnapshot {
    const snapshot = board();
    snapshot.evidence = [{ id: "E-one", path: "evidence/one.json", pathBase: "task", sha256: "a".repeat(64), bytes: 1,
      description: "Shared source bytes", stepId: "S-one", runId: "R-one" }];
    snapshot.facts = [{ id: "F-one", stepId: "S-one", description: "Recorded result for object A", evidenceIds: ["E-one"] }];
    snapshot.attempts = [attempt("A-one")];
    snapshot.findings = [{ id: "V-one", key: "reviewed-summary", target: "object-A", title: "Reviewed result", status: "closed", rating: "unrated",
      factIds: ["F-one"], evidenceIds: ["E-one"], next: "Reopen for related observations", review: "Historical review" }];
    return snapshot;
  }
  it("preserves legacy Wiki signatures for equivalent implicit and explicit Attempt sources", () => {
    const before = reviewedBoard();
    before.evidence.push({ ...before.evidence[0]!, id: "E-two", path: "evidence/two.json", sha256: "b".repeat(64) });
    before.attempts![0]!.evidenceIds.push("E-two");
    const after = structuredClone(before);
    after.attempts![0]!.sources = [{ stepId: "S-one", evidenceIds: ["E-two", "E-one", "E-one"] },
      { stepId: "S-one", evidenceIds: ["E-two"] }];
    const previous = wikiRecord(before, { kind: "attempt", id: "A-one" })!.value;
    const current = wikiRecord(after, { kind: "attempt", id: "A-one" })!.value;
    expect(previous).not.toHaveProperty("sources");
    expect(current).not.toHaveProperty("sources");
    expect(wikiDigest(current)).toBe(wikiDigest(previous));
    expect(observationChanges(before, after)).toEqual([]);
    invalidateObservationReviews(before, after);
    expect(after.findings).toEqual(before.findings);
  });
  it("retains the old Fact relationship when an Attempt moves its source pairing to another Step", () => {
    const before = reviewedBoard();
    before.findings.push({ ...before.findings[0]!, id: "V-direct", key: "direct-source", factIds: [] });
    const after = structuredClone(before);
    after.attempts![0]!.sources = [{ stepId: "S-unrelated", evidenceIds: ["E-one"] }];
    expect(observationChanges(before, after)).toEqual([{ kind: "source_changed", attemptIds: ["A-one"], factIds: [], evidenceIds: ["E-one"] }]);
    const previous = wikiRecord(before, { kind: "attempt", id: "A-one" })!.value;
    const current = wikiRecord(after, { kind: "attempt", id: "A-one" })!.value;
    expect(current).toHaveProperty("sources", [{ stepId: "S-unrelated", evidenceIds: ["E-one"] }]);
    expect(wikiDigest(current)).not.toBe(wikiDigest(previous));
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toEqual({ kinds: ["source_changed"], attemptIds: ["A-one"], factIds: [], evidenceIds: ["E-one"] });
    expect(after.findings[1]).toEqual(before.findings[1]);
    expect(wikiRecord(after, { kind: "finding", id: "V-direct" })!.dependencies).not.toContainEqual({ kind: "attempt", id: "A-one" });
  });
  it("retains a prior hypothesis relationship after an Attempt changes to a different hypothesis", () => {
    const before = reviewedBoard();
    before.findings[0]!.key = "read-object"; before.findings[0]!.factIds = []; before.findings[0]!.evidenceIds = [];
    before.findings.push({ ...before.findings[0]!, id: "V-direct", key: "direct-source", evidenceIds: ["E-one"] });
    const after = structuredClone(before); after.attempts![0]!.hypothesis = "unrelated-hypothesis";
    expect(observationChanges(before, after)).toEqual([{ kind: "new_observation", attemptIds: ["A-one"], factIds: [], evidenceIds: ["E-one"] }]);
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toEqual({ kinds: ["new_observation"], attemptIds: ["A-one"], factIds: [], evidenceIds: ["E-one"] });
    expect(after.findings[1]).toEqual(before.findings[1]);
    expect(wikiRecord(after, { kind: "finding", id: "V-direct" })!.dependencies).not.toContainEqual({ kind: "attempt", id: "A-one" });
  });
  it.each(["attempt", "fact", "both"])("does not invalidate reviewed support when an unrelated %s reuses its Evidence", added => {
    const before = reviewedBoard(), after = structuredClone(before);
    if (added !== "fact") after.attempts!.push(attempt("A-other", { hypothesis: "other-object", scope: "object-B", identity: "account-B", stepId: "S-other" }));
    if (added !== "attempt") after.facts.push({ id: "F-other", stepId: "S-other", description: "Independent result for object B", evidenceIds: ["E-one"] });
    invalidateObservationReviews(before, after);
    expect(after.findings).toEqual(before.findings);
    expect(wikiRecord(after, { kind: "fact", id: "F-one" })).toEqual(wikiRecord(before, { kind: "fact", id: "F-one" }));
    expect(wikiRecord(after, { kind: "finding", id: "V-one" })).toEqual(wikiRecord(before, { kind: "finding", id: "V-one" }));
  });
  it("does not invalidate a review when an unrelated Attempt adds a source alongside shared Evidence", () => {
    const before = reviewedBoard();
    before.attempts!.push(attempt("A-other", { hypothesis: "other-object", scope: "object-B", stepId: "S-other" }));
    const after = structuredClone(before);
    after.evidence.push({ ...after.evidence[0]!, id: "E-new", path: "evidence/new.json", sha256: "b".repeat(64), stepId: "S-other" });
    after.attempts![1]!.evidenceIds.push("E-new");
    expect(observationChanges(before, after)).toContainEqual({ kind: "source_changed", attemptIds: ["A-other"], factIds: [], evidenceIds: ["E-new", "E-one"] });
    invalidateObservationReviews(before, after);
    expect(after.findings).toEqual(before.findings);
    expect(wikiRecord(after, { kind: "fact", id: "F-one" })).toEqual(wikiRecord(before, { kind: "fact", id: "F-one" }));
  });
  it.each(["changed", "deleted"])("invalidates direct-Evidence support when its source is %s without attaching unrelated experiments", change => {
    const before = reviewedBoard();
    before.facts = []; before.findings[0]!.factIds = [];
    before.evidence.push({ ...before.evidence[0]!, id: "E-other", path: "evidence/other.json", sha256: "b".repeat(64), stepId: "S-other" });
    before.attempts = [attempt("A-other", { hypothesis: "other-object", stepId: "S-other", evidenceIds: ["E-one", "E-other"] })];
    const after = structuredClone(before);
    if (change === "changed") after.evidence[0]!.sha256 = "c".repeat(64);
    else after.evidence.shift();
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toEqual({ kinds: ["source_changed"], attemptIds: [], factIds: [], evidenceIds: ["E-one"] });
    expect(after.findings[0]!.evidenceIds).toEqual(["E-one"]);
  });
  it.each(["fact", "hypothesis"])("retains a deleted Attempt's %s relationship when requiring a fresh review", relationship => {
    const before = reviewedBoard();
    if (relationship === "hypothesis") {
      before.findings[0]!.key = "read-object";
      before.findings[0]!.factIds = []; before.findings[0]!.evidenceIds = [];
    }
    const after = structuredClone(before); after.attempts = [];
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toEqual({ kinds: ["source_changed"], attemptIds: ["A-one"], factIds: [], evidenceIds: ["E-one"] });
  });
  it("invalidates an explicitly superseded Fact even when a different Step reuses the same Evidence", () => {
    const before = reviewedBoard(), after = structuredClone(before);
    after.facts.push({ id: "F-corrected", stepId: "S-correct", description: "Corrected interpretation", supersedes: "F-one", evidenceIds: ["E-one"] });
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toEqual({ kinds: ["source_changed"], attemptIds: [], factIds: ["F-corrected", "F-one"], evidenceIds: ["E-one"] });
    expect(after.findings[0]!.factIds).toEqual(["F-one"]);
  });
  it("uses the Store's hypothesis normalization when locating an affected Finding", () => {
    const before = board(); before.findings = [{ id: "V1", key: "fixture key", target: "fixture", title: "Fixture", status: "closed", rating: "unrated",
      factIds: [], evidenceIds: [], next: "reopen", review: "Historical review" }];
    const after = structuredClone(before); after.attempts = [attempt("A1", { hypothesis: "  Fixture   Key ", evidenceIds: ["E-new"] })];
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview?.attemptIds).toEqual(["A1"]);
    expect(wikiRecord(after, { kind: "finding", id: "V1" })!.dependencies).toContainEqual({ kind: "attempt", id: "A1" });
  });
  it("groups repeated conflicting observations once and ignores unchanged history", () => {
    const before = board(); before.attempts = Array.from({ length: 200 }, (_, i) => attempt(`A-${i}`, { outcome: i % 2 ? "supports" : "refutes" }));
    expect(observationChanges(before, structuredClone(before))).toEqual([]);
    const after = structuredClone(before); after.attempts!.push(attempt("A-new"));
    const conflicts = observationChanges(before, after).filter(change => change.kind === "observation_conflict");
    expect(conflicts).toHaveLength(1); expect(conflicts[0]!.attemptIds).toHaveLength(201);
  });
  it("invalidates a Finding review when an explicitly causal Fact is corrected", () => {
    const before = board();
    before.facts = [{ id: "F-origin", stepId: null, evidenceIds: ["E-old"], description: "Old condition" },
      { id: "F-derived", stepId: "S-derive", evidenceIds: ["E-result"], description: "Derived result" }];
    before.steps = [{ id: "S-derive", goalId: "G0", from: ["F-origin"], description: "derive", successSignal: "result", evidencePlan: "save",
      priority: 1, status: "done", attempts: 1, runId: null, leaseUntil: null }];
    before.findings = [{ id: "V1", key: "derived", target: "fixture", title: "Derived", status: "closed", rating: "unrated", factIds: ["F-derived"],
      evidenceIds: ["E-result"], next: "reopen", review: "Historical review" }];
    const after = structuredClone(before); after.facts.push({ id: "F-new", stepId: null, evidenceIds: ["E-new"], description: "Revised condition", supersedes: "F-origin" });
    invalidateObservationReviews(before, after);
    expect(after.findings[0]!.observationReview).toMatchObject({ kinds: ["source_changed"], factIds: ["F-new", "F-origin"] });
    expect(after.findings[0]!.factIds).toEqual(["F-derived"]);
  });
  it("flags only same-condition supports/refutes as conflict candidates", () => {
    const snapshot = board(); snapshot.attempts = [attempt("A1"), attempt("A2", { outcome: "refutes" }),
      attempt("A3", { outcome: "refutes", identity: "account-B" }), attempt("A4", { outcome: "inconclusive" })];
    expect([...observationConflicts(snapshot)]).toEqual([["A1", ["A2"]], ["A2", ["A1"]]]);
    const before = { ...snapshot, attempts: [snapshot.attempts[0]!] };
    expect(observationChanges(before, snapshot).filter(item => item.kind === "observation_conflict")).toEqual([
      { kind: "observation_conflict", attemptIds: ["A1", "A2"], factIds: [], evidenceIds: ["E-one"] },
    ]);
    expect(observationChanges(snapshot, structuredClone(snapshot))).toEqual([]);
  });
  it("detects source and Fact changes but ignores array order, labels and runtime metadata", () => {
    const { snapshot } = fixture(); snapshot.attempts = [attempt("A1", { evidenceIds: ["E-one", "E-two"] })];
    snapshot.facts = [{ id: "F1", stepId: "S-one", description: "Saved outcome", evidenceIds: ["E-one"] }];
    const after = structuredClone(snapshot); after.attempts![0]!.evidenceIds.reverse(); after.revision++;
    after.evidence[0]!.description = "renamed"; after.attempts![0]!.runId = "other";
    expect(observationChanges(snapshot, after)).toEqual([]);
    after.evidence[0]!.sha256 = "changed";
    expect(observationChanges(snapshot, after).map(item => item.kind)).toEqual(["source_changed", "source_changed"]);
    const correction = structuredClone(snapshot); correction.facts.push({ ...correction.facts[0]!, id: "F2", supersedes: "F1" });
    expect(observationChanges(snapshot, correction)).toContainEqual({ kind: "source_changed", attemptIds: [], factIds: ["F1", "F2"], evidenceIds: ["E-one"] });
  });
  it("schedules metacognitive review without promoting observations or replaying completed steps", () => {
    const before = board(), after = structuredClone(before);
    after.completedSteps = 1; after.attempts = [attempt("A1")];
    after.steps = [{ id: "S-one", goalId: "G0", from: [], description: "fixture", successSignal: "fixture", evidencePlan: "fixture", priority: 1,
      status: "done", attempts: 1, runId: "R-one", leaseUntil: null }];
    const original = structuredClone(after);
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S-one")).toMatchObject({ kind: "observation_change", reason: expect.stringContaining("new_observation") });
    expect(defaultLoopPolicy.selectStep(after)).toBeUndefined(); expect(after).toEqual(original);
  });
});
