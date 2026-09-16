import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import { pendingStepReviews } from "../src/loop/context.js";
import { factBasisReviews } from "../src/loop/fact-basis.js";
import { BlackboardStore } from "../src/store.js";
import type { Combination, Execution, ExecutionRefs, Usage } from "../src/types.js";
import { wikiRecord } from "../src/wiki/model.js";

const roots: string[] = [], stores: BlackboardStore[] = [];
const zero: Usage = { input: 0, output: 0, cost: 0 };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-fact-origin-")); roots.push(root);
  const config = defaultConfig("Preserve synthetic observation prerequisites");
  let store = new BlackboardStore(root, config), sequence = 0;
  stores.push(store);
  store.setStatus("running", "Synthetic origin regression");
  function plan(description: string, from: string[] = [], combination?: Combination) {
    const runId = `plan-${++sequence}`;
    store.beginRun(runId, "decide");
    const board = store.applyDecision(runId, { summary: description, steps: [{ goalId: "G0", from, description,
      successSignal: "Observe fixture response", evidencePlan: "Archive local fixture", priority: 1, ...(combination ? { combination } : {}) }] }, zero);
    return board.steps.find(step => step.description === description)!;
  }
  function claim(description: string, from: string[] = [], combination?: Combination) {
    const step = plan(description, from, combination), runId = `execute-${sequence}`;
    store.beginRun(runId, "execute", step.id);
    const artifacts = join(store.dataDir, "runs", runId, "artifacts"); mkdirSync(artifacts, { recursive: true });
    return { step, runId, artifacts };
  }
  function result(artifacts: string, description: string, body: string, supersedes?: string): Execution {
    writeFileSync(join(artifacts, "response.txt"), body);
    return { summary: description, result: "done", evidence: [{ ref: "e", path: "response.txt", description: "Local original" }],
      facts: [{ ref: "f", description, evidenceRefs: ["e"], ...(supersedes ? { supersedes } : {}) }] };
  }
  return { get store() { return store; }, plan, claim, result, reopen() {
    store.close(); store = new BlackboardStore(root, config); stores.push(store);
  } };
}

describe("Fact producing Step identity", () => {
  it.each(["final", "checkpoint"] as const)("blocks a revoked prerequisite after identical observations through %s submission and reopen", async mode => {
    const test = fixture();
    const seeds = ["A", "B"].map(identity => {
      const run = test.claim(`Establish authorization ${identity}`);
      return test.store.applyExecution(run.runId, test.result(run.artifacts, `Authorization ${identity} is valid`, `grant-${identity}`), zero).facts.at(-1)!;
    });
    const observed = seeds.map((seed, index) => {
      const identity = index === 0 ? "A" : "B";
      const combination = { requires: [seed.id], missing: [], scope: `identity-${identity}`, stateVersion: `v${index + 1}`, expectedCapability: "Read own record" };
      const run = test.claim(`Observe identity ${identity}`, [seed.id], combination);
      const output = test.result(run.artifacts, "The tested identity can read its own record", '{"allowed":true}');
      output.attempts = [{ hypothesis: `read-${identity}`, scope: combination.scope, identity, stateVersion: combination.stateVersion,
        baseline: "Read own record", changedVariable: `requester=${identity}`, outcome: "supports", observation: "Own record returned", evidenceRefs: ["e"] }];
      let factId: string;
      if (mode === "checkpoint") {
        const refs: Partial<ExecutionRefs> = {};
        test.store.applyExecutionCheckpoint(run.runId, "observation", output, zero, refs);
        factId = refs.facts!.f;
        test.store.applyExecution(run.runId, { summary: "Observation committed", result: "done" }, zero);
      } else factId = test.store.applyExecution(run.runId, output, zero).facts.at(-1)!.id;
      return { ...run, factId, combination };
    });
    const consumer = test.plan("Use identity B observation", [observed[1].factId]);
    test.reopen();
    test.store.setStatus("running", "Recheck authorization B");
    const correction = test.claim("Revoke authorization B", [seeds[1].id]);
    const board = test.store.applyExecution(correction.runId, test.result(correction.artifacts, "Authorization B is revoked", "revoked-B", seeds[1].id), zero);
    const executed: string[] = [];
    let calls = 0;
    const controller = new LoopController(test.store, { async run(request) {
      if (request.mode === "execute") { executed.push(request.step!.id); throw new Error("Regression guard stopped before tools"); }
      if (++calls > 4) throw new Error("Unexpected regression planning loop");
      return { usage: zero, output: { summary: "Inspect saved dependencies; no new plan" } };
    } });
    await controller.start();
    expect(executed).toEqual([]);
    expect(controller.snapshot()).toMatchObject({ status: "paused", reason: expect.stringContaining("superseded dependencies") });
    expect(observed[1].factId).not.toBe(observed[0].factId);
    expect(board.facts.find(fact => fact.id === observed[1].factId)?.evidenceIds).toEqual(board.facts.find(fact => fact.id === observed[0].factId)?.evidenceIds);
    expect(wikiRecord(board, { kind: "fact", id: observed[1].factId })!.value).toMatchObject({
      stepId: observed[1].step.id, originConditions: { from: [seeds[1].id], ...observed[1].combination }, reviewIssues: ["basis_review_required"],
    });
    expect(factBasisReviews(board).has(observed[0].factId)).toBe(false);
    expect(pendingStepReviews(board)).toContainEqual(expect.objectContaining({ stepId: consumer.id, staleFactIds: [seeds[1].id] }));
    expect(controller.snapshot().steps.find(step => step.id === consumer.id)).toMatchObject({ status: "ready", attempts: 0 });
  });

  it("retains origins expressed only in different plan text without crediting repeated Fact wording as progress", () => {
    const test = fixture();
    const first = test.claim("Read the local object as identity A");
    const before = test.store.applyExecution(first.runId, test.result(first.artifacts, "The tested identity received OK", "OK"), zero);
    const second = test.claim("Read the local object as identity B");
    const after = test.store.applyExecution(second.runId, test.result(second.artifacts, "The tested identity received OK", "OK"), zero);
    expect(after.facts.map(fact => fact.stepId)).toEqual([first.step.id, second.step.id]);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.noProgressCount).toBe(1);
    expect(after.steps.at(-1)?.status).toBe("no_progress");
  });
});
