import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixtures/native-retrieval.js";
import { createTaskReader } from "../src/wiki/read.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";
import { refKey } from "../src/wiki/catalog.js";
import { retrievalFeedback } from "../src/wiki/feedback.js";

const opened: { root: string; fixture: ReturnType<typeof nativeFixture> }[] = [];
afterEach(() => { for (const { root, fixture } of opened.splice(0)) {
  fixture.store.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-source-pages-")) throw new Error("Unsafe fixture cleanup");
  rmSync(root, { recursive: true, force: true });
} });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "xloom-source-pages-")), fixture = nativeFixture(root);
  opened.push({ root, fixture });
  const board = fixture.store.snapshot();
  // Explicit causal dependencies require a large source package even though
  // shared Goal membership alone no longer expands into unrelated facts.
  board.capabilities = []; board.wikiPages = [];
  board.evidence = Array.from({ length: 14 }, (_, i) => ({ ...board.evidence[0]!, id: `E-page-${i}`,
    description: `Synthetic evidence ${i}: ${"Retain identity/version and observed counterexamples. ".repeat(18)}` }));
  board.facts = Array.from({ length: 12 }, (_, i) => ({ id: `F-page-${i}`, stepId: board.steps[0]!.id,
    description: `Observation ${i}; identity alice; v1 only; other identities UNVERIFIED. ${"Full synthetic qualification. ".repeat(35)}`,
    evidenceIds: [board.evidence[i]!.id, board.evidence[i + 1]!.id, board.evidence[13]!.id] }));
  board.goals[0]!.factIds = board.facts.map(f => f.id);
  board.steps[0]!.from = board.facts.map(f => f.id);
  board.attempts = board.facts.map((f, i) => ({ id: `A-page-${i}`, stepId: board.steps[0]!.id, runId: "seed",
    hypothesis: `H-${i}`, scope: "local fixture", identity: "alice", stateVersion: "v1", baseline: "owned object", changedVariable: "object owner",
    outcome: "refutes" as const, observation: `DENIED; do not infer endpoint absence. ${"Recorded test conditions. ".repeat(40)}`,
    evidenceIds: f.evidenceIds, conditionKey: `condition-${i}`, outcomeKey: `outcome-${i}` }));
  const context = { dataDir: fixture.store.dataDir, snapshot: () => board };
  const read = createTaskReader(root, context);
  const path = `xloom://record?kind=evidence&id=${board.evidence[0]!.id}`;
  return { root, fixture, board, context, read, path };
}
type Page = { type: string; complete: boolean; records: ({ ref: { kind: string; id: string; pageId?: string }; text?: string; originalReadPath?: string })[];
  nextReadPath?: string; packageSignature: string; sourceDelivery: { totalRecords: number; deliveredRecords: number; remainingRecords: number }; status: string };

describe("source package pagination", () => {
  it("escapes the logged empty-package loop, retaining every condition and source exactly once across pages", () => {
    const f = setup(), before = JSON.stringify(f.board);
    // The Fact owns the causal package; an Evidence archive's Step is navigation.
    const anchors = [{ kind: "fact" as const, id: f.board.facts[0]!.id }];
    const full = retrieveWiki(f.board, f.context.dataDir, f.root, "", { anchors, limit: anchors.length });
    expect(JSON.stringify(full).length).toBeGreaterThan(64000);
    const first = f.read(`xloom://record?kind=fact&id=${anchors[0]!.id}`) as unknown as { complete: boolean; nextReadPath: string; records: object[] };
    expect(first).toMatchObject({ complete: false, records: [] });
    let path: string | undefined = first.nextReadPath;
    const records = new Map<string, object>(); let count = 0; let last: Page | undefined;
    while (path) {
      const page = f.read(path) as unknown as Page;
      expect(page.type).toBe("source_page"); expect(page.records.length).toBeGreaterThan(0);
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(64000);
      expect(retrievalFeedback(page)).toContain("来源分批交付");
      for (const record of page.records) { const key = JSON.stringify(record.ref); expect(records.has(key)).toBe(false); records.set(key, record); }
      last = page; path = page.nextReadPath; expect(++count).toBeLessThan(10);
    }
    expect(count).toBeGreaterThan(1); expect(last).toMatchObject({ complete: true, sourceDelivery: { remainingRecords: 0 } });
    expect(new Map([...records.values()].map(record => [refKey((record as { ref: Parameters<typeof refKey>[0] }).ref), record])))
      .toEqual(new Map(full.records.map(record => [refKey((record as { ref: Parameters<typeof refKey>[0] }).ref), record])));
    const original = [...records.values()].find(record => (record as { originalReadPath?: string }).originalReadPath) as { originalReadPath: string };
    expect(f.read(original.originalReadPath)).toMatchObject({ integrity: "verified" });
    expect(JSON.stringify(f.board)).toBe(before);
  });
  it("does not declare skipped pages complete and rejects stale cursors after a source correction", () => {
    const f = setup();
    const first = f.read(`${f.path}&sourceOffset=0&budgetChars=16000`) as unknown as Page;
    expect(first.complete).toBe(false); expect(first.nextReadPath).toBeDefined();
    const fresh = createTaskReader(f.root, f.context);
    const skipped = fresh(first.nextReadPath!) as unknown as Page;
    expect(skipped.complete).toBe(false);
    expect(new URL(skipped.nextReadPath!).searchParams.get("sourceOffset")).toBe("0");
    f.board.facts[0]!.description += " Correction: identity changed to bob / v2.";
    expect(() => f.read(first.nextReadPath!)).toThrow("Source package changed");
    const corrected = f.read(`${f.path}&sourceOffset=0&budgetChars=16000`) as unknown as Page;
    expect(corrected.packageSignature).not.toBe(first.packageSignature);
    expect(() => fresh(`${f.path}&sourceOffset=3`)).toThrow("packageSignature");
  });
  it("keeps missing dependencies unverified and gives a finite fallback for an oversized individual record", () => {
    const f = setup(); f.board.facts[0]!.evidenceIds.push("E-absent");
    let path: string | undefined = `${f.path}&sourceOffset=0&budgetChars=64000`;
    let last: Page | undefined; let pages = 0;
    while (path) { last = f.read(path) as unknown as Page; path = last.nextReadPath; expect(++pages).toBeLessThan(10); }
    expect(last).toMatchObject({ complete: false, status: "source_missing" });
    f.board.evidence[0]!.description = "Whole record remains unverified. ".repeat(4000);
    let huge = f.read(`${f.path}&sourceOffset=0&budgetChars=64000`) as unknown as Page & { fileReadPath: string };
    while (huge.nextReadPath) { huge = f.read(huge.nextReadPath) as unknown as typeof huge; expect(++pages).toBeLessThan(15); }
    expect(huge).toMatchObject({ complete: false, status: "record_exceeds_budget", records: [] });
    expect(huge.nextReadPath).toBeUndefined(); expect(huge.fileReadPath).toBeTruthy();
    expect(JSON.stringify(huge)).not.toContain("Whole record remains");
  });
});
