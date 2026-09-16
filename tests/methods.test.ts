import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { projectContext, projectStep } from "../src/loop/context.js";
import { loadMethod, methodCatalog, methodIds, methodsDirectory, type MethodContext } from "../src/methods.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { decisionSchema } from "../src/schema.js";
import { BlackboardStore } from "../src/store.js";
import type { BoardSnapshot, RunRequest, Step, StepProposal } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "xloom-methods-"));
  roots.push(root);
  return root;
}
function proposal(ids?: string[]): StepProposal {
  return { goalId: "G0", from: [], description: "Compare synthetic controls", successSignal: "Observed fixture difference",
    evidencePlan: "Retain fixture controls", priority: 1, ...(ids ? { methodIds: ids } : {}) };
}
function step(ids?: string[], index = 0): Step {
  return { ...proposal(ids), id: `S${index}`, status: "done", attempts: 1, runId: null, leaseUntil: null };
}
function request(mode: RunRequest["mode"], steps: Step[] = []): RunRequest {
  const snapshot: BoardSnapshot = {
    revision: 0, config: defaultConfig("Synthetic method projection fixture"), status: "running", outcome: null, reason: "",
    goals: [{ id: "G0", description: "Fixture", parentId: null, status: "active", factIds: [] }],
    steps, facts: [], findings: [], evidence: [], hints: [], usage: { input: 0, output: 0, cost: 0 },
    completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
  };
  return { id: "fixture", mode, snapshot, workspace: "fixture", runDir: "fixture/run", step: steps.at(-1),
    signal: new AbortController().signal, onEvent() {} };
}
function methods(input: RunRequest): MethodContext | undefined {
  return JSON.parse(buildRunPrompt(input).userPrompt.split("\n").at(-1)!).methods;
}

describe("built-in method selection and resources", () => {
  it("validates optional, bounded, unique selections while retaining old plans", () => {
    for (const ids of [undefined, [], ["baseline-authz"], methodIds.slice(0, 3)]) {
      expect(decisionSchema.parse({ summary: "Fixture", steps: [proposal(ids)] }).steps?.[0]).toEqual(proposal(ids));
    }
    for (const ids of [["unknown"], ["../catalog"], ["baseline-authz", "baseline-authz"], methodIds.slice(0, 4), ["Baseline-authz"]]) {
      expect(decisionSchema.safeParse({ summary: "Fixture", steps: [proposal(ids)] }).success).toBe(false);
    }
  });

  it("loads all 13 independent, bounded cards", () => {
    expect(Object.keys(methodCatalog()).sort()).toEqual([...methodIds].sort());
    expect(methodIds).toHaveLength(13);
    for (const id of methodIds) {
      const card = loadMethod(id);
      expect(card.execute.length).toBeLessThanOrEqual(700);
      expect(card.review.length).toBeLessThanOrEqual(500);
      expect(card.review).toMatch(/[Rr]eopen/);
    }
    expect(() => loadMethod("../catalog")).toThrow(/Unknown built-in method/);
  });

  it("persists selection through SQLite reopen without inventing evidence or replaying a renamed method", () => {
    const root = workspace();
    const store = new BlackboardStore(root, defaultConfig("Method persistence fixture"));
    stores.push(store);
    const usage = { input: 0, output: 0, cost: 0 };
    store.setStatus("running", "Fixture");
    store.beginRun("plan", "decide");
    store.applyDecision("plan", { summary: "Fixture", steps: [proposal(["baseline-authz"])] }, usage);
    store.close();
    const reopened = new BlackboardStore(root, defaultConfig("Method persistence fixture"));
    stores.push(reopened);
    const persisted = reopened.snapshot().steps[0]!;
    expect(persisted.methodIds).toEqual(["baseline-authz"]);
    expect(readFileSync(reopened.projectionPath, "utf8")).toContain("methods: baseline-authz");
    reopened.setStatus("running", "Resume fixture");
    const projected = projectStep(persisted);
    expect(projected.methodIds).toEqual(persisted.methodIds);
    projected.methodIds!.push("flow-chain");
    expect(persisted.methodIds).toEqual(["baseline-authz"]);
    reopened.beginRun("relabel", "decide");
    const board = reopened.applyDecision("relabel", { summary: "Same experiment, different guidance", steps: [proposal(["observer-validity"])] }, usage);
    expect(board.steps).toHaveLength(1);
    expect(board.steps[0]!.methodIds).toEqual(["baseline-authz"]);
    expect(board.facts).toEqual([]);
    expect(board.evidence).toEqual([]);
    expect(board.findings).toEqual([]);
    expect(board.outcome).toBeNull();
    reopened.beginRun("invalid", "decide");
    const before = reopened.snapshot();
    expect(() => reopened.applyDecision("invalid", { summary: "Invalid", steps: [proposal(["missing"])] }, usage)).toThrow();
    expect(reopened.snapshot()).toEqual(before);
    expect(reopened.runs().find(run => run.id === "invalid")?.status).toBe("running");
  });

  it("selects by explicit IDs even when task text contains other methods' keywords", () => {
    const input = request("execute", [step(["baseline-authz"])]);
    input.snapshot.config.goal = "WebAuthn FIDO patch CVE timing enumeration";
    const data = methods(input)!;
    expect(Object.keys(data.cards)).toEqual(["baseline-authz"]);
    expect(data.cards["baseline-authz"]).toContain(loadMethod("baseline-authz").execute);
    expect(data.cards["baseline-authz"]).toContain(loadMethod("baseline-authz").review);
    expect(data.catalog).toBeUndefined();
    expect(data.notice).toContain("not target evidence");
    input.step!.methodIds = undefined;
    expect(methods(input)).toBeUndefined();
    expect(input.snapshot.facts).toEqual([]);
  });

  it.each(["decide", "metacog"] as const)("gives %s a compact catalog and only relevant review text", mode => {
    expect(methods(request(mode))!.cards).toEqual({});
    const input = request(mode, [step(["baseline-authz"]), { ...step(["protocol-binding"], 1), status: "ready" }]);
    const data = methods(input)!;
    expect(data.catalog).toEqual(methodCatalog());
    expect(data.directory).toBe(methodsDirectory);
    expect(data.cards).toEqual({ "baseline-authz": loadMethod("baseline-authz").review });
    expect(JSON.stringify(data)).not.toContain(loadMethod("baseline-authz").execute);
  });

  it("retains methods from older causal Steps and exposes overflow without silently dropping it", () => {
    const steps = [step(["observer-validity"], 0), ...Array.from({ length: 9 }, (_, i) => step(undefined, i + 1))];
    const input = request("metacog", steps);
    input.snapshot.facts = [{ id: "F1", description: "Old fixture result", stepId: "S0", evidenceIds: [] }];
    const context = projectContext(input);
    expect(context.steps.map(item => item.id)).not.toContain("S0");
    expect(context.stepOrigins[0]?.methodIds).toEqual(["observer-validity"]);
    expect(methods(input)!.cards).toEqual({ "observer-validity": loadMethod("observer-validity").review });
    input.snapshot.steps = methodIds.slice(0, 5).map((id, i) => step([id], i));
    const data = methods(input)!;
    expect(Object.keys(data.cards)).toEqual(methodIds.slice(2, 5).reverse());
    expect(data.deferredIds).toEqual(methodIds.slice(0, 2).reverse());
  });

  it("reports unavailable historical IDs without inventing a replacement or loading arbitrary paths", () => {
    const data = methods(request("execute", [step(["../../private", "future-method", "flow-chain"])]))!;
    expect(data.unavailableIds).toEqual(["../../private", "future-method"]);
    expect(Object.keys(data.cards)).toEqual(["flow-chain"]);
  });

  it("bounds the total added JSON context including catalog, paths and all selected cards", () => {
    const largest = [...methodIds].sort((a, b) => {
      const size = (id: string) => { const card = loadMethod(id); return card.execute.length + card.review.length; };
      return size(b) - size(a);
    }).slice(0, 3);
    for (const mode of ["decide", "execute", "metacog"] as const) {
      const data = methods(request(mode, [step(largest)]))!;
      expect(JSON.stringify(data).length).toBeLessThanOrEqual(mode === "execute" ? 3_800 : 3_300);
      expect(JSON.stringify(data)).not.toMatch(/source_refs|cardSha256/);
    }
    expect(JSON.stringify(methods(request("decide"))).length).toBeLessThanOrEqual(1_900);
  });

  it("loads through the module installation path from an unrelated terminal directory", () => {
    const moduleUrl = new URL("../src/methods.ts", import.meta.url).href;
    const result = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({cwd:process.cwd(),count:Object.keys(m.methodCatalog()).length,card:m.loadMethod('flow-chain')}));`],
    { cwd: workspace(), encoding: "utf8" });
    const data = JSON.parse(result);
    expect(data.count).toBe(13);
    expect(data.card).toEqual(loadMethod("flow-chain"));
    expect(data.cwd).not.toBe(fileURLToPath(new URL("..", import.meta.url)));
  });
});
