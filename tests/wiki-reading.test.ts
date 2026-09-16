import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskReader } from "../src/wiki/read.js";
import { originalReadPath, readOriginal } from "../src/wiki/originals.js";
import { recordReadPath } from "../src/wiki/materials.js";
import { runLocal } from "../src/wiki/local.js";
import { retrieveQuestion } from "../src/wiki/questions.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";

const opened: { root: string; fixture: ReturnType<typeof wikiStructureFixture> }[] = [];
afterEach(() => { for (const { root, fixture } of opened.splice(0)) {
  fixture.store.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-reading-")) throw new Error("Invalid fixture cleanup path");
  rmSync(root, { recursive: true, force: true });
} });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "xloom-reading-")), fixture = wikiStructureFixture(root);
  opened.push({ root, fixture });
  let board = fixture.store.snapshot();
  const read = createTaskReader(root, { dataDir: fixture.store.dataDir, snapshot: () => board }) as (path: string) => any;
  return { ...fixture, root, read, get board() { return board; }, setBoard(value: typeof board) { board = value; } };
}
const search = "xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000";
const flow = recordReadPath({ kind: "block", pageId: "WK-flow", id: "B-judgment" }) + "&budgetChars=64000";

describe("verified original reading and same-role overlap", () => {
  it("resets delivery hints after compaction while continuing to deliver full source bodies", () => {
    const f = setup(), context = { epoch: 0, dataDir: f.store.dataDir, snapshot: () => f.board };
    const read = createTaskReader(f.root, context) as (path: string) => any;
    const first = read(search), path = first.wiki.records.find((record: any) => record.ref.kind === "evidence").originalReadPath;
    read(path); expect(read(search).reading.repeatedRecords).toBeGreaterThan(0);
    expect(read(path).reading.repeatedOriginalRange).toBe(true);
    context.epoch++;
    const fresh = read(search);
    expect(fresh.reading.repeatedRecords).toBe(0); expect(fresh.reading.fullyDeliveredOriginals).toBe(0);
    expect(fresh.retrievalProgress).toBe("inspect_material"); expect(fresh.wiki.records).toEqual(first.wiki.records);
    expect(read(path).reading.repeatedOriginalRange).toBeUndefined();
  });
  it("diagnoses unsupported page records and directs callers to a valid block's page metadata", () => {
    const f = setup();
    expect(() => f.read("xloom://record?kind=page&id=WK-flow")).toThrow("kind=block&page=<page ID>&id=<block ID>");
    expect(() => f.read("xloom://record?kind=block&id=B-judgment")).toThrow("requires page=");
    expect(f.read(flow).records.find((record: any) => record.ref.kind === "block" && record.ref.id === "B-judgment").retrievalMetadata.page.aliases).toContain("BridgeAlias");
  });

  it("reports valid paging recovery and does not count a last window as full delivery", () => {
    const f = setup(), original = f.board.evidence[0]!;
    const body = "a".repeat(10000);
    writeFileSync(join(f.store.dataDir, original.path), body);
    original.bytes = body.length; original.sha256 = createHash("sha256").update(body).digest("hex");
    const path = originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 0 });
    expect(() => f.read(path + "&byteLength=40960")).toThrow("File has 10000 bytes");
    expect(() => f.read(path + "&byteLength=40960")).toThrow("Omit byteLength");
    const tail = f.read(originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 9000 }));
    expect(tail.nextReadPath).toBeUndefined();
    expect(tail.notice).toContain("Reaching the last window alone leaves earlier gaps unread");
    expect(tail.reading).toMatchObject({ fullyDeliveredOriginals: 0, originalsWithUnreadBytes: 1, nextOriginalReadPath: path });
  });
  it("links Wiki source metadata directly to complete short originals without guessed lengths", () => {
    const f = setup(), result = f.read(search), before = structuredClone(f.board);
    const evidence = result.wiki.records.filter((doc: any) => doc.ref.kind === "evidence");
    expect(evidence).toHaveLength(2);
    expect(result.reading).toMatchObject({ repeatedRecords: 0, originalsWithUnreadBytes: 2, fullyDeliveredOriginals: 0 });
    for (const doc of evidence) {
      expect(doc.bodyIncluded).toBe(false); expect(doc.integrity).toBe("not_checked");
      const original = f.read(doc.originalReadPath);
      expect(original.integrity).toBe("verified"); expect(original.text).toContain("SYNTHETIC LOCAL ONLY");
      expect(original.locator.byteLength).toBe(f.board.evidence.find(item => item.id === doc.ref.id)!.bytes);
      expect(original.omittedAfter).toBe(0); expect(original.nextReadPath).toBeUndefined();
      expect(original.sourceContextReadPath).toBe(recordReadPath(doc.ref));
    }
    expect(f.read(search).reading).toMatchObject({ newRecords: 0, originalsWithUnreadBytes: 0, fullyDeliveredOriginals: 2 });
    expect(f.board).toEqual(before);
  });

  it("pages mixed UTF-8 originals without omitted or duplicated bytes and rejects explicit cuts", () => {
    const f = setup(), original = f.board.evidence[0]!;
    const body = "x".repeat(4095) + "中🙂文".repeat(1200) + "TAIL: DENIED; not successful.";
    writeFileSync(join(f.store.dataDir, original.path), body);
    original.bytes = Buffer.byteLength(body); original.sha256 = createHash("sha256").update(body).digest("hex");
    let path: string | undefined = originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 0 });
    const parts: string[] = []; let offset = 0, last: any;
    while (path) {
      const result = f.read(path); parts.push(result.text);
      expect(result.locator.byteOffset).toBe(offset); expect(result.locator.byteLength).toBeGreaterThan(0);
      expect(result.locator.byteLength).toBeLessThanOrEqual(4096);
      offset += result.locator.byteLength; path = result.nextReadPath; last = result;
      expect(parts.length).toBeLessThan(20);
    }
    expect(parts.join("")).toBe(body); expect(offset).toBe(original.bytes);
    expect(last.reading).toMatchObject({ originalsWithUnreadBytes: 0, fullyDeliveredOriginals: 1 });
    expect(last.startReadPath).toBe(originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 0 }));
    expect(() => readOriginal(f.board, f.store.dataDir, f.root, { evidenceId: original.id, sha256: original.sha256, byteOffset: 4095, byteLength: 1 })).toThrow("UTF-8");
    expect(() => f.read(originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 4096 }))).toThrow("UTF-8");
  });

  it("tracks cross-entry source overlap independently of query spelling and unrelated revisions", () => {
    const f = setup(); f.read(search);
    const second = f.read(flow);
    expect(second.reading.newRecords).toBe(0); expect(second.reading.repeatedRecords).toBe(second.records.length);
    f.board.revision++;
    expect(f.read(search).reading.newRecords).toBe(0);
    f.board.wikiPages![0]!.blocks[0]!.text += " New qualification.";
    expect(f.read(search).reading.newRecords).toBe(1);
    expect(f.read(search).wiki.records[0].text).toContain("New qualification");
    const fresh = createTaskReader(f.root, { dataDir: f.store.dataDir, snapshot: () => f.board }) as (path: string) => any;
    expect(fresh(search).reading.repeatedRecords).toBe(0);
  });

  it("does not confuse search snippets, metadata or incomplete packages with original reading", () => {
    const f = setup();
    expect(f.read("xloom://search?mode=combined&query=SYNTHETIC&budgetChars=1024").complete).toBe(false);
    const delivered = f.read(search); expect(delivered.reading.repeatedRecords).toBe(0);
    expect(f.read("xloom://search?query=SYNTHETIC").reading.fullyDeliveredOriginals).toBe(0);
    const original = f.board.evidence[0]!;
    const partial = f.read(originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 10, byteLength: 5 }));
    expect(partial.reading.fullyDeliveredOriginals).toBe(0);
    expect(new URL(partial.reading.nextOriginalReadPath).searchParams.get("byteOffset")).toBe("0");
    expect(f.read(originalReadPath(partial.locator)).reading.repeatedOriginalRange).toBe(true);
  });

  it("rechecks the entire original even on repeated range reads and resets coverage for a changed hash", () => {
    const f = setup(), original = f.board.evidence[0]!, path = originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 0 });
    f.read(path); expect(f.read(path).reading.repeatedOriginalRange).toBe(true);
    writeFileSync(join(f.store.dataDir, original.path), "TAMPERED");
    expect(() => f.read(path)).toThrow("mismatch");
    original.sha256 = createHash("sha256").update("TAMPERED").digest("hex"); original.bytes = 8;
    expect(() => f.read(path)).toThrow("Stale evidence locator");
    expect(f.read(search).reading.fullyDeliveredOriginals).toBe(0);
    expect(f.read(originalReadPath({ evidenceId: original.id, sha256: original.sha256, byteOffset: 0 })).reading.repeatedOriginalRange).toBeUndefined();
  });

  it("keeps native output budgets and exposes reading feedback through the actual read tool", async () => {
    const f = setup();
    for (const budget of [1024, 4000, 16000, 64000]) for (let repeat = 0; repeat < 2; repeat++) {
      const result = f.read(`xloom://search?mode=wiki&query=BridgeAlias&budgetChars=${budget}`);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
    }
    const tool = createWorkspaceReadTool(f.root, undefined, { dataDir: f.store.dataDir, snapshot: () => f.board });
    await tool.execute("first", { path: search });
    const result = await tool.execute("second", { path: flow });
    expect(result.details).toMatchObject({ nativeRetrieval: true, retrievalFeedback: expect.stringContaining("避免换入口重复读取") });
    await expect(createWorkspaceReadTool(f.root).execute("chat", { path: search })).rejects.toThrow("outside a research task");
  });

  it("uses safe default short-file reading through the local CLI too", () => {
    const f = setup(), evidence = f.board.evidence[0]!;
    expect(runLocal(["read-original", "--task", f.store.dataDir, "--workspace", f.root, "--evidence", evidence.id, "--sha256", evidence.sha256]).output)
      .toMatchObject({ integrity: "verified", omittedAfter: 0 });
  });

  it("does not report a question complete when its original exists but a source dependency is missing", () => {
    const f = setup(), step = f.board.steps[0]!;
    step.gaps = [{ id: "gap-scope", missing: "submission", why: "Check scope", reopenWhen: "New observation", needs: [],
      conditions: { scope: "local", identity: "alice", environment: "fixture", stateVersion: "v1" }, sources: [] }];
    f.board.facts[0]!.evidenceIds.push("E-missing");
    const result = retrieveQuestion(f.board, f.store.dataDir, f.root, { stepId: step.id, gapId: "gap-scope" }, { budgetChars: 64000 });
    expect(result).toMatchObject({ originals: { complete: true }, complete: false });
    expect(JSON.stringify(result)).toContain("source_missing");
  });

  it("keeps question overflow diagnostics inside even the minimum native budget", () => {
    const f = setup(), step = f.board.steps[0]!;
    step.gaps = [{ id: "gap-scope", missing: "submission", why: "Check scope", reopenWhen: "New observation", needs: [],
      conditions: { scope: "local", identity: "alice", environment: "fixture", stateVersion: "v1" }, sources: [] }];
    for (const budget of [128, 256, 1024, 16000]) {
      const result = f.read(`xloom://question?stepId=${step.id}&gapId=gap-scope&budgetChars=${budget}`);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      if (budget < 1024) expect(result).toMatchObject({ complete: false, status: "budget_exhausted" });
    }
  });
});
