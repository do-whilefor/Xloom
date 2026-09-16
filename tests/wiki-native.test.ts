import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixtures/native-retrieval.js";
import { createTaskReader } from "../src/wiki/read.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { retrievalContext } from "../src/wiki/retrieval.js";
import { knowledgeContext } from "../src/knowledge/context.js";
import { gapContext, gapQueue } from "../src/knowledge/gaps.js";
import { decisionRepairGuidance } from "../src/loop/decision-input.js";
import { wikiIssues } from "../src/wiki/model.js";
import { evidencePath } from "../src/paths.js";
import { zero } from "./fixtures/native-retrieval.js";
import { retrievalFeedback } from "../src/wiki/feedback.js";

const opened: { root: string; fixture: ReturnType<typeof nativeFixture> }[] = [];
afterEach(() => { for (const { root, fixture } of opened.splice(0)) {
  fixture.store.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-native-")) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
} });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "xloom-native-")), fixture = nativeFixture(root); opened.push({ root, fixture });
  const context = { dataDir: fixture.store.dataDir, snapshot: () => fixture.store.snapshot() };
  return { ...fixture, root, context, read: createTaskReader(root, context) as (path: string) => any };
}

describe("native explicit search and capability discovery", () => {
  it("provides a working continuation for deferred Fact source packages and distinguishes budget exhaustion from missing sources", () => {
    const { root, store } = setup(); const board = store.snapshot();
    board.steps[0]!.evidencePlan = "A long recorded evidence plan with required comparisons. ".repeat(400);
    const read = createTaskReader(root, { dataDir: store.dataDir, snapshot: () => board });
    const metadata = read(`xloom://record?kind=evidence&id=${board.evidence[0]!.id}`);
    expect(metadata).toMatchObject({ complete: false, status: "source_package_deferred" });
    expect(metadata.records).toContainEqual(expect.objectContaining({ ref: { kind: "evidence", id: board.evidence[0]!.id },
      navigation: [{ kind: "step", id: board.steps[0]!.id }] }));
    expect(metadata.records.some((record: any) => record.ref.kind === "fact")).toBe(false);
    expect(metadata.deferredCount).toBeGreaterThan(0);
    const ref = board.facts[0]!;
    const path = `xloom://record?kind=fact&id=${ref.id}`;
    const first = read(path) as ReturnType<typeof read> & { nextReadPath: string };
    expect(first).toMatchObject({ hits: [], records: [], deferredCount: 1, complete: false, status: "source_package_deferred", retrievalProgress: "resolve_incomplete_retrieval" });
    expect(retrievalFeedback(first)).toContain(ref.id);
    expect(retrievalFeedback(first)).toContain("来源包超过本次预算");
    expect(retrievalFeedback(first)).toContain(first.nextReadPath);
    expect(read(path)).toMatchObject({ retrievalProgress: "stop_repeating_incomplete_query" });
    const complete = read(first.nextReadPath);
    expect(complete).toMatchObject({ complete: true });
    expect(JSON.stringify(complete)).toContain(board.steps[0]!.evidencePlan);
    expect(JSON.stringify(complete).length).toBeLessThanOrEqual(64000);
    board.facts[0]!.evidenceIds.push("E-missing");
    const missing = read(first.nextReadPath);
    expect(missing).toMatchObject({ complete: false, status: "source_missing" });
    expect(retrievalFeedback(missing)).toContain("扩大预算不能恢复来源");
    expect(missing).not.toHaveProperty("nextReadPath");
  });
  it("finds authored judgments absent from original text and exposes queries to read-only planning", async () => {
    const { store, root, read, context } = setup();
    expect(read("xloom://search?query=BridgeNote")).toMatchObject({ type: "original_search", hits: [] });
    const tool = createWorkspaceReadTool(root, undefined, context);
    const result = JSON.parse((await tool.execute("wiki", { path: "xloom://search?mode=wiki&query=BridgeNote" })).content[0]!.text as string);
    expect(result).toMatchObject({ type: "task_search", mode: "wiki", complete: true, answerSupport: "not_assessed" });
    expect(result.wiki.hits[0].ref).toMatchObject({ kind: "block", id: "B-boundary" });
    expect(JSON.stringify(result)).toContain("尚未观察到报表内容"); expect(result.originals).toBeUndefined();
    const request = { id: "R", mode: "decide" as const, snapshot: store.snapshot(), workspace: root, runDir: "R", blackboardPath: store.projectionPath,
      signal: new AbortController().signal, onEvent() {} };
    expect(retrievalContext(request)!.search.readPath).toContain("mode=combined");
    expect(knowledgeContext(request)!.capabilities[0]!.discoverReadPath).toBe("xloom://discover?consumerId=C-download");
    expect(tool.description).toContain("discover?consumerId");
  });
  it("retains corrections and original locators across fresh readers without marking old explanations reviewed", () => {
    const { store, root, context, read, addProvider } = setup();
    const missing = read("xloom://discover?consumerId=C-download");
    expect(missing.items[0]).toMatchObject({ consumerId: "C-download", plan: null });
    addProvider(); const before = store.snapshot(), fresh = createTaskReader(root, context) as (path: string) => any;
    const result = fresh("xloom://search?mode=combined&query=BridgeNote%20downloadGrant&budgetChars=64000");
    expect(result.complete).toBe(true); expect(result.originals.hits.length).toBeGreaterThan(0);
    expect(result.wiki.records).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ kind: "block" }), status: "review_required" }));
    expect(JSON.stringify(result.wiki)).toContain("actual download remains unverified");
    const original = fresh(result.originals.hits.find((hit: any) => hit.snippet.includes("LOCAL_ONLY")).readPath);
    expect(original).toMatchObject({ integrity: "verified" }); expect(original.text).toContain("download=NOT_ATTEMPTED");
    const discovered = fresh("xloom://discover?consumerId=C-download&budgetChars=64000");
    expect(discovered).toMatchObject({ complete: true, items: [{ consumerId: "C-download", plan: { capabilityIds: ["C-grant", "C-download"], requirementsCovered: true, actualConsumption: "not_assessed" } }] });
    expect(JSON.stringify(discovered.sourceContext)).toContain("No grant was observed");
    expect(wikiIssues(store.snapshot(), store.snapshot().wikiPages![0]!)).not.toEqual([]);
    expect(store.snapshot()).toEqual(before); expect(gapQueue(before)[0]!.state).not.toBe("resolved");
  });
  it("isolates explicit modes, original integrity, and private chat", async () => {
    const { store, root, read, addProvider } = setup(); addProvider();
    const evidence = store.snapshot().evidence.at(-1)!;
    writeFileSync(evidencePath(evidence, store.dataDir, root), "tampered original");
    expect(read("xloom://search?mode=wiki&query=BridgeNote&budgetChars=64000").complete).toBe(true);
    const combined = read("xloom://search?mode=combined&query=downloadGrant&budgetChars=64000");
    expect(combined.complete).toBe(false); expect(combined.originals.issues).not.toEqual([]);
    expect(combined.originals.hits.some((hit: any) => hit.locator.evidenceId === evidence.id)).toBe(false);
    expect(() => read("xloom://discover?consumerId=C-foreign")).toThrow("Unknown consumer");
    const privateChat = createWorkspaceReadTool(root);
    await expect(privateChat.execute("private", { path: "xloom://search?mode=wiki&query=BridgeNote" })).rejects.toThrow("outside a research task");
  });
  it("keeps a consumer blocked on newly declared counterevidence even after a compatible supplier arrives", () => {
    const { store, read, oldFactId, addProvider } = setup(); const sourceId = store.snapshot().facts[0]!.id;
    store.beginRun("declare-counterevidence", "decide");
    store.applyDecision("declare-counterevidence", { summary: "Declare source context that needs review", steps: [{ goalId: "G0", from: [sourceId],
      description: "Check missing local input", successSignal: "New local observation", evidencePlan: "Keep original", priority: 1,
      combination: { requires: [sourceId], missing: ["downloadGrant"], scope: "local report", stateVersion: "v1", expectedCapability: "Local download input",
        counterEvidence: [oldFactId] } }] }, zero);
    addProvider(); const before = store.snapshot(), result = read("xloom://discover?consumerId=C-download&budgetChars=64000");
    expect(result.complete).toBe(true); expect(result.items[0]).toMatchObject({ plan: null, reviewIssues: ["source_changed"],
      inputs: [{ alternatives: [{ producerId: "C-grant", conditions: { status: "compatible" }, reviewIssues: [] }] }] });
    expect(JSON.stringify(result.sourceContext)).toContain("counterContexts");
    expect(store.snapshot()).toEqual(before);
  });
  it("explains the original Goal binding and rejects a model's child-Goal revisit without mutation", () => {
    const { store, step } = setup(); store.beginRun("wrong-goal", "decide"); const before = store.snapshot();
    expect(() => store.applyDecision("wrong-goal", { summary: "Wrong child Goal", goals: [{ id: "G-child", parentId: "G0", description: "New subgoal" }],
      steps: [{ goalId: "G-child", from: [], description: "Revisit old input", successSignal: "Local observation", evidencePlan: "Keep source", priority: 1,
        revisits: [{ stepId: step.id, gapId: "gap-download" }] }] }, zero)).toThrow('expected goalId="G0", received "G-child"');
    expect(store.snapshot()).toEqual(before);
    expect(gapContext(before).notice).toContain("copy the original gap's goalId unchanged");
    expect(decisionRepairGuidance("A revisit must retain the original gap's Goal.")).toContain("Do not silently drop revisits");
  });
  it("keeps complete source packages within budgets and reports top-k separately from budget failures", () => {
    const { read, addProvider } = setup(); addProvider();
    for (const path of ["xloom://search?mode=wiki&query=BridgeNote", "xloom://search?mode=combined&query=downloadGrant", "xloom://discover?consumerId=C-download"]) {
      for (const budget of [1024, 4000, 16000, 64000]) {
        const result = read(`${path}&budgetChars=${budget}`);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
        if (result.status === "budget_exhausted") { expect(result.complete).toBe(false); expect(result.wiki).toBeUndefined(); expect(result.originals).toBeUndefined(); expect(result.sourceContext).toBeUndefined(); }
      }
    }
    const limited = read("xloom://search?mode=wiki&query=local&limit=1&budgetChars=64000");
    expect(limited.wiki.deferredCount).toBeGreaterThan(0); expect(limited.wiki.budgetDeferredCount).toBe(0); expect(limited.complete).toBe(true);
  });
  it("keeps navigation to an oversized judgment without delivering its unsupported partial text", () => {
    const { root, store } = setup(); const board = store.snapshot(); board.wikiPages![0]!.blocks[0]!.text = "Full judgment and conditions. ".repeat(500);
    const read = createTaskReader(root, { dataDir: store.dataDir, snapshot: () => board });
    const result = read("xloom://search?mode=wiki&query=BridgeNote&budgetChars=4000") as any;
    expect(result).toMatchObject({ status: "budget_exhausted", complete: false, deferredRefs: [{ kind: "block", pageId: "WK-bridge", id: "B-boundary" }] });
    expect(JSON.stringify(result)).not.toContain("Full judgment"); expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
  });
  it("detects repeated delivered queries but allows new material and fresh roles to read again", () => {
    const { read, addProvider, root, context } = setup(), path = "xloom://search?mode=wiki&query=BridgeNote&budgetChars=64000";
    expect(read(path).retrievalProgress).toBe("inspect_material");
    expect(read(path).retrievalProgress).toBe("stop_repeating_query");
    addProvider(); expect(read(path).retrievalProgress).toBe("inspect_material");
    expect((createTaskReader(root, context)(path) as any).retrievalProgress).toBe("inspect_material");
    const large = "xloom://discover?consumerId=C-download&budgetChars=1024";
    expect(read(large).retrievalProgress).toBe("resolve_incomplete_retrieval");
    expect(read(large).retrievalProgress).toBe("stop_repeating_incomplete_query");
    expect(read("xloom://discover?consumerId=C-download&budgetChars=64000").retrievalProgress).toBe("inspect_material");
    expect(read("xloom://discover?consumerId=C-download&budgetChars=64000").retrievalProgress).toBe("stop_repeating_query");
  });
  it("focuses an omitted old consumer without filtering its providers, retaining incompatible and undeclared conditions", () => {
    const { store, root, addProvider } = setup(); addProvider(); const board = store.snapshot();
    const consumer = board.capabilities!.find(item => item.id === "C-download")!;
    board.capabilities!.push(...Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(consumer), id: `C-recent-${i}` })));
    const read = createTaskReader(root, { dataDir: store.dataDir, snapshot: () => board }) as (path: string) => any;
    expect(read("xloom://discover?limit=1&budgetChars=64000").omittedConsumerIds).toContain("C-download");
    const focused = "xloom://discover?consumerId=C-download&budgetChars=64000";
    expect(read(focused).items.map((item: any) => item.consumerId)).toEqual(["C-download"]);
    expect(read(focused).items[0].plan.capabilityIds).toContain("C-grant");
    const provider = board.capabilities!.find(item => item.id === "C-grant")!; provider.conditions.identity = "bob";
    expect(read(focused).items[0]).toMatchObject({ plan: null, inputs: [{ alternatives: [{ conditions: { status: "conflict" } }] }] });
    provider.conditions.identity = null;
    expect(read(focused).items[0].plan.conditions.status).toBe("unknown");
    const sourceOnly = read("xloom://discover?consumerId=C-grant&budgetChars=64000");
    expect(sourceOnly.items).toEqual([]); expect(sourceOnly.sourceContext.records.length).toBeGreaterThan(0);
  });
  it.each(["search?mode=bad&query=a", "search?mode=wiki&query=a&mode=combined", "search?mode=wiki&query=a&limit=0", "search?mode=wiki&query=a&limit=21",
    "search?mode=wiki&query=a&budgetChars=64001", "discover?consumerId=", "discover?maxAlternatives=21", "discover?maxAlternatives=0", "discover?query=a", "discover?workspace=C:/other"])("rejects malformed or foreign query parameters: %s", suffix => {
    const { read } = setup(); expect(() => read(`xloom://${suffix}`)).toThrow();
  });
});
