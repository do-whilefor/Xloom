import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { clearRetrievalSnapshots, incrementalRetrievalIndex } from "../src/wiki/incremental.js";
import { wikiIssues, wikiRecord } from "../src/wiki/model.js";
import { createTaskReader } from "../src/wiki/read.js";
import { beginFixtureStep, zero } from "./fixtures/native-retrieval.js";
import type { AttemptProposal, BoardSnapshot, Execution, ExecutionRefs } from "../src/types.js";

const roots: string[] = [], stores: BlackboardStore[] = [];
afterEach(() => {
  clearRetrievalSnapshots();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-provenance-")) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

const attempt = (identity: string, evidenceRefs = ["e"]): AttemptProposal => ({ hypothesis: `hypothesis-${identity}`, scope: `object-${identity}`,
  identity, stateVersion: "v1", baseline: "Local owner request", changedVariable: "requester", outcome: "refutes", observation: "Access denied", evidenceRefs });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-provenance-")); roots.push(root);
  const config = defaultConfig("Keep synthetic observation provenance separate");
  let store = new BlackboardStore(root, config); stores.push(store);
  const original = (run: string, body: string, ref = "e") => {
    const artifacts = join(store.dataDir, "runs", run, "artifacts"); mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, `${ref}.txt`), body);
    return { ref, path: `${ref}.txt`, description: "Synthetic local response" };
  };
  const commit = (run: string, output: Execution, checkpoint = false) => {
    if (checkpoint) {
      store.applyExecutionCheckpoint(run, "observed", output, zero);
      return store.applyExecution(run, { summary: "Observation checkpoint retained", result: "done" }, zero);
    }
    return store.applyExecution(run, output, zero);
  };
  return { root, get store() { return store; }, original, commit, reopen() {
    store.close(); store = new BlackboardStore(root, config); stores.push(store);
  } };
}

function attemptsFor(board: BoardSnapshot, kind: "fact" | "finding", id: string): string[] {
  return (wikiRecord(board, { kind, id })!.value as { attempts: string[] }).attempts;
}

describe("experiment provenance through Store, Wiki and native reads", () => {
  it.each([false, true])("keeps unrelated same-byte observations out of reviewed sources and warm retrieval (checkpoint=%s)", checkpoint => {
    const test = fixture();
    beginFixtureStep(test.store, "alice-first");
    const first = test.commit("alice-first", { summary: "Alice sample", result: "done", evidence: [test.original("alice-first", "DENIED")],
      facts: [{ ref: "f", description: "Alice's local object request was denied", evidenceRefs: ["e"] }], attempts: [attempt("alice")],
      findings: [{ key: "reviewed-alice-boundary", title: "Alice local boundary", target: "object-alice", status: "technical_hit", factRefs: ["f"], evidenceRefs: ["e"], next: "Review synthetic observation" }],
      wikiPages: [{ id: "WK-alice", title: "Alice observation", blocks: [{ id: "B-result", title: "Local result", text: "The local alice request was denied; no impact claimed.", sources: [{ kind: "fact", id: "f" }] }] }],
    });
    const aliceFact = first.facts[0]!, aliceAttempt = first.attempts![0]!, aliceFinding = first.findings[0]!;
    expect(aliceFinding.key).not.toBe(aliceAttempt.hypothesis);
    test.store.beginRun("review-alice", "decide");
    const reviewed = test.store.applyDecision("review-alice", { summary: "Reviewed local denial", reviews: [{ findingId: aliceFinding.id, status: "closed", rating: "unrated", reason: "Expected local denial under alice's conditions" }] }, zero);
    expect(wikiIssues(reviewed, reviewed.wikiPages![0]!)).toEqual([]);
    const baseline = incrementalRetrievalIndex(reviewed, test.store.dataDir, test.root);
    expect(incrementalRetrievalIndex(reviewed, test.store.dataDir, test.root).stats.indexedBytes).toBe(0);
    const read = createTaskReader(test.root, { dataDir: test.store.dataDir, snapshot: () => test.store.snapshot() });
    const readAttempts = (kind: "fact" | "finding", id: string) => {
      const result = read(`xloom://record?kind=${kind}&id=${id}&budgetChars=64000`) as { complete: boolean; records: { ref: { kind: string; id: string } }[] };
      expect.soft(result.complete).toBe(true);
      return result.records.filter(record => record.ref.kind === "attempt").map(record => record.ref.id).sort();
    };
    expect(readAttempts("finding", aliceFinding.id)).toEqual([aliceAttempt.id]);

    beginFixtureStep(test.store, "bob-first");
    const other = test.commit("bob-first", { summary: "Independent Bob sample", result: "done", evidence: [test.original("bob-first", "DENIED")],
      facts: [{ ref: "f", description: "Bob's different local object request was denied", evidenceRefs: ["e"] }], attempts: [attempt("bob")],
    }, checkpoint);
    const bobFact = other.facts.at(-1)!, bobAttempt = other.attempts!.find(item => item.identity === "bob")!;
    expect(other.evidence).toHaveLength(1);
    expect(other.facts).toHaveLength(2);
    expect.soft(other.findings[0]).toEqual(reviewed.findings[0]);
    expect.soft(attemptsFor(other, "fact", aliceFact.id)).toEqual([aliceAttempt.id]);
    expect.soft(attemptsFor(other, "fact", bobFact.id)).toEqual([bobAttempt.id]);
    expect.soft(attemptsFor(other, "finding", aliceFinding.id)).toEqual([aliceAttempt.id]);
    expect.soft(wikiIssues(other, other.wikiPages![0]!)).toEqual([]);
    expect.soft(readAttempts("fact", aliceFact.id)).toEqual([aliceAttempt.id]);
    expect.soft(readAttempts("finding", aliceFinding.id)).toEqual([aliceAttempt.id]);
    expect.soft(readAttempts("fact", bobFact.id)).toEqual([bobAttempt.id]);
    const warm = incrementalRetrievalIndex(other, test.store.dataDir, test.root);
    for (const ref of [{ kind: "fact", id: aliceFact.id }, { kind: "block", id: "B-result" }]) {
      const document = (documents: typeof warm.index.documents) => documents.find(item => item.ref.kind === ref.kind && item.ref.id === ref.id)!;
      expect.soft(document(warm.index.documents)).toEqual(document(baseline.index.documents));
    }
    expect(incrementalRetrievalIndex(other, test.store.dataDir, test.root).stats.indexedBytes).toBe(0);

    beginFixtureStep(test.store, "bob-new-capture");
    const updated = test.commit("bob-new-capture", { summary: "Another capture of Bob's same experiment", result: "done",
      evidence: [test.original("bob-new-capture", "DENIED with fresh capture metadata")], attempts: [attempt("bob")],
    }, checkpoint);
    expect(updated.attempts).toHaveLength(2);
    expect(updated.evidence).toHaveLength(2);
    expect.soft(updated.findings[0]).toEqual(reviewed.findings[0]);
    expect.soft(wikiIssues(updated, updated.wikiPages![0]!)).toEqual([]);
    expect.soft(readAttempts("fact", aliceFact.id)).toEqual([aliceAttempt.id]);
    expect.soft(readAttempts("finding", aliceFinding.id)).toEqual([aliceAttempt.id]);
  });

  it("retains a deduplicated Attempt across Step-specific evidence pairs and restart", () => {
    const test = fixture();
    const firstStep = beginFixtureStep(test.store, "first-pair");
    const first = test.commit("first-pair", { summary: "One tested response and one separate local capture", result: "done",
      evidence: [test.original("first-pair", "DENIED", "tested"), test.original("first-pair", "OTHER", "separate")],
      facts: [{ ref: "tested-fact", description: "Alice's tested request was denied", evidenceRefs: ["tested"] },
        { ref: "separate-fact", description: "A separate capture from the same Step was retained", evidenceRefs: ["separate"] }],
      attempts: [attempt("alice", ["tested"])],
    });
    const firstFact = first.facts[0]!, separateFact = first.facts[1]!, attemptId = first.attempts![0]!.id;
    expect(attemptsFor(first, "fact", separateFact.id)).toEqual([]);
    const secondStep = beginFixtureStep(test.store, "second-pair");
    const repeated = test.commit("second-pair", { summary: "Same experiment under the same conditions with another source capture", result: "done",
      evidence: [test.original("second-pair", "OTHER")],
      facts: [{ ref: "repeated", description: "Alice's repeated request has a new source capture", evidenceRefs: ["e"] }], attempts: [attempt("alice")],
    }, true);
    const repeatedFact = repeated.facts.at(-1)!;
    expect(repeated.attempts).toHaveLength(1);
    expect(repeated.evidence).toHaveLength(2);
    expect(repeated.attempts![0]!.evidenceIds).toHaveLength(2);
    expect(firstFact.stepId).toBe(firstStep.id);
    expect(repeatedFact.stepId).toBe(secondStep.id);
    expect(repeatedFact.evidenceIds).toEqual(separateFact.evidenceIds);
    expect.soft(attemptsFor(repeated, "fact", firstFact.id)).toEqual([attemptId]);
    expect.soft(attemptsFor(repeated, "fact", repeatedFact.id)).toEqual([attemptId]);
    expect.soft(attemptsFor(repeated, "fact", separateFact.id)).toEqual([]);
    const attemptsBefore = repeated.attempts;
    test.reopen();
    expect(test.store.snapshot().attempts).toEqual(attemptsBefore);
    expect.soft(attemptsFor(test.store.snapshot(), "fact", repeatedFact.id)).toEqual([attemptId]);
    expect.soft(attemptsFor(test.store.snapshot(), "fact", separateFact.id)).toEqual([]);
    const read = createTaskReader(test.root, { dataDir: test.store.dataDir, snapshot: () => test.store.snapshot() });
    for (const [fact, expected] of [[repeatedFact, [attemptId]], [separateFact, []]] as const) {
      const result = read(`xloom://record?kind=fact&id=${fact.id}&budgetChars=64000`) as { complete: boolean; records: { ref: { kind: string; id: string } }[] };
      expect.soft(result.complete).toBe(true);
      expect.soft(result.records.filter(item => item.ref.kind === "attempt").map(item => item.ref.id)).toEqual(expected);
    }

    beginFixtureStep(test.store, "contrary-pair");
    const contrary = test.commit("contrary-pair", { summary: "Opposite outcome under the same recorded conditions", result: "done",
      evidence: [test.original("contrary-pair", "ALLOWED")], attempts: [{ ...attempt("alice"), outcome: "supports", observation: "Access allowed" }],
    });
    expect(contrary.attempts).toHaveLength(2);
    const conflictIds = contrary.attempts!.map(item => item.id).sort();
    for (const [fact, expected] of [[firstFact, conflictIds], [repeatedFact, conflictIds], [separateFact, []]] as const) {
      const result = read(`xloom://record?kind=fact&id=${fact.id}&budgetChars=64000`) as { complete: boolean; records: { ref: { kind: string; id: string } }[] };
      expect.soft(result.complete).toBe(true);
      expect.soft(result.records.filter(item => item.ref.kind === "attempt").map(item => item.ref.id).sort()).toEqual(expected);
    }
  });

  it("keeps same-byte Attempt checkpoint replays idempotent without crediting another source as progress", () => {
    const test = fixture();
    beginFixtureStep(test.store, "original-attempt");
    test.commit("original-attempt", { summary: "Initial local denial", result: "done", evidence: [test.original("original-attempt", "DENIED")], attempts: [attempt("alice")] });
    beginFixtureStep(test.store, "duplicate-attempt");
    const output: Execution = { summary: "Same outcome in a later Step", result: "done", evidence: [test.original("duplicate-attempt", "DENIED")], attempts: [attempt("alice")] };
    const refs: Partial<ExecutionRefs> = {};
    const first = test.store.applyExecutionCheckpoint("duplicate-attempt", "duplicate", output, zero, refs);
    const events = test.store.events();
    const replayRefs: Partial<ExecutionRefs> = {};
    const replay = test.store.applyExecutionCheckpoint("duplicate-attempt", "duplicate", output, zero, replayRefs);
    expect(replay).toEqual(first);
    expect(replayRefs).toEqual(refs);
    expect(test.store.events()).toEqual(events);
    expect(replay.attempts).toHaveLength(1);
    expect(replay.facts).toEqual([]);
    expect(replay.evidence).toHaveLength(1);
    const completed = test.store.applyExecution("duplicate-attempt", { summary: "No new condition or outcome", result: "done" }, zero);
    expect(completed.attempts).toEqual(first.attempts);
    expect(completed.noProgressCount).toBe(1);
    expect(completed.steps.at(-1)!.status).toBe("no_progress");
  });
});
