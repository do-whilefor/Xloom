import { describe, expect, it } from "vitest";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";
import { projectContext } from "../src/loop/context.js";
import { createTaskReader } from "../src/wiki/read.js";
import type { RunRequest } from "../src/types.js";

function fixture(size: number) {
  const board = observationRetrievalFixture(0);
  for (let i = 0; i < size; i++) board.facts.push({ id: `F-${i}`, stepId: null, description: `Historical observation ${i}: alice/v1; NOT verified for bob/v2.`, evidenceIds: [] });
  return board;
}
function request(snapshot: ReturnType<typeof fixture>): RunRequest {
  return { id: "fixture", mode: "decide", snapshot, workspace: process.cwd(), runDir: "fixture/runs/current", signal: new AbortController().signal, onEvent() {} };
}
describe("bounded historical context", () => {
  it("keeps large historical indexes out of the pinned prompt without hiding original constraints or active branches", () => {
    const small = projectContext(request(fixture(100))), board = fixture(3000);
    board.hints = [{ id: "H-1", content: "只能修改 auth.py；不能重复已完成的写操作", createdAt: "fixture" }];
    board.goals.push({ id: "G-open", parentId: "G0", description: "Unresolved earlier branch", status: "active", factIds: ["F-0"] });
    const before = structuredClone(board), context = projectContext(request(board));
    expect(JSON.stringify(context.factIndex).length).toBeLessThanOrEqual(16000);
    expect(context.projection.omittedFactIndex + context.factIndex.length).toBe(3000);
    expect(JSON.stringify(context).length).toBeLessThan(JSON.stringify(small).length + 5000);
    expect(context.goals).toContainEqual(board.goals[1]);
    expect(context.facts.some(fact => fact.id === "F-0")).toBe(true);
    expect(context.hints).toEqual(board.hints); expect(board).toEqual(before);
  });
  it("allows every older fact to be discovered through bounded pages without duplicate or missing entries", () => {
    const board = fixture(311), before = structuredClone(board), read = createTaskReader(process.cwd(), { dataDir: "unused", snapshot: () => board });
    const ids: string[] = []; let path: string | undefined = "xloom://history?kind=fact&limit=25&budgetChars=2048";
    for (let page = 0; path && page < 100; page++) {
      const result = read(path) as any;
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2048);
      expect(result).not.toHaveProperty("reading");
      expect(result.items.every((entry: any) => entry.readPath.startsWith("xloom://record?kind=fact"))).toBe(true);
      ids.push(...result.items.map((entry: any) => entry.id)); path = result.nextReadPath;
    }
    expect(path).toBeUndefined(); expect(ids).toEqual(board.facts.map(fact => fact.id)); expect(board).toEqual(before);
  });
  it("rejects a cursor after same-revision source changes and validates its query parameters", () => {
    const board = fixture(10), read = createTaskReader(process.cwd(), { dataDir: "unused", snapshot: () => board });
    const first = read("xloom://history?limit=2") as any;
    board.facts[0]!.description = "Changed under the same revision";
    expect(read(first.nextReadPath)).toMatchObject({ status: "history_changed", complete: false, items: [] });
    expect(read("xloom://history?offset=2")).toMatchObject({ status: "history_changed" });
    for (const query of ["kind=chat", "offset=-1", "limit=0", "budgetChars=999", "limit=2&limit=3", "foreign=true"])
      expect(() => read(`xloom://history?${query}`)).toThrow();
  });
  it("bounds unrelated attempts while retaining attempts for current hypotheses and their exact conditions", () => {
    const board = fixture(0);
    board.attempts = Array.from({ length: 200 }, (_, i) => ({ id: `A-${i}`, stepId: `S-${i}`, hypothesis: `hypothesis-${i}`, scope: "tenant-a", identity: "alice",
      stateVersion: "v1", baseline: "before", changedVariable: "identity", outcome: "refutes", observation: "403 under this identity only", evidenceIds: [], runId: "private", conditionKey: "private", outcomeKey: "private" }));
    board.findings.push({ id: "V-0", key: "hypothesis-0", title: "Open hypothesis", target: "fixture", status: "lead", rating: "unrated", next: "Inspect changed identity", factIds: [], evidenceIds: [] });
    const context = projectContext(request(board));
    expect(context.attempts).toHaveLength(13); expect(context.attempts[0]!.id).toBe("A-0");
    expect(context.projection.omittedAttempts).toBe(187);
    const read = createTaskReader(process.cwd(), { dataDir: "unused", snapshot: () => board });
    const history = read("xloom://history?kind=attempt&limit=1") as any;
    expect(history.items[0]).toMatchObject({ id: "A-0", identity: "alice", stateVersion: "v1", outcome: "refutes" });
    expect(JSON.stringify(history)).not.toContain("private");
  });
});
