import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptKeys } from "../src/loop/attempts.js";
import { retrievalDocuments, type RetrievalRef } from "../src/wiki/catalog.js";
import { clearRetrievalSnapshots } from "../src/wiki/incremental.js";
import { createTaskReader } from "../src/wiki/read.js";
import type { Attempt } from "../src/types.js";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";

const roots: string[] = [];
afterEach(() => {
  clearRetrievalSnapshots();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-catalog-provenance-")) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("archive origins in observation source packages", () => {
  it("keeps shared Evidence's archive Step navigable without inheriting that Step's unrelated prerequisites", () => {
    const root = mkdtempSync(join(tmpdir(), "xloom-catalog-provenance-")); roots.push(root);
    // Metadata-only record reads: S-0 captured E-0 using F-2, while independent
    // S-1 produced its own Fact/Attempt with the same content-addressed bytes.
    const board = observationRetrievalFixture(3); board.wikiPages = [];
    board.evidence = board.evidence.filter(item => item.id !== "E-1");
    board.facts[1]!.evidenceIds = ["E-0"];
    board.steps[0]!.from = ["F-2"];
    board.attempts = [0, 1, 2].map((i): Attempt => {
      const attempt = { id: `A-${i}`, stepId: `S-${i}`, runId: "fixture", evidenceIds: [i === 1 ? "E-0" : `E-${i}`],
        hypothesis: `independent-${i}`, scope: `object-${i}`, identity: `user-${i}`, stateVersion: "v1",
        baseline: "Owner request", changedVariable: "requester", outcome: "refutes" as const, observation: "DENIED" };
      return { ...attempt, ...attemptKeys(attempt) };
    });
    const documents = retrievalDocuments(board).documents;
    const evidence = documents.find(item => item.ref.kind === "evidence" && item.ref.id === "E-0")!;
    expect.soft(evidence.sources).not.toContainEqual({ kind: "step", id: "S-0" });
    expect.soft(evidence.navigation).toContainEqual({ kind: "step", id: "S-0" });
    expect.soft(JSON.parse(evidence.text)).toMatchObject({ stepId: "S-0" });
    for (const kind of ["fact", "attempt"] as const) {
      expect(documents.find(item => item.ref.kind === kind && item.ref.id === (kind === "fact" ? "F-0" : "A-0"))!.sources)
        .toContainEqual({ kind: "step", id: "S-0" });
    }

    const read = createTaskReader(root, { dataDir: root, snapshot: () => board });
    const refs = (kind: "fact" | "attempt" | "step", id: string) => {
      const result = read(`xloom://record?kind=${kind}&id=${id}&budgetChars=64000`) as { complete: boolean; records: { ref: RetrievalRef }[] };
      expect(result.complete).toBe(true);
      return result.records.map(record => record.ref);
    };
    const independent = refs("fact", "F-1");
    expect.soft(independent).toEqual(expect.arrayContaining([{ kind: "fact", id: "F-1" }, { kind: "evidence", id: "E-0" },
      { kind: "step", id: "S-1" }, { kind: "attempt", id: "A-1" }]));
    for (const ref of [{ kind: "step", id: "S-0" }, { kind: "fact", id: "F-2" }, { kind: "evidence", id: "E-2" }, { kind: "attempt", id: "A-2" }]) {
      expect.soft(independent).not.toContainEqual(ref);
    }
    // The producing Fact/Attempt still has its real causal prerequisites, and
    // following the archive's navigation pointer remains an explicit read.
    for (const [kind, id] of [["fact", "F-0"], ["attempt", "A-0"], ["step", "S-0"]] as const) {
      expect(refs(kind, id)).toEqual(expect.arrayContaining([{ kind: "fact", id: "F-2" }, { kind: "attempt", id: "A-2" }]));
    }
    expect.soft(refs("fact", "F-1")).toEqual(independent);
  });
});
