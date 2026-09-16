import { describe, expect, it } from "vitest";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";
import { buildRetrievalIndex } from "../src/wiki/catalog.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";
import { join } from "node:path";

const task = join(process.cwd(), "synthetic-rag-fixture"), workspace = process.cwd();
describe("retrieval precision with complete source packages", () => {
  it("does not deliver weak question-word matches for an absent identifier", () => {
    const board = observationRetrievalFixture(0);
    board.facts = Array.from({ length: 120 }, (_, i) => ({ id: `F-${i}`, stepId: null, evidenceIds: [], description: `The ordinary response for item ${i} is present.` }));
    const result = retrieveWiki(board, task, workspace, "What is the result for zqvnosuchidentifier?", {}, buildRetrievalIndex(board));
    expect(result).toMatchObject({ hits: [], records: [], matchedCount: 0, matchQuality: "no_informative_match" });
    expect(result.ignoredQueryTerms).toEqual(expect.arrayContaining(["what", "is", "the", "for"]));
  });
  it("preserves negation and exact identifiers while omitting unrelated shared-Goal facts", () => {
    const board = observationRetrievalFixture(3);
    board.goals[0]!.factIds = board.facts.map(fact => fact.id);
    board.facts[0]!.description = "GET /api/for returns 403; NOT verified outside alice/v1.";
    const result = retrieveWiki(board, task, workspace, "What is F-0?", { limit: 1 }, buildRetrievalIndex(board));
    expect(result.hits[0]!.reason).toBe("exact_reference");
    const refs = result.records.map(record => (record as any).ref.id);
    expect(refs).toEqual(expect.arrayContaining(["F-0", "E-0", "S-0"]));
    expect(refs).not.toContain("F-1"); expect(refs).not.toContain("F-2");
    expect(result.records.find(record => (record as any).ref.id === "S-0")).toMatchObject({ navigation: [{ kind: "goal", id: "G0" }] });
    for (const query of ["NOT", "403", "/api/for"]) expect(retrieveWiki(board, task, workspace, query, { limit: 1 }, buildRetrievalIndex(board)).hits[0]!.ref.id).toBe("F-0");
    const goal = retrieveWiki(board, task, workspace, "G0", { limit: 1 }, buildRetrievalIndex(board));
    expect(goal.records.map(record => (record as any).ref.id)).toEqual(expect.arrayContaining(["F-0", "F-1", "F-2"]));
  });
  it("keeps complete query matches above repeated single-token distractors without deleting partial matches", () => {
    const board = observationRetrievalFixture(100);
    board.facts.push({ id: "F-complete", stepId: null, evidenceIds: [], description: "rareMarker scopedDownload" },
      { id: "F-distractor", stepId: null, evidenceIds: [], description: "rareMarker ".repeat(100) });
    const index = buildRetrievalIndex(board);
    const result = retrieveWiki(board, task, workspace, "rareMarker scopedDownload", { limit: 4 }, index);
    expect(result.hits[0]!.ref.id).toBe("F-complete");
    expect(result.hits.map(hit => hit.ref.id)).toContain("F-distractor");
    expect(retrieveWiki(board, task, workspace, "F-distractor rareMarker scopedDownload", { limit: 1 }, index).hits[0]!.reason).toBe("exact_reference");
  });
  it.each(["item40 downloadReport", "F-40", "item40 下载边界"])("recalls known content with its negative conditions and provenance: %s", query => {
    const board = observationRetrievalFixture(100), before = structuredClone(board);
    const result = retrieveWiki(board, task, workspace, query, { limit: 1 }, buildRetrievalIndex(board));
    expect(result.budgetDeferredCount).toBe(0);
    expect(result.records).toContainEqual(expect.objectContaining({ ref: { kind: "fact", id: "F-40" } }));
    expect(result.records).toContainEqual(expect.objectContaining({ ref: { kind: "evidence", id: "E-40" }, integrity: "not_checked" }));
    expect(JSON.stringify(result.records)).toContain("NOT verified"); expect(board).toEqual(before);
  });
});
