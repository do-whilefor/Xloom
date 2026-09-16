import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { nativeReadBatch, pruneReadBatches } from "../src/runtime/context-pruning.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { clearRetrievalSnapshots } from "../src/wiki/incremental.js";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";

const fixtures: ReturnType<typeof wikiStructureFixture>[] = [], roots: string[] = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function batch(id: string, packet: unknown, path = "xloom://search?mode=combined&query=label") : AgentMessage[] {
  return [{ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: "toolUse", timestamp: 0,
    content: [{ type: "toolCall", id, name: "read", arguments: { path } }] },
  { role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 0,
    content: [{ type: "text", text: JSON.stringify(packet) }], details: { nativeRetrieval: true } }];
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
  clearRetrievalSnapshots();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-pruning-")) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native search deduplication", () => {
  it.each(["wiki", "combined", "question"])("removes both older %s reads despite cold/warm nested index counters", async mode => {
    const root = mkdtempSync(join(tmpdir(), "xloom-pruning-")); roots.push(root);
    const f = wikiStructureFixture(root); fixtures.push(f);
    const board = f.store.snapshot(), template = board.wikiPages![0]!, step = board.steps[0]!;
    board.wikiPages!.push({ ...structuredClone(template), id: "WK-cold", blocks: [{ ...structuredClone(template.blocks[0]!), id: "B-cold", text: "label returned cold index" }] });
    step.gaps = [{ id: "gap-label", missing: "label returned", why: "Inspect outcome", reopenWhen: "Source read", needs: [],
      conditions: { scope: null, identity: null, environment: null, stateVersion: null }, sources: [] }];
    const tool = createWorkspaceReadTool(root, undefined, { dataDir: f.store.dataDir, snapshot: () => board });
    const path = mode === "question" ? `xloom://question?stepId=${step.id}&gapId=gap-label&budgetChars=64000`
      : `xloom://search?mode=${mode}&query=label%20returned&budgetChars=64000`;
    const messages: AgentMessage[] = [{ role: "user", content: "Inspect source conditions.", timestamp: 0 }], batches = [{ start: 0, end: 1 }];
    const packets: any[] = [], signatures: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await tool.execute(`read-${i}`, { path });
      const packet = JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));
      expect(packet.complete).toBe(true); packets.push(packet);
      const start = messages.length, pair = batch(String(i), packet, path);
      signatures.push(nativeReadBatch(pair)!.signature); messages.push(...pair); batches.push({ start, end: messages.length });
    }
    expect(packets[0]).not.toEqual(packets[1]); expect(new Set(signatures).size).toBe(1);
    const before = structuredClone(messages), result = pruneReadBatches(messages, batches);
    expect(result.removed).toBe(2); expect(result.messages).toEqual([messages[0], ...messages.slice(-4)]);
    expect(messages).toEqual(before);
  });

  it.each(["source", "locator", "signature", "warning", "source-index", "unknown-index"])("retains changed %s data despite counter normalization", changed => {
    const first = { type: "task_search", complete: true, wiki: { type: "retrieval", corpusSignature: "original",
      index: { added: 1, storage: "persistent", fallbackReason: "first", futureMetadata: "original" },
      records: [{ text: "alice/v1 only", index: { reused: 1 } }] },
      originals: { type: "original_search", index: { added: 1 }, hits: [{ locator: { sha256: "first", byteOffset: 0 }, snippet: "DENIED" }] } };
    const second = structuredClone(first); second.wiki.index.added = 0; second.originals.index.added = 0;
    if (changed === "source") second.wiki.records[0].text = "bob/v2 only";
    if (changed === "locator") second.originals.hits[0].locator.byteOffset = 5;
    if (changed === "signature") second.wiki.corpusSignature = "new";
    if (changed === "warning") second.wiki.index.fallbackReason = "new failure";
    if (changed === "source-index") second.wiki.records[0].index.reused = 2;
    if (changed === "unknown-index") second.wiki.index.futureMetadata = "changed";
    expect(nativeReadBatch(batch("a", first))!.signature).not.toBe(nativeReadBatch(batch("b", second))!.signature);
  });
});
