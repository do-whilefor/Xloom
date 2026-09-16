import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";
import { factBasisReviews } from "../src/loop/fact-basis.js";
import { wikiBasis, wikiIssues, wikiRecord } from "../src/wiki/model.js";
import { createTaskReader } from "../src/wiki/read.js";
import { renderWiki } from "../src/wiki/projection.js";
import { capabilityIssues } from "../src/knowledge/model.js";
import { discoverKnowledge } from "../src/knowledge/discovery.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const board = observationRetrievalFixture(5);
  board.steps[1]!.from = ["F-0"];
  board.steps[2]!.from = ["F-1"];
  board.steps[3]!.from = ["F-0"];
  board.facts[3]!.supersedes = "F-0";
  board.steps[4]!.from = ["F-3"];
  return board;
}

describe("derived fact applicability", () => {
  it("propagates corrections while leaving corrected observations and unrelated descendants usable", () => {
    const board = fixture(), before = structuredClone(board), reviews = factBasisReviews(board);
    expect([...reviews.keys()].sort()).toEqual(["F-1", "F-2"]);
    expect(reviews.get("F-2")).toEqual({ staleFactIds: ["F-0"], replacementFactIds: ["F-3"], missingFactIds: [] });
    expect(wikiRecord(board, { kind: "fact", id: "F-2" })!.value).toMatchObject({ reviewIssues: ["basis_review_required"], basisReview: reviews.get("F-2") });
    expect(wikiRecord(board, { kind: "fact", id: "F-3" })!.value).not.toHaveProperty("reviewIssues");
    expect(board).toEqual(before);
  });
  it("handles missing prerequisites, cycles and newer replacements without hiding changed sources", () => {
    const board = fixture();
    board.steps[1]!.from.push("F-2", "F-missing");
    board.facts[4]!.supersedes = "F-3";
    const review = factBasisReviews(board).get("F-2")!;
    expect(review).toEqual({ staleFactIds: ["F-0"], replacementFactIds: ["F-3", "F-4"], missingFactIds: ["F-missing"] });
    board.steps[1]!.from = ["F-4"];
    expect(factBasisReviews(board).size).toBe(0);
  });
  it("exposes the same warning through exact reads, search and rendered Wiki", () => {
    const root = mkdtempSync(join(tmpdir(), "xloom-basis-")); roots.push(root);
    const board = fixture(), read = createTaskReader(root, { dataDir: root, snapshot: () => board });
    for (const path of ["xloom://record?kind=fact&id=F-2&budgetChars=64000", "xloom://search?mode=wiki&query=F-2&budgetChars=64000"]) {
      const result = read(path) as any;
      const record = (result.records ?? result.wiki.records).find((record: any) => record.ref.id === "F-2" && record.ref.kind === "fact");
      expect(record).toMatchObject({ status: "review_required", issues: [{ code: "basis_review_required" }] });
      expect(record.text).toContain('"staleFactIds":["F-0"]');
    }
    expect([...renderWiki(board, root, root).values()].some(text => text.includes('"id": "F-2"') && text.includes("basis_review_required"))).toBe(true);
    const sources = [{ kind: "fact" as const, id: "F-2" }];
    const page = { revision: 1, boardRevision: board.revision, title: "Derived claim", blocks: [{ id: "B-derived", title: "Derived claim", text: "Pending applicability", sources, basis: wikiBasis(board, sources) }] };
    expect(wikiIssues(board, page).some(issue => issue.reason === "source_review_required" && issue.id === "F-2")).toBe(true);
  });
  it("does not accept resealing a stale derived Fact as capability revalidation", () => {
    const board = fixture(), conditions = { scope: "fixture", identity: "alice", environment: "local", stateVersion: "v1" };
    const port = { type: "ticket", aliases: [], description: "Fixture ticket" };
    board.capabilities = ["C-provider", "C-consumer"].map(id => ({ id, title: id, status: "available", provides: [port], needs: id === "C-consumer" ? [port] : [],
      conditions, factIds: ["F-2"], counterFactIds: [], changeReason: "Fixture", revision: 1, history: [], basis: wikiBasis(board, [{ kind: "fact", id: "F-2" }]) }));
    expect(capabilityIssues(board, board.capabilities[0]!)).toContain("source_review_required");
    expect(discoverKnowledge(board).items[0]!.plan).toBeNull();
  });
});
