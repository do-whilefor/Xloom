import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { BoardSnapshot } from "../src/types.js";
import { gapReadPath } from "../src/knowledge/gaps.js";
import { searchOriginals, readOriginal, originalReadPath } from "../src/wiki/originals.js";
import { retrieveQuestion } from "../src/wiki/questions.js";
import { retrievalContext } from "../src/wiki/retrieval.js";
import { runLocal } from "../src/wiki/local.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-originals-")) throw new Error("Invalid fixture cleanup path");
  rmSync(root, { recursive: true, force: true });
} });
function fixture(body = "unrelated prefix\n".repeat(5000) + "downloadGrant=LOCAL_FIXTURE; 下载授权仅供本地测试。 Actual download remains unverified.\n") {
  const root = mkdtempSync(join(tmpdir(), "xloom-originals-")); roots.push(root); mkdirSync(join(root, "evidence"));
  const file = join(root, "evidence", "original.txt"); writeFileSync(file, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const board: BoardSnapshot = { revision: 4, config: defaultConfig("WHOLE_GOAL_SHOULD_NOT_OVERRIDE_GAP"), status: "paused", outcome: null, reason: "Fixture",
    goals: [{ id: "G0", parentId: null, description: "Fixture", status: "active", factIds: [] }],
    steps: [{ id: "S-old", goalId: "G0", from: [], description: "Old download attempt", successSignal: "Recorded local result", evidencePlan: "Fixture", status: "blocked", priority: 1, attempts: 1, runId: null, leaseUntil: null,
      gaps: [{ id: "gap-download", missing: "downloadGrant 下载授权", why: "Need download permission", reopenWhen: "A grant is observed", needs: [],
        conditions: { scope: "local report", identity: "alice", environment: "fixture", stateVersion: "v1" }, sources: [] }] }],
    evidence: [{ id: "E-one", path: "evidence/original.txt", pathBase: "task", sha256, bytes: Buffer.byteLength(body), description: "Generic metadata without the query", stepId: "S-old", runId: "R" }],
    facts: [{ id: "F-one", description: "Generic observation", stepId: "S-old", evidenceIds: ["E-one"] }], findings: [], hints: [],
    usage: { input: 0, output: 0, cost: 0 }, completedSteps: 1, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
  return { board, root, file, body };
}
const ref = { stepId: "S-old", gapId: "gap-download" };

describe("gap-driven original search and located reading", () => {
  it.each([undefined, 0])("reads and verifies empty originals with byteLength=%s without inventing content or pages", async byteLength => {
    const { board, root, file } = fixture("");
    const evidence = board.evidence[0]!;
    const locator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: 0, byteLength };
    const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const read = JSON.parse((await tool.execute("empty-original", { path: originalReadPath(locator) })).content[0]!.text as string);
    expect(read).toMatchObject({ type: "original_read", integrity: "verified", text: "", rangeSha256: evidence.sha256,
      locator: { evidenceId: evidence.id, byteOffset: 0, byteLength: 0 }, omittedBefore: 0, omittedAfter: 0,
      reading: { originalsWithUnreadBytes: 0, fullyDeliveredOriginals: 1 } });
    expect(read.nextReadPath).toBeUndefined();
    expect(read.startReadPath).toBeUndefined();
    expect(readOriginal(board, root, root, { ...locator, contextBytes: 1024 })).toMatchObject({ text: "", integrity: "verified" });
    expect(searchOriginals(board, root, root, "anything")).toMatchObject({ complete: true, hits: [], issues: [] });
    for (const extra of [{ byteOffset: 1 }, { byteLength: 1 }, { byteLength: -1 }, { sha256: "stale" }])
      expect(() => readOriginal(board, root, root, { ...locator, ...extra })).toThrow();
    writeFileSync(file, "tampered");
    expect(() => readOriginal(board, root, root, locator)).toThrow("SHA-256/size mismatch");
  });

  it("finds content beyond metadata/excerpts and reads exactly the hashed source range", () => {
    const { board, root, body } = fixture(), before = structuredClone(board);
    const result = searchOriginals(board, root, root, "downloadGrant 下载授权");
    expect(result).toMatchObject({ complete: true, inspectedCount: 1 }); expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!; expect(hit.locator.byteOffset).toBeGreaterThan(64 * 1024);
    const read = readOriginal(board, root, root, hit.locator);
    expect(read.text).toBe(Buffer.from(body).subarray(hit.locator.byteOffset, hit.locator.byteOffset + hit.locator.byteLength).toString("utf8"));
    expect(read.text).toContain("Actual download remains unverified"); expect(read.integrity).toBe("verified"); expect(board).toEqual(before);
  });
  it("preserves UTF-8 matches across stream boundaries and minified single-line originals", () => {
    for (const body of ["x ".repeat(32762) + "边界下载授权下载授权 ends", "x ".repeat(90000) + "downloadGrant LOCAL_ONLY"]) {
      const { board, root } = fixture(body);
      const result = searchOriginals(board, root, root, body.includes("LOCAL_ONLY") ? "downloadGrant" : "下载授权");
      expect(result.complete).toBe(true); expect(result.hits.length).toBeGreaterThan(0);
      expect(readOriginal(board, root, root, result.hits[0]!.locator).text).toContain(body.includes("LOCAL_ONLY") ? "downloadGrant" : "下载授权");
      for (const hit of result.hits) expect(readOriginal(board, root, root, hit.locator).text).toBe(hit.snippet);
    }
  });
  it("expands a search hit to nearby prerequisites and counterconditions without changing the exact hit", () => {
    const { board, root, body } = fixture("unrelated prefix\n".repeat(5000)
      + "PRECONDITION: identity alice, version v1 only.\n" + ".".repeat(300)
      + " downloadGrant=OBSERVED " + ".".repeat(1300) + "\nCOUNTERCONDITION: actual download was DENIED.\n"
      + ".".repeat(3000) + "DISTANT: still requires a separate review.");
    const before = structuredClone(board), hit = searchOriginals(board, root, root, "downloadGrant").hits[0]!;
    expect(hit.snippet).not.toContain("PRECONDITION"); expect(hit.snippet).not.toContain("COUNTERCONDITION");
    const url = new URL(hit.contextReadPath);
    expect(url.searchParams.get("contextBytes")).toBe("1024");
    const read = readOriginal(board, root, root, { ...hit.locator, contextBytes: 1024 });
    expect(read.focusLocator).toEqual(hit.locator);
    expect(read.text).toContain("PRECONDITION: identity alice, version v1 only.");
    expect(read.text).toContain("COUNTERCONDITION: actual download was DENIED.");
    expect(read.text).not.toContain("DISTANT");
    const bytes = Buffer.from(body).subarray(read.locator.byteOffset, read.locator.byteOffset + read.locator.byteLength);
    expect(read.text).toBe(bytes.toString("utf8"));
    expect(read.rangeSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(read.locator.byteLength).toBeLessThanOrEqual(8192);
    expect(readOriginal(board, root, root, hit.locator).text).toBe(hit.snippet);
    expect(board).toEqual(before);
  });
  it("aligns only expanded edges across Chinese/emoji and stream boundaries, preserving the focus", () => {
    const prefix = "中🙂".repeat(9361), focus = "下载授权", suffix = "🙂边".repeat(1000);
    const { board, root, body } = fixture(prefix + focus + suffix);
    const locator = { evidenceId: "E-one", sha256: board.evidence[0]!.sha256, byteOffset: Buffer.byteLength(prefix), byteLength: Buffer.byteLength(focus) };
    for (const contextBytes of [0, 1, 2, 3, 4, 7, 1024, 2048]) {
      const read = readOriginal(board, root, root, { ...locator, contextBytes });
      const start = read.locator.byteOffset, end = start + read.locator.byteLength;
      expect(read.text).toContain(focus); expect(read.text).not.toContain("�");
      expect(start).toBeLessThanOrEqual(locator.byteOffset); expect(start).toBeGreaterThanOrEqual(locator.byteOffset - contextBytes);
      expect(end).toBeGreaterThanOrEqual(locator.byteOffset + locator.byteLength);
      expect(end).toBeLessThanOrEqual(locator.byteOffset + locator.byteLength + contextBytes);
      expect(Buffer.from(read.text)).toEqual(Buffer.from(body).subarray(start, end));
      expect(read.omittedBefore).toBe(start); expect(read.omittedAfter).toBe(Buffer.byteLength(body) - end);
      expect(new URL(read.nextReadPath!).searchParams.get("byteOffset")).toBe(String(end));
    }
    // Even with valid surrounding characters, a split explicit focus is rejected.
    expect(() => readOriginal(board, root, root, { ...locator, byteOffset: locator.byteOffset + 1, contextBytes: 1024 })).toThrow("splits UTF-8");
    expect(() => readOriginal(board, root, root, { ...locator, byteLength: 1, contextBytes: 1024 })).toThrow("splits UTF-8");
    const defaultPage = readOriginal(board, root, root, { evidenceId: "E-one", sha256: locator.sha256, byteOffset: 0, contextBytes: 1024 });
    expect(defaultPage.focusLocator!.byteLength).toBeLessThanOrEqual(4096);
    expect(Buffer.from(defaultPage.text)).toEqual(Buffer.from(body).subarray(0, defaultPage.locator.byteLength));
  });
  it("bounds context at file edges and rejects invalid budgets, stale or foreign locators and tampering outside the range", () => {
    const f = fixture("前🙂 downloadGrant 后🙂"), locator = searchOriginals(f.board, f.root, f.root, "downloadGrant").hits[0]!.locator;
    const read = readOriginal(f.board, f.root, f.root, { ...locator, contextBytes: 2048 });
    expect(read).toMatchObject({ text: f.body, omittedBefore: 0, omittedAfter: 0 });
    expect(read.nextReadPath).toBeUndefined(); expect(read.startReadPath).toBeUndefined();
    for (const extra of [{ contextBytes: -1 }, { contextBytes: 2049 }, { contextBytes: 1.5 }, { contextBytes: NaN },
      { contextBytes: 1024, sha256: "stale" }, { contextBytes: 1024, evidenceId: "E-other-task" }])
      expect(() => readOriginal(f.board, f.root, f.root, { ...locator, ...extra })).toThrow();
    const long = fixture("x ".repeat(10000)), anchor = { evidenceId: "E-one", sha256: long.board.evidence[0]!.sha256, byteOffset: 100, byteLength: 8192, contextBytes: 1 };
    expect(() => readOriginal(long.board, long.root, long.root, anchor)).toThrow("exceeds 8192");
    writeFileSync(long.file, long.body.slice(0, -1) + "!");
    expect(() => readOriginal(long.board, long.root, long.root, { ...anchor, byteLength: 100 })).toThrow("SHA-256/size mismatch");
    const outside = join(long.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "other.txt"), long.body);
    symlinkSync(outside, join(long.root, "evidence", "linked"), "junction"); long.board.evidence[0]!.path = "evidence/linked/other.txt";
    expect(() => readOriginal(long.board, long.root, long.root, { ...anchor, byteLength: 100 })).toThrow("escaped its task archive");
  });
  it("tracks the bytes actually delivered by native context reads and leaves fresh readers independent", async () => {
    const { board, root } = fixture("prefix ".repeat(50) + "downloadGrant" + " suffix".repeat(50));
    const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const read = async (path: string) => JSON.parse((await tool.execute("read", { path })).content[0]!.text as string);
    const hit = searchOriginals(board, root, root, "downloadGrant").hits[0]!;
    const expanded = await read(hit.contextReadPath);
    expect(expanded.reading).toMatchObject({ fullyDeliveredOriginals: 1, originalsWithUnreadBytes: 0 });
    // Prefix is outside the search focus and must still count as delivered.
    expect(hit.locator.byteOffset).toBeGreaterThan(0);
    const prefix = originalReadPath({ ...hit.locator, byteOffset: 0, byteLength: 6 });
    expect((await read(prefix)).reading.repeatedOriginalRange).toBe(true);
    const fresh = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const freshRead = JSON.parse((await fresh.execute("read", { path: prefix })).content[0]!.text as string);
    expect(freshRead.reading).toMatchObject({ fullyDeliveredOriginals: 0, originalsWithUnreadBytes: 1 });
    expect(freshRead.reading.repeatedOriginalRange).toBeUndefined();
    await expect(tool.execute("read", { path: hit.contextReadPath + "&contextBytes=1" })).rejects.toThrow("duplicate");
    await expect(tool.execute("read", { path: hit.readPath + "&contextBytes=2049" })).rejects.toThrow("contextBytes");
  });
  it.each(["tampered", "missing", "binary"])("reports %s originals as incomplete and withholds hits", kind => {
    const { board, root, file } = fixture();
    if (kind === "missing") unlinkSync(file);
    else if (kind === "tampered") { const b = readFileSync(file); b[b.length - 2]! ^= 1; writeFileSync(file, b); }
    else { writeFileSync(file, Buffer.from([0, 255])); board.evidence[0]!.sha256 = createHash("sha256").update(readFileSync(file)).digest("hex"); board.evidence[0]!.bytes = 2; }
    expect(searchOriginals(board, root, root, "downloadGrant")).toMatchObject({ complete: false, hits: [], issues: [expect.objectContaining({ evidenceId: "E-one" })] });
  });
  it("rejects stale locators, unknown IDs, invalid ranges and UTF-8 cuts", () => {
    const { board, root } = fixture("下载授权 downloadGrant"); const locator = searchOriginals(board, root, root, "downloadGrant").hits[0]!.locator;
    for (const extra of [{ evidenceId: "E-other-task" }, { sha256: "stale" }, { byteOffset: -1 }, { byteLength: 0 }, { byteLength: 9000 }, { byteOffset: 1, byteLength: 1 }])
      expect(() => readOriginal(board, root, root, { ...locator, ...extra })).toThrow();
  });
  it("does not search unregistered/private files or follow archive directory links", () => {
    const { board, root } = fixture(); mkdirSync(join(root, "runs")); writeFileSync(join(root, "runs", "private.txt"), "privateNeedle");
    expect(searchOriginals(board, root, root, "privateNeedle").hits).toEqual([]);
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "other.txt"), "privateNeedle");
    symlinkSync(outside, join(root, "evidence", "linked"), "junction"); board.evidence[0]!.path = "evidence/linked/other.txt";
    expect(searchOriginals(board, root, root, "privateNeedle")).toMatchObject({ complete: false, hits: [] });
  });
  it("binds search to the gap and carries source corrections into the question package", () => {
    const { board, root } = fixture(); board.facts.push({ id: "F-correction", description: "Countercondition requires a new local check", stepId: "S-old", evidenceIds: ["E-one"], supersedes: "F-one" });
    const result = retrieveQuestion(board, root, root, ref);
    expect(result).toMatchObject({ queryOrigin: "step_gap", answerSupport: "not_assessed", question: { conditions: { identity: "alice" }, state: "review_required" } });
    expect(JSON.stringify(result)).toContain("F-correction"); expect(JSON.stringify(result)).toContain("downloadGrant");
    expect(retrieveQuestion(board, root, root, ref, { budgetChars: 128 })).toMatchObject({ status: "budget_exhausted", complete: false });
    expect(() => retrieveQuestion(board, root, root, { ...ref, gapId: "gap-unknown" })).toThrow("Unknown");
    const context = retrievalContext({ id: "R", mode: "decide", snapshot: board, workspace: root, runDir: join(root, "runs", "R"), blackboardPath: join(root, "blackboard.md"), signal: new AbortController().signal, onEvent() {} });
    expect(context).toMatchObject({ queryOrigin: "step_gap", query: "downloadGrant 下载授权", questions: [expect.objectContaining({ readPath: gapReadPath(ref) })] });
  });
  it("uses native read for gap search and original reading, detects unchanged repeated queries, and isolates readers", async () => {
    const { board, root } = fixture(); const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const read = async (path: string) => JSON.parse((await tool.execute("read", { path })).content[0]!.text as string);
    const first = await read(gapReadPath(ref)); expect(first.retrievalProgress).toBe("inspect_material");
    expect((await read(first.originals.hits[0].readPath)).text).toContain("downloadGrant");
    expect((await read(gapReadPath(ref))).retrievalProgress).toBe("stop_repeating_query");
    board.revision++;
    expect((await read(gapReadPath(ref))).retrievalProgress).toBe("inspect_material");
    const isolated = createWorkspaceReadTool(root);
    await expect(isolated.execute("read", { path: first.originals.hits[0].readPath })).rejects.toThrow("outside a research task");
    await expect(tool.execute("read", { path: gapReadPath(ref) + "&stepId=other" })).rejects.toThrow("duplicate");
    await expect(tool.execute("read", { path: gapReadPath(ref), offset: 2 })).rejects.toThrow("URI parameters");
  });
  it("exposes the same read-only workflow through the installed local command", () => {
    const { board, root } = fixture(); const db = new DatabaseSync(join(root, "blackboard.sqlite"));
    db.exec("CREATE TABLE board(id INTEGER PRIMARY KEY,value TEXT)"); const saved = JSON.stringify(board); db.prepare("INSERT INTO board VALUES(1,?)").run(saved);
    try {
      const common = ["--task", root, "--workspace", root];
      const result = runLocal(["question", ...common, "--step", ref.stepId, "--gap", ref.gapId]).output as any;
      expect(result.originals.hits).toHaveLength(1);
      const locator = result.originals.hits[0].locator;
      expect(runLocal(["read-original", ...common, "--evidence", locator.evidenceId, "--sha256", locator.sha256, "--byte-offset", String(locator.byteOffset), "--byte-length", String(locator.byteLength)]).output).toMatchObject({ integrity: "verified" });
      const readArgs = ["read-original", ...common, "--evidence", locator.evidenceId, "--sha256", locator.sha256, "--byte-offset", String(locator.byteOffset), "--byte-length", String(locator.byteLength)];
      expect(runLocal([...readArgs, "--context-bytes", "1024"]).output).toEqual(readOriginal(board, root, root, { ...locator, contextBytes: 1024 }));
      expect(runLocal([...readArgs, "--context-bytes", "0"]).output).toEqual(readOriginal(board, root, root, locator));
      for (const value of ["-1", "2049", "1.5"]) expect(() => runLocal([...readArgs, `--context-bytes=${value}`])).toThrow("contextBytes");
      expect(() => runLocal(["search-originals", ...common, "--query", "downloadGrant", "--context-bytes", "1"])).toThrow("do not apply");
      expect(runLocal(["search-originals", ...common, "--query", "downloadGrant"]).output).toMatchObject({ inspectedCount: 1 });
      expect(runLocal(["search-originals", ...common, "--query", "downloadGrant", "--refresh"]).output).toMatchObject({ index: { updated: 1, reused: 0, indexedBytes: board.evidence[0]!.bytes } });
      expect(db.prepare("SELECT value FROM board WHERE id=1").get()!.value).toBe(saved);
    } finally { db.close(); }
  });
});
