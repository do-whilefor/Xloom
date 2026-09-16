import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";
import { createTaskReader, type TaskReadContext } from "../src/wiki/read.js";
import { createSemanticTaskReader, semanticLimits, type SemanticModel } from "../src/wiki/semantic.js";
import { clearRetrievalSnapshots } from "../src/wiki/incremental.js";
import { refKey } from "../src/wiki/catalog.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";

const fixtures: ReturnType<typeof wikiStructureFixture>[] = [], roots: string[] = [];
const query = "拿到凭条能否视作取件完成";
const path = `xloom://search?mode=wiki&query=${encodeURIComponent(query)}&strategy=semantic&budgetChars=64000&limit=2`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-semantic-")); roots.push(root);
  const f = wikiStructureFixture(root); fixtures.push(f);
  const generate = vi.fn<SemanticModel["generate"]>(async (stage, input: any) => stage === "expand"
    ? { groups: input.groups.map((group: any) => ({ id: group.id, queries: ["label returned", "download successful", "cross-account consumption"] })) }
    : stage === "index" ? { documents: input.documents.map((doc: any) => ({ id: doc.id, queries: ["拿到凭条能否视作取件完成", "receipt retrieval verification"] })) }
    : { scores: input.candidates.map((candidate: any) => ({ id: candidate.id, score: candidate.ref.pageId === "WK-flow" ? 100 : candidate.ref.kind === "block" ? 50 : 10 })) });
  const context: TaskReadContext = { dataDir: f.store.dataDir, snapshot: () => f.store.snapshot(), semantic: { identity: "fixture-model-v1", generate } };
  const reader = () => createSemanticTaskReader(root, context, createTaskReader(root, context));
  return { ...f, root, context, generate, reader };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
  clearRetrievalSnapshots();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-semantic-")) throw new Error("Unsafe semantic fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("model-assisted retrieval with authoritative source delivery", () => {
  it("recalls alternate expressions, reranks complete judgments and preserves source boundaries", async () => {
    const f = fixture(), before = f.store.snapshot();
    const lexical: any = await f.reader()(path.replace("strategy=semantic", "strategy=lexical"));
    expect(lexical.wiki.hits).toHaveLength(0); expect(f.generate).not.toHaveBeenCalled();
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("applied");
    expect(result.wiki.hits[0].ref).toMatchObject({ kind: "block", pageId: "WK-flow", id: "B-judgment" });
    expect(result.wiki.records.map((doc: any) => doc.text).join("\n")).toContain("Only alice / v1 was observed");
    expect(result.wiki.records.map((doc: any) => doc.text).join("\n")).toContain("Successful downloading is unverified");
    expect(result.complete).toBe(true); expect(JSON.stringify(result).length).toBeLessThanOrEqual(64000);
    expect(f.store.snapshot()).toEqual(before); expect(f.store.materialReceipts()).toEqual({});
    const rank = f.generate.mock.calls.find(([stage]) => stage === "rerank")![1] as any;
    const chosen = rank.candidates.find((item: any) => item.ref.pageId === "WK-flow");
    expect(chosen.records.some((doc: any) => doc.ref.id === "B-scope")).toBe(true);
  });
  it("persists hints across reader/process-cache restart and invalidates ranking after corrections or model changes", async () => {
    const f = fixture(); await f.reader()(path); f.generate.mockClear(); clearRetrievalSnapshots();
    const warm: any = await f.reader()(path);
    expect(warm.semantic).toMatchObject({ status: "applied", requests: 0 }); expect(warm.semantic.cacheHits).toBeGreaterThan(0);
    expect(f.generate).not.toHaveBeenCalled();
    f.correct();
    const changed: any = await f.reader()(path);
    expect(changed.semantic.status).toBe("applied");
    expect(f.generate.mock.calls.every(([stage]) => stage !== "expand")).toBe(true);
    expect(changed.semantic.indexedDocuments).toBeGreaterThan(0); expect(changed.semantic.reusedDocuments).toBeGreaterThan(0);
    expect(JSON.stringify(changed.wiki.records)).toContain("source_changed");
    f.generate.mockClear(); f.context.semantic!.identity = "fixture-model-v2";
    await f.reader()(path); expect(f.generate.mock.calls[0]![0]).toBe("expand");
    const db = new DatabaseSync(join(f.store.dataDir, "cache/retrieval.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT payload FROM entries WHERE namespace='semantic'").all();
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain("Only alice / v1 was observed");
    } finally { db.close(); }
  });
  it("rejects invented IDs and reports a lexical fallback without changing source state", async () => {
    const f = fixture(), before = f.store.snapshot();
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => args[0] !== "rerank" ? original(...args) : { scores: [{ id: "NOT_A_CANDIDATE", score: 100 }] });
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("failed_lexical_fallback");
    expect(JSON.stringify(result)).not.toContain("NOT_A_CANDIDATE");
    expect(f.store.snapshot()).toEqual(before);
  });
  it("indexes only a new Wiki judgment and keeps model hints outside author revisions", async () => {
    const f = fixture(); await f.reader()(path); f.generate.mockClear();
    f.submit([{ id: "WK-new", title: "Another observation", blocks: [{ id: "B-new", title: "New scope", text: "This separate check is unverified.", sources: [{ kind: "fact", id: f.factId }] }] }]);
    const before = f.store.snapshot(), result: any = await f.reader()(path);
    expect(result.semantic).toMatchObject({ status: "applied", indexedDocuments: 1, reusedDocuments: 4 });
    const inputs = f.generate.mock.calls.filter(([stage]) => stage === "index").flatMap(([, input]) => (input as any).documents);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].records[0].ref.pageId).toBe("WK-new");
    expect(f.store.snapshot()).toEqual(before);
  });
  it("accounts for semantic diagnostics within the source delivery budget", async () => {
    const f = fixture();
    for (const budget of [1024, 2048, 6000, 64000]) {
      const result: any = await f.reader()(path.replace("budgetChars=64000", `budgetChars=${budget}`));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      if (budget === 1024) expect(result.nextReadPath).toContain("strategy=semantic");
      if (budget === 64000 && result.nextReadPath) expect(result.nextReadPath).not.toBe(path);
    }
  });
  it("never reuses rankings across a board change while the model is running", async () => {
    const f = fixture(); let corrected = false;
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === "rerank" && !corrected) { corrected = true; f.correct(); }
      return result;
    });
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("sources_changed_lexical_fallback");
    expect(result.boardRevision).toBe(f.store.snapshot().revision);
  });
  it("uses the existing async read tool, respects cancellation and does not invoke models for malformed paths", async () => {
    const f = fixture(), controller = new AbortController();
    const tool = createWorkspaceReadTool(f.root, undefined, f.context);
    const result = await tool.execute("semantic", { path });
    expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}").semantic.status).toBe("applied");
    f.generate.mockClear();
    await expect(f.reader()(path + "&query=duplicate")).rejects.toThrow("parameters");
    expect(f.generate).not.toHaveBeenCalled();
    controller.abort();
    await expect(f.reader()(path + "&refresh=true", controller.signal)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("does not turn damaged original bytes into a valid semantic hit", async () => {
    const f = fixture(), evidence = f.store.snapshot().evidence[0]!;
    writeFileSync(join(f.store.dataDir, evidence.path), "tampered original");
    const result: any = await f.reader()(path.replace("mode=wiki", "mode=combined"));
    expect(result.complete).toBe(false);
    expect(result.originals?.hits.some((hit: any) => hit.locator.evidenceId === evidence.id)).not.toBe(true);
    expect(readFileSync(join(f.store.dataDir, evidence.path), "utf8")).toBe("tampered original");
  });
  it("preserves exact references even when the model prefers a different candidate", async () => {
    const f = fixture();
    const result: any = await f.reader()(path.replace(encodeURIComponent(query), encodeURIComponent("WK-context B-scope")));
    expect(result.wiki.hits[0]).toMatchObject({ ref: { kind: "block", pageId: "WK-context", id: "B-scope" }, reason: "exact_reference" });
    expect(result.semantic).toMatchObject({ status: "exact_reference_local", requests: 0 });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it.each(["wiki", "originals", "combined"])("excludes zero-score candidates from %s delivery and cached repeats", async mode => {
    const f = fixture(), before = f.store.snapshot(), original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (stage, input: any, signal) => stage === "rerank"
      ? { scores: input.candidates.map((item: any) => ({ id: item.id, score: 0 })) } : original(stage, input, signal));
    const target = path.replace("mode=wiki", `mode=${mode}`);
    const result: any = await f.reader()(target);
    expect(result.semantic).toMatchObject({ status: "applied" }); expect(result.semantic.zeroScoreCandidates).toBeGreaterThan(0);
    expect(result.wiki.hits).toEqual([]); expect(result.wiki.records).toEqual([]);
    expect(result.wiki.matchedCount).toBe(0); expect(result.wiki.matchQuality).toBe("no_informative_match");
    if (mode !== "wiki") { expect(result.originals.hits).toEqual([]); expect(result.originals.deferredWindows).toBe(0); }
    expect(result.complete).toBe(true); expect(result.answerSupport).toBe("not_assessed");
    clearRetrievalSnapshots(); f.generate.mockClear();
    const warm: any = await f.reader()(target);
    expect(warm.wiki.hits).toEqual([]); expect(warm.originals?.hits ?? []).toEqual([]);
    expect(warm.semantic.requests).toBe(0); expect(f.generate).not.toHaveBeenCalled();
    expect(f.store.snapshot()).toEqual(before);
  });
  it("keeps zero-score required sources and conditions with a relevant judgment", async () => {
    const f = fixture(), original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (stage, input: any, signal) => stage === "rerank"
      ? { scores: input.candidates.map((item: any) => ({ id: item.id, score: item.ref.pageId === "WK-flow" ? 1 : 0 })) } : original(stage, input, signal));
    const result: any = await f.reader()(path.replace("limit=2", "limit=1"));
    expect(result.wiki.hits.map((hit: any) => hit.ref.pageId)).toEqual(["WK-flow"]);
    expect(result.wiki.records.some((doc: any) => doc.ref.id === "B-scope")).toBe(true);
    expect(JSON.stringify(result.wiki.records)).toContain("Only alice / v1 was observed");
    expect(JSON.stringify(result.wiki.records)).toContain("Cross-account consumption is unverified");
  });
  it("filters a question's zero-score candidates without hiding the question's own source anchors", async () => {
    const f = fixture(), board = f.store.snapshot(), step = board.steps[0]!, original = f.generate.getMockImplementation()!;
    step.gaps = [{ id: "gap-contact", missing: "客服电话", why: "Unknown", reopenWhen: "A sourced number is observed", needs: [],
      conditions: { scope: null, identity: null, environment: null, stateVersion: null },
      sources: [{ source: { kind: "fact", id: f.scopeId }, reason: "Keep the recorded conditions" }] }];
    f.context.snapshot = () => board;
    f.generate.mockImplementation(async (stage, input: any, signal) => stage === "rerank"
      ? { scores: input.candidates.map((item: any) => ({ id: item.id, score: 0 })) } : original(stage, input, signal));
    const result: any = await f.reader()(`xloom://question?stepId=${step.id}&gapId=gap-contact&strategy=semantic&budgetChars=64000`);
    expect(result.semantic.status).toBe("applied"); expect(result.semantic.zeroScoreCandidates).toBeGreaterThan(0);
    expect(result.originals.hits).toEqual([]); expect(result.complete).toBe(true);
    expect(result.sourceContext.hits.map((hit: any) => hit.ref.id).sort()).toEqual([step.id, f.scopeId].sort());
    expect(JSON.stringify(result.sourceContext.records)).toContain("alice / v1");
    expect(result.answerSupport).toBe("not_assessed"); expect(step.gaps![0].review).toBeUndefined();
  });
  it.each(["wiki", "combined"])("keeps explicit references in mixed %s queries even at zero relevance", async mode => {
    const f = fixture(), original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (stage, input: any, signal) => stage === "rerank"
      ? { scores: input.candidates.map((item: any) => ({ id: item.id, score: 0 })) } : original(stage, input, signal));
    const evidence = f.store.snapshot().evidence[0]!;
    const explicit = mode === "wiki" ? "WK-context B-scope" : evidence.id;
    const result: any = await f.reader()(path.replace("mode=wiki", `mode=${mode}`).replace(encodeURIComponent(query), encodeURIComponent(`${explicit} ${query}`)));
    expect(result.semantic.status).toBe("applied"); expect(result.semantic.zeroScoreCandidates).toBeGreaterThan(0);
    expect(result.wiki.hits.some((hit: any) => hit.reason === "exact_reference" && hit.ref.id === (mode === "wiki" ? "B-scope" : evidence.id))).toBe(true);
    if (mode === "combined") expect(result.originals.hits.some((hit: any) => hit.locator.evidenceId === evidence.id)).toBe(true);
  });
  it("keeps unranked lexical candidates when the bounded ranking batch scores every supplied candidate zero", async () => {
    const f = fixture(), board = f.store.snapshot(), template = board.wikiPages![0]!, original = f.generate.getMockImplementation()!;
    board.wikiPages!.push(...Array.from({ length: 25 }, (_, i) => ({ ...structuredClone(template), id: `WK-deferred-${i}`, blocks: [{
      ...structuredClone(template.blocks[0]!), id: `B-deferred-${i}`, text: `label returned ${i}`, requiredBlockRefs: [], requiredBasis: [],
    }] })));
    f.context.snapshot = () => board;
    const rejected = new Set<string>();
    f.generate.mockImplementation(async (stage, input: any, signal) => {
      if (stage !== "rerank") return original(stage, input, signal);
      for (const item of input.candidates) rejected.add(refKey(item.ref));
      return { scores: input.candidates.map((item: any) => ({ id: item.id, score: 0 })) };
    });
    const result: any = await f.reader()(path);
    expect(result.semantic.deferredCandidates).toBeGreaterThan(0); expect(result.wiki.hits.length).toBeGreaterThan(0);
    expect(result.wiki.hits.every((hit: any) => !rejected.has(refKey(hit.ref)))).toBe(true);
  });
  it("bounds cold enrichment and ranking, prioritizes query matches and progressively reuses hints", async () => {
    const f = fixture(), board = f.store.snapshot(), template = board.wikiPages![0]!;
    board.wikiPages!.push(...Array.from({ length: 25 }, (_, i) => ({ ...structuredClone(template), id: `WK-cold-${i}`, blocks: [{
      ...structuredClone(template.blocks[0]!), id: `B-cold-${i}`, text: i === 24 ? "priorityNeedle; NOT verified outside alice/v1" : `Cold corpus observation ${i}`,
      requiredBlockRefs: [], requiredBasis: [],
    }] })));
    f.context.snapshot = () => board;
    const coldPath = path.replace(encodeURIComponent(query), "priorityNeedle");
    const first: any = await f.reader()(coldPath);
    expect(first.semantic).toMatchObject({ status: "applied", indexedDocuments: 8, deferredDocuments: 21, requests: 3 });
    const indexed = (f.generate.mock.calls.find(([stage]) => stage === "index")![1] as any).documents;
    expect(indexed.some((doc: any) => doc.records[0].ref.pageId === "WK-cold-24")).toBe(true);
    for (const stage of ["expand", "index", "rerank"] as const) {
      const inputs = f.generate.mock.calls.filter(([value]) => value === stage);
      expect(inputs).toHaveLength(1);
      expect(first.semantic.stages[stage]).toMatchObject({ requests: 1, inputChars: JSON.stringify(inputs[0]![1]).length });
      expect(first.semantic.stages[stage].elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(first.semantic.stages.index.inputChars).toBeLessThanOrEqual(semanticLimits.indexInputChars);
    expect(first.semantic.stages.rerank.inputChars).toBeLessThanOrEqual(semanticLimits.rerankInputChars);
    const ranking = f.generate.mock.calls.find(([stage]) => stage === "rerank")![1] as any;
    expect(ranking.candidates.length).toBeLessThanOrEqual(semanticLimits.rerankCandidates);
    f.generate.mockClear();
    const second: any = await f.reader()(coldPath);
    expect(second.semantic).toMatchObject({ indexedDocuments: 8, reusedDocuments: 8, deferredDocuments: 13 });
    const next = (f.generate.mock.calls.find(([stage]) => stage === "index")![1] as any).documents;
    expect(next.every((doc: any) => !indexed.some((old: any) => old.records[0].ref.pageId === doc.records[0].ref.pageId && old.records[0].ref.id === doc.records[0].ref.id))).toBe(true);
    await f.reader()(coldPath); await f.reader()(coldPath); f.generate.mockClear();
    const warm: any = await f.reader()(coldPath);
    expect(warm.semantic).toMatchObject({ indexedDocuments: 0, reusedDocuments: 29, deferredDocuments: 0, requests: 0 });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("defers oversized complete packages without sending truncated conditions to the model", async () => {
    const f = fixture(), board = f.store.snapshot(), template = board.wikiPages![0]!;
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => args[0] === "expand"
      ? { groups: (args[1] as any).groups.map((group: any) => ({ id: group.id, queries: [] })) } : original(...args));
    const text = "oversizeNeedle " + "qualification ".repeat(1000) + "NOT verified outside alice / v1";
    const dependencies = Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(template.blocks[0]!), id: `B-condition-${i}`,
      text: `Condition ${i}: ` + "qualification ".repeat(800), requiredBlockRefs: [], requiredBasis: [] }));
    board.wikiPages!.push({ ...structuredClone(template), id: "WK-oversize", blocks: [{ ...structuredClone(template.blocks[0]!),
      id: "B-oversize", text, requiredBlockRefs: [...dependencies.map(block => ({ pageId: "WK-oversize", blockId: block.id })),
        { pageId: "WK-context", blockId: "B-scope" }], requiredBasis: [] }, ...dependencies] });
    f.context.snapshot = () => board;
    const result: any = await f.reader()(path.replace(encodeURIComponent(query), "oversizeNeedle").replace("limit=2", "limit=1"));
    expect(result.semantic).toMatchObject({ status: "applied", oversizedDocuments: 1 });
    expect(result.semantic.deferredDocuments).toBeGreaterThanOrEqual(1);
    expect(result.semantic.oversizedCandidates).toBeGreaterThanOrEqual(1);
    for (const [stage, input] of f.generate.mock.calls) if (stage !== "expand") {
      expect(JSON.stringify(input).length).toBeLessThanOrEqual(48000);
      const records = (stage === "index" ? (input as any).documents : (input as any).candidates).flatMap((entry: any) => entry.records);
      expect(records.some((doc: any) => doc.ref.pageId === "WK-oversize" && doc.ref.id === "B-oversize")).toBe(false);
    }
    expect(result.wiki.records.find((doc: any) => doc.ref.pageId === "WK-oversize").text).toBe(text);
    for (const dependency of dependencies) expect(result.wiki.records.find((doc: any) => doc.ref.id === dependency.id).text).toBe(dependency.text);
    expect(JSON.stringify(result.wiki.records)).toContain("Only alice / v1 was observed");
  });
});
