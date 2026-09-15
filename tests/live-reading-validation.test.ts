import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeReadingOutcomes, successfulReadCalls } from "../scripts/lib/reading-outcomes.js";
import { freshSessionChecks } from "../scripts/lib/live-session-validation.js";
import { AppController } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { projectConfigPath } from "../src/paths.js";
import { selectTask } from "../src/workspace.js";
import { readDiscovery, searchTask } from "../src/wiki/query.js";
import { nativeFixture } from "./fixtures/native-retrieval.js";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";
import type { Evidence, RuntimeEvent } from "../src/types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = resolve("synthetic-reading"), body = "abc更正";
const evidence = { id: "E1", sha256: hash(body), bytes: Buffer.byteLength(body), path: "evidence/original.bin", pathBase: "task" } as Evidence;
function read(mode: RuntimeEvent["mode"], path: string, text: string, isError = false, id = "call"): RuntimeEvent[] {
  return [{ type: "tool_start", mode, toolName: "read", toolCallId: id, text: JSON.stringify({ path }) },
    { type: "tool_end", mode, toolName: "read", toolCallId: id, text, isError }];
}
function native(mode: RuntimeEvent["mode"], text = body, byteOffset = 0, overrides = {}): RuntimeEvent[] {
  return read(mode, "xloom://original?evidenceId=E1", JSON.stringify({ type: "original_read", integrity: "verified",
    locator: { evidenceId: "E1", sha256: evidence.sha256, byteOffset, byteLength: Buffer.byteLength(text) },
    rangeSha256: hash(text), text, ...overrides }));
}
const analyze = (events: RuntimeEvent[]) => analyzeReadingOutcomes(events, [evidence], root, root);

describe("live native reading verification", () => {
  it("distinguishes fully delivered file bytes from the required native route", () => {
    const result = analyze([...read("decide", join(root, evidence.path), body), ...native("execute")]);
    expect(result.originalDeliveryByRequiredRoles).toBe(true);
    expect(result.nativeReadingByRequiredRoles).toBe(false);
    expect(result.coverage[0].evidence[0]).toMatchObject({ fileComplete: true, nativeComplete: false });
  });

  it("joins byte ranges out of order and allows overlap, but not gaps or another role's bytes", () => {
    expect(analyze([...native("decide", "更正", 3), ...native("decide", "abc"), ...native("decide", "bc", 1), ...native("execute")]).nativeReadingByRequiredRoles).toBe(true);
    expect(analyze([...native("decide", "ab"), ...native("decide", "更正", 3), ...native("execute")]).nativeReadingByRequiredRoles).toBe(false);
    expect(analyze([...native("decide", "abc"), ...native("execute", "更正", 3)]).nativeReadingByRequiredRoles).toBe(false);
  });

  it("requires successful paired read events in the same role", () => {
    const events = native("decide");
    expect(analyze([events[1]]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], mode: "execute" }]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], isError: true }]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], toolCallId: "different" }]).deliveries).toHaveLength(0);
  });

  it("rejects stale hashes, wrong evidence IDs, invalid ranges and altered output", () => {
    for (const overrides of [
      { integrity: "not_checked" }, { rangeSha256: "wrong" }, { text: `${body} truncated` },
      ...[{ evidenceId: "E2" }, { sha256: "old" }, { byteOffset: -1 }, { byteOffset: 1 }, { byteLength: 1.5 }]
        .map(change => ({ locator: { evidenceId: "E1", sha256: evidence.sha256, byteOffset: 0, byteLength: evidence.bytes, ...change } })),
    ]) expect(analyze(native("decide", body, 0, overrides)).deliveries).toHaveLength(0);
  });

  it("does not count file paths, snippets, or identical content from another file as delivery", () => {
    for (const events of [read("decide", join(root, evidence.path), body.slice(1)),
      read("decide", join(root, evidence.path), body + " [truncated]"), read("decide", join(root, "other.bin"), body),
      read("decide", join(root, evidence.path), body, true), read("decide", evidence.path, body)]) {
      expect(analyze(events).deliveries).toHaveLength(0);
    }
    expect(analyzeReadingOutcomes([], [], root, root).nativeReadingByRequiredRoles).toBe(false);
  });

  it("requires a completed native Wiki search for each role, independently of original reading", () => {
    const packet = { type: "task_search", mode: "wiki", query: "BridgeAlias", complete: true, wiki: { records: [{ id: "source" }] } };
    const search = (mode: RuntimeEvent["mode"], complete: boolean) => read(mode, "xloom://search?mode=wiki&query=BridgeAlias", JSON.stringify({ ...packet, complete }));
    expect(analyze([...search("decide", true), ...search("execute", false)]).nativeSearchByRequiredRoles).toBe(false);
    expect(analyze([...search("decide", true), ...search("execute", true)]).nativeSearchByRequiredRoles).toBe(true);
    expect(analyze([...native("decide"), ...native("execute")]).nativeSearchByRequiredRoles).toBe(false);
  });

  it("keeps native Decide-only diagnostics strict when a model reads files or skips search", () => {
    const options = { roles: ["decide"] as const, query: "BridgeNote", searchModes: ["wiki", "combined"] };
    const packet = { type: "task_search", mode: "combined", query: "BridgeNote", complete: true, wiki: { records: [{ ref: { kind: "block" } }] } };
    const search = read("decide", "xloom://search?mode=combined&query=BridgeNote", JSON.stringify(packet));
    const check = (events: RuntimeEvent[]) => analyzeReadingOutcomes(events, [evidence], root, root, options);
    expect(check([...search, ...native("decide")])).toMatchObject({ nativeSearchByRequiredRoles: true, nativeReadingByRequiredRoles: true });
    expect(check([...search, ...read("decide", join(root, evidence.path), body)])).toMatchObject({ nativeSearchByRequiredRoles: true,
      nativeReadingByRequiredRoles: false, originalDeliveryByRequiredRoles: true });
    expect(check(native("decide"))).toMatchObject({ nativeSearchByRequiredRoles: false, nativeReadingByRequiredRoles: true });
    expect(check(read("decide", join(root, "saved-search.json"), JSON.stringify(packet))).nativeSearchByRequiredRoles).toBe(false);
    expect(check([search[1]]).nativeSearchByRequiredRoles).toBe(false);
    expect(check(read("decide", "xloom://search?mode=combined&query=Other", JSON.stringify({ ...packet, query: "Other" }))).nativeSearchByRequiredRoles).toBe(false);
    expect(analyzeReadingOutcomes([], [evidence], root, root, { roles: [] }).nativeReadingByRequiredRoles).toBe(false);
  });

  it("pairs discovery responses with successful same-role read calls", () => {
    const packet = { type: "discovery_context", consumerId: "C-download", complete: true };
    const events = read("decide", "xloom://discover?consumerId=C-download", JSON.stringify(packet));
    expect(successfulReadCalls(events)).toEqual([{ mode: "decide", path: "xloom://discover?consumerId=C-download", text: JSON.stringify(packet), packet }]);
    for (const altered of [[events[1]], [events[0], { ...events[1], isError: true }],
      [events[0], { ...events[1], mode: "execute" as const }], [events[0], { ...events[1], toolCallId: "other" }]]) {
      expect(successfulReadCalls(altered)).toEqual([]);
    }
  });

  it("requires every archive before and after new input, not just the new grant or one snippet", () => {
    const grantBody = "downloadGrant=LOCAL_ONLY", grant = { ...evidence, id: "E2", path: "evidence/grant.bin", sha256: hash(grantBody), bytes: Buffer.byteLength(grantBody) };
    const grantRead = native("decide", grantBody, 0, { locator: { evidenceId: grant.id, sha256: grant.sha256, byteOffset: 0, byteLength: grant.bytes } });
    const check = (events: RuntimeEvent[], items = [evidence, grant]) => analyzeReadingOutcomes(events, items, root, root, { roles: ["decide"] }).nativeReadingByRequiredRoles;
    expect(check([], [evidence])).toBe(false);
    expect(check(native("decide"), [evidence])).toBe(true);
    expect(check(grantRead)).toBe(false);
    expect(check([...read("decide", join(root, evidence.path), body), ...grantRead])).toBe(false);
    expect(check([...native("decide", "abc"), ...grantRead])).toBe(false);
    expect(check([...native("decide"), ...grantRead])).toBe(true);
  });

  it("provides the guided fixture's full source package and all archive locators at the stated budget", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "xloom-live-reading-contract-"));
    const fixture = wikiStructureFixture(fixtureRoot);
    try {
      const board = fixture.correct();
      const result = searchTask(board, fixture.store.dataDir, fixtureRoot, "BridgeAlias", { mode: "wiki", budgetChars: 64000 });
      expect(result.complete).toBe(true);
      const json = JSON.stringify(result);
      for (const item of board.evidence) { expect(json).toContain(item.id); expect(json).toContain(item.sha256); }
      expect(json).toContain("originalReadPath");
      expect(json).toContain("WK-flow");
      expect(json).toContain("aliases");
    } finally { fixture.store.close(); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  it("delivers native smoke source and discovery packets at the exact guided budget before and after new input", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "xloom-native-reading-contract-"));
    const fixture = nativeFixture(fixtureRoot);
    try {
      for (const hasProvider of [false, true]) {
        if (hasProvider) fixture.addProvider();
        const board = fixture.store.snapshot();
        const search = searchTask(board, fixture.store.dataDir, fixtureRoot, "BridgeNote", { mode: "combined", budgetChars: 64000 });
        const discovery = readDiscovery(board, fixture.store.dataDir, fixtureRoot, { consumerId: "C-download", budgetChars: 64000 });
        expect(search.complete).toBe(true); expect(discovery.complete).toBe(true);
        const json = JSON.stringify([search, discovery]);
        expect(json).toContain("originalReadPath");
        for (const item of board.evidence) { expect(json).toContain(item.id); expect(json).toContain(item.sha256); }
        if (hasProvider) { expect(json).toContain("review_required"); expect(json).toContain("C-grant"); }
      }
    } finally { fixture.store.close(); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});

describe("live replay session isolation contract", () => {
  it("starts empty, requires explicit legacy selection, and preserves saved diagnosis after closing", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "xloom-live-session-contract-"));
    const config = defaultConfig("Isolated live replay"); config.chrome = { enabled: false };
    const fixture = wikiStructureFixture(fixtureRoot, config); fixture.correct();
    fixture.store.setStatus("paused", "Original synthetic diagnostic"); fixture.store.close(); selectTask(fixtureRoot, null);
    const run = vi.fn(async () => { throw new Error("Explicit selection must not run a model"); });
    const open = () => new AppController(fixtureRoot, projectConfigPath(fixtureRoot), config, { runner: { run } });
    let app = open();
    try {
      expect(Object.values(freshSessionChecks(app)).every(Boolean)).toBe(true);
      app.openTask("@legacy");
      const before = app.snapshot();
      expect(freshSessionChecks(app)).toMatchObject({ freshChat: false, noSelectedTask: false, noResearchContext: false });
      await app.close(); app = open();
      expect(Object.values(freshSessionChecks(app)).every(Boolean)).toBe(true);
      app.openTask("@legacy");
      expect(app.snapshot()).toEqual(before);
      expect(run).not.toHaveBeenCalled();
      const history = vi.spyOn(app, "chatHistory").mockReturnValue({ id: "old", file: "old.json", messages: [{ role: "user", text: "private old chat" }],
        usage: { input: 7, output: 3, cost: 1 }, pendingToolCalls: [] });
      expect(freshSessionChecks(app).noChatHistory).toBe(false); history.mockRestore();
    } finally { await app.close(); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});
