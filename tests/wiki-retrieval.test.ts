import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import type { BoardSnapshot, RunRequest } from "../src/types.js";
import { buildRetrievalIndex, organizeWiki, terms } from "../src/wiki/catalog.js";
import { retrieveWiki, retrievalContext } from "../src/wiki/retrieval.js";
import { wikiBasis } from "../src/wiki/model.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";

function fixture(): BoardSnapshot {
  const board: BoardSnapshot = { revision: 4, config: defaultConfig("Inspect export authorization"), status: "running", outcome: null, reason: "",
    goals: [{ id: "G0", parentId: null, description: "Inspect export authorization", status: "active", factIds: [] }], steps: [],
    facts: [{ id: "F-old", stepId: null, description: "Export job returns an identifier; report download remains unverified.", evidenceIds: ["E-old"] }],
    evidence: [{ id: "E-old", path: "evidence/fixture.bin", pathBase: "task", sha256: "a".repeat(64), bytes: 4, description: "Original fixture response", stepId: "S-origin", runId: "PRIVATE_RUN", excerpt: "PRIVATE_RAW_BODY" }],
    findings: [], hints: [], attempts: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
  board.steps.push({ id: "S-origin", goalId: "G0", from: [], description: "Observe report job", successSignal: "Job identifier", evidencePlan: "Preserve original", priority: 1,
    status: "done", attempts: 1, runId: "PRIVATE_RUN", leaseUntil: null, combination: { requires: [], missing: ["Consumer authorization is untested"], scope: "tenant-a", stateVersion: "v1", expectedCapability: "Not established" } });
  board.wikiPages = [{ id: "WK-export", title: "报表导出与下载权限", revision: 1, boardRevision: 4, history: [], blocks: [{ id: "B-download", title: "下载对象边界",
    text: "导出任务返回标识，但跨账户下载尚未验证。仅适用于 tenant-a / v1，不能据此认定数据泄露。",
    sources: [{ kind: "fact", id: "F-old" }], basis: wikiBasis(board, [{ kind: "fact", id: "F-old" }]) }] }];
  return board;
}
const task = join(process.cwd(), "synthetic-task"), workspace = process.cwd();

describe("task-local lexical RAG and organization", () => {
  it("finds Chinese judgments and identifier components without changing the full negation", () => {
    const board = fixture();
    const result = retrieveWiki(board, task, workspace, "下载权限", { limit: 1 });
    expect(result.hits[0]?.ref).toEqual({ kind: "block", pageId: "WK-export", id: "B-download" });
    expect(JSON.stringify(result.records)).toContain(board.wikiPages![0]!.blocks[0]!.text);
    expect(terms("downloadReport /api/report_export Ｔｅｎａｎｔ 下载权限")).toEqual(expect.arrayContaining(["downloadreport", "download", "report", "api/report_export", "export", "tenant", "下载", "载权", "权限"]));
    board.facts.push({ id: "F-method", stepId: null, description: "downloadReport preserves tenant scope", evidenceIds: [] });
    expect(retrieveWiki(board, task, workspace, "download", { limit: 1 }).hits[0]?.ref.id).toBe("F-method");
  });

  it("keeps exact typed IDs ahead of keyword matches and does not match truncated IDs", () => {
    const board = fixture();
    expect(retrieveWiki(board, task, workspace, "F-old download").hits[0]).toMatchObject({ ref: { kind: "fact", id: "F-old" }, reason: "exact_reference" });
    expect(retrieveWiki(board, task, workspace, "F-ol").hits).toEqual([]);
    expect(retrieveWiki(board, task, workspace, "", { anchors: [{ kind: "block", id: "B-download", pageId: "WK-export" }] }).hits).toHaveLength(1);
    expect(retrieveWiki(board, task, workspace, "", { anchors: [{ kind: "fact", id: "FOREIGN" }] }).missingAnchors).toEqual([{ kind: "fact", id: "FOREIGN" }]);
  });

  it("packages explicit corrections, refutations and original paths with the old judgment", () => {
    const board = fixture();
    board.facts.push({ id: "F-correction", stepId: null, description: "A later fixture refutes the earlier implication", evidenceIds: ["E-old"], supersedes: "F-old" });
    board.attempts!.push({ id: "A-refutation", stepId: "S-origin", hypothesis: "export", scope: "tenant-b", identity: "bob", stateVersion: "v2", baseline: "normal download",
      changedVariable: "owner", outcome: "refutes", observation: "Access denied in a different state; not a global disproof", evidenceIds: ["E-old"], conditionKey: "PRIVATE", outcomeKey: "PRIVATE", runId: "PRIVATE" });
    const result = retrieveWiki(board, task, workspace, "", { anchors: [{ kind: "block", id: "B-download", pageId: "WK-export" }] });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("source_changed");
    expect(serialized).toContain("F-correction"); expect(serialized).toContain("A-refutation");
    expect(serialized).toContain("not a global disproof"); expect(serialized).toContain("tenant-b");
    expect(result.records).toContainEqual(expect.objectContaining({ ref: { kind: "evidence", id: "E-old" }, originalFile: join(task, "evidence/fixture.bin"), integrity: "not_checked" }));
    expect(result.evidence).toBe(false);
  });

  it("keeps missing sources visible and terminates explicit cycles", () => {
    const board = fixture(); board.steps[0]!.from = ["F-old", "F-missing"];
    const result = retrieveWiki(board, task, workspace, "F-old");
    expect(result.records).toContainEqual({ ref: { kind: "fact", id: "F-missing" }, status: "source_missing" });
    expect(result.records.filter(item => JSON.stringify(item).includes('"ref":{"kind":"fact","id":"F-old"}'))).toHaveLength(1);
    expect(organizeWiki(board).missingSources).toContainEqual(expect.objectContaining({ source: { kind: "fact", id: "F-missing" } }));
    board.goals[0]!.parentId = "G-missing";
    expect(organizeWiki(board).missingNavigation).toContainEqual(expect.objectContaining({ source: { kind: "goal", id: "G-missing" } }));
  });

  it("defers an entire large judgment/source package instead of truncating conditions", () => {
    const board = fixture(); board.wikiPages![0]!.blocks[0]!.text = "Limit applies only to this identity. ".repeat(400) + "NOT verified for other tenants.";
    const result = retrieveWiki(board, task, workspace, "", { anchors: [{ kind: "block", id: "B-download", pageId: "WK-export" }], budgetChars: 8000 });
    expect(result.hits).toEqual([]); expect(result.records).toEqual([]); expect(result.deferredCount).toBe(1);
    expect(result.deferred[0]).toEqual({ kind: "block", id: "B-download", pageId: "WK-export" });
    const full = retrieveWiki(board, task, workspace, "", { anchors: result.deferred });
    expect(JSON.stringify(full.records)).toContain(board.wikiPages![0]!.blocks[0]!.text);
  });

  it("excludes private runtime fields, raw excerpts, author history and another task", () => {
    const board = fixture(), other = fixture(); other.wikiPages![0]!.blocks[0]!.text = "UNIQUE_OTHER_TASK";
    board.wikiPages![0]!.history.push({ ...board.wikiPages![0]!, title: "PRIVATE_HISTORY", blocks: [] });
    Object.assign(board.wikiPages![0]!.blocks[0], { privateMessage: "PRIVATE_MESSAGE" });
    Object.assign(board.facts[0]!, { apiKey: "PRIVATE_KEY", messages: "PRIVATE_MESSAGE" });
    const index = buildRetrievalIndex(board), result = retrieveWiki(board, task, workspace, "下载");
    expect(JSON.stringify([index, result, organizeWiki(board)])).not.toMatch(/PRIVATE|UNIQUE_OTHER_TASK/);
    expect(retrieveWiki(board, task, workspace, "UNIQUE_OTHER_TASK").hits).toEqual([]);
    expect(retrieveWiki(other, join(task, "other"), workspace, "UNIQUE_OTHER_TASK").hits.length).toBeGreaterThan(0);
  });

  it("rebuilds ranking after a rename, removed block or changed source without accepting an old index", () => {
    const board = fixture(), first = buildRetrievalIndex(board);
    board.wikiPages![0]!.title = "UniqueRenamedTopic";
    const renamed = buildRetrievalIndex(board);
    expect(renamed.signature).not.toBe(first.signature);
    expect(retrieveWiki(board, task, workspace, "UniqueRenamedTopic").hits[0]?.ref.kind).toBe("block");
    board.wikiPages![0]!.blocks = [];
    expect(retrieveWiki(board, task, workspace, "UniqueRenamedTopic").hits).toEqual([]);
    const index = buildRetrievalIndex(board);
    const { index: suppliedStats, ...supplied } = retrieveWiki(board, task, workspace, "report", {}, JSON.parse(JSON.stringify(index)));
    const { index: rebuiltStats, ...rebuilt } = retrieveWiki(board, task, workspace, "report");
    expect(supplied).toEqual(rebuilt);
    expect(suppliedStats).toBeUndefined(); expect(rebuiltStats?.added).toBe(index.documents.length);
  });

  it("does not inflate relevance with hashes or link IDs and preserves meaningful business strings", () => {
    const board = fixture();
    expect(retrieveWiki(board, task, workspace, "a".repeat(64)).hits).toEqual([]);
    board.evidence[0]!.path = "evidence/qzxvpath.bin";
    expect(retrieveWiki(board, task, workspace, "qzxvpath.bin").hits).toEqual([]);
    expect(retrieveWiki(board, task, workspace, "tenant-a").hits.length).toBeGreaterThan(0);
  });

  it("organizes exact duplicate text and source warnings without merging pages or acknowledging changes", () => {
    const board = fixture();
    board.wikiPages!.push({ ...structuredClone(board.wikiPages![0]!), id: "WK-other", title: "Different source scope" });
    board.facts[0]!.description = "Corrected current text";
    board.evidence.push({ ...board.evidence[0]!, id: "E-unreferenced" });
    const before = structuredClone(board), result = organizeWiki(board);
    expect(result.duplicateText[0]!.refs).toHaveLength(2); expect(result.reviewRequired).toHaveLength(2);
    expect(result.unreferencedEvidenceIds).toEqual(["E-unreferenced"]);
    expect(result.topics.map(topic => topic.id)).toEqual(["WK-export", "WK-other"]);
    expect(board).toEqual(before);
  });

  it("adds bounded retrieval to research context without growing system prompts or loading ordinary chat", () => {
    const request: RunRequest = { id: "R", mode: "execute", snapshot: fixture(), workspace, runDir: join(task, "runs/R"), step: fixture().steps[0]!, signal: new AbortController().signal, onEvent() {} };
    expect(retrievalContext(request)).toBeUndefined();
    const previous = buildRunPrompt(request);
    request.blackboardPath = join(task, "blackboard.md");
    const current = buildRunPrompt(request), rag = JSON.parse(current.userPrompt.split("\n").at(-1)!).rag;
    expect(current.systemPrompt).toBe(previous.systemPrompt); expect(rag.local.taskDirectory).toBe(task);
    expect(rag.hits.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify({ hits: rag.hits, records: rag.records }).length).toBeLessThanOrEqual(8000);
    request.mode = "decide"; expect(retrievalContext(request)).not.toHaveProperty("local");
    request.wikiProjectionError = "Unreadable Wiki"; expect(retrievalContext(request)).toMatchObject({ projection: "unavailable", projectionReason: "Unreadable Wiki" });
  });

  it.each([{ limit: 0 }, { limit: 1.1 }, { budgetChars: -1 }, { budgetChars: NaN }])("rejects invalid caller limits %j", options => {
    expect(() => retrieveWiki(fixture(), task, workspace, "report", options)).toThrow("positive integers");
  });
});
