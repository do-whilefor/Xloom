import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { RunRequest } from "../../src/types.js";
import { projectContext } from "../../src/loop/context.js";
import { factIndexEntries } from "../../src/loop/history.js";
import { buildRunTaskCore } from "../../src/runtime/prompts.js";
import { prepareContext, recoverableMessages } from "../../src/runtime/continuity.js";
import { readHistory } from "../../src/wiki/history.js";
import { buildRetrievalIndex } from "../../src/wiki/catalog.js";
import { retrieveWiki } from "../../src/wiki/retrieval.js";
import { observationRetrievalFixture } from "./observation-retrieval.js";

const sizeOf = (value: unknown) => JSON.stringify(value).length;
const constraint = "只能修改 auth.py；已完成的写操作不能重复执行。";
const model: Model<"openai-completions"> = { id: "synthetic", name: "synthetic", api: "openai-completions", provider: "fixture",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
function readBatch(id: string, path: string, text: string, native = false): AgentMessage[] {
  const assistant: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
    api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", usage, timestamp: 0 };
  return [assistant, { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }],
    ...(native ? { details: { nativeRetrieval: true } } : {}), isError: false, timestamp: 0 }];
}
function request(size: number, workspace: string): RunRequest {
  const snapshot = observationRetrievalFixture(0);
  snapshot.hints = [{ id: "H-constraint", content: constraint, createdAt: "2026-09-16T00:00:00Z" }];
  for (let i = 0; i < size; i++) snapshot.facts.push({ id: `F-${i}`, stepId: null,
    description: `Historical observation ${i}: alice/v1; NOT verified for bob/v2.`, evidenceIds: [] });
  return { id: "maintenance-fixture", mode: "decide", snapshot, workspace, runDir: join(workspace, "runs", "current"),
    blackboardPath: join(workspace, "blackboard.md"), signal: new AbortController().signal, onEvent() {} };
}

/** Offline structural experiment. No model/provider call or claim of answer
 * accuracy. The all-index comparator changes only factIndex on current context. */
export async function evaluateContextMaintenance(workspace: string) {
  const sizes = [100, 1000, 3000].map(facts => {
    const req = request(facts, workspace), context = projectContext(req), index = factIndexEntries(req.snapshot);
    let path: string | undefined = "xloom://history?kind=fact&limit=100&budgetChars=16000", pages = 0;
    const ids: string[] = [];
    while (path && pages < facts) {
      const result = readHistory(req.snapshot, new URL(path));
      ids.push(...result.items.map(item => (item as { id: string }).id)); path = result.nextReadPath; pages++;
    }
    return { facts, allIndexChars: sizeOf(index), boundedIndexChars: sizeOf(context.factIndex),
      allIndexEquivalentContextChars: sizeOf({ ...context, factIndex: index }), contextChars: sizeOf(context), taskCoreChars: buildRunTaskCore(req).length,
      indexedFacts: context.factIndex.length, omittedFacts: context.projection.omittedFactIndex, historyPages: pages,
      completeHistory: path === undefined && JSON.stringify(ids) === JSON.stringify(req.snapshot.facts.map(fact => fact.id)) };
  });
  const req = request(3000, workspace), source = "CSRF token mismatch; old session_id. alice/v1 only; NOT a global failure.";
  const locator = { evidenceId: "E-exact", sha256: createHash("sha256").update(source).digest("hex"), byteOffset: 0, byteLength: Buffer.byteLength(source) };
  const packet = JSON.stringify({ type: "original_read", integrity: "verified", locator, text: source,
    sourceContextReadPath: "xloom://record?kind=evidence&id=E-exact" });
  const exact = readBatch("decisive", "xloom://original?evidenceId=E-exact", packet, true);
  const filler = (round: number) => Array.from({ length: 30 }, (_, i) => readBatch(`filler-${round}-${i}`, `fixture-${i}.txt`, "exploratory observation ".repeat(110))).flat();
  let messages = [user("Initial snapshot " + "history ".repeat(10000)), ...exact, ...filler(0)], summaries = 0;
  const rounds: { round: number; beforeChars: number; afterChars: number; compacted: boolean; exactSourceRetained: boolean;
    constraintRetained: boolean; latestCorrectionRetained: boolean; completeToolPairs: boolean }[] = [];
  for (let round = 1; round <= 3; round++) {
    const correction = `Current identity=bob/v${round + 2}; previous conditions withdrawn.`;
    req.snapshot.hints.push({ id: `H-${round}`, content: correction, createdAt: `2026-09-16T00:00:0${round}Z` });
    const beforeChars = sizeOf(messages);
    const result = await prepareContext(messages, model, undefined, async () => { summaries++; return { text: "Lossy fixture summary deliberately omitting all identifiers and conditions." }; },
      false, undefined, { taskCore: () => buildRunTaskCore(req) });
    const first = result.messages[0], core = first?.role === "user" ? String(first.content) : "";
    rounds.push({ round, beforeChars, afterChars: sizeOf(result.messages), compacted: result.compacted,
      exactSourceRetained: result.messages.includes(exact[1]!), constraintRetained: core.includes(constraint), latestCorrectionRetained: core.includes(correction),
      completeToolPairs: JSON.stringify(recoverableMessages(result.messages)) === JSON.stringify(result.messages) });
    messages = [...result.messages, ...filler(round)];
  }
  let duplicateSummaries = 0;
  const repeated = [user("History " + "unchanged ".repeat(10000)), ...Array.from({ length: 12 }, (_, i) => readBatch(`repeat-${i}`, "xloom://original?evidenceId=E-exact", packet, true)).flat()];
  const pruned = await prepareContext(repeated, model, undefined, async () => { duplicateSummaries++; return { text: "Unexpected summary" }; },
    false, undefined, { taskCore: () => buildRunTaskCore(req) });
  const board = req.snapshot;
  const absent = retrieveWiki(board, workspace, workspace, "What is the zqvnosuchidentifier?", {}, buildRetrievalIndex(board));
  return { measurement: "synthetic serialized characters, not billed tokens or live model effectiveness",
    comparator: "Current projectContext with only factIndex expanded to all history; not a full older-release replay", sizes,
    compaction: { summaries, rounds }, repeatedReads: { removedBatches: pruned.maintenance?.removedReadBatches ?? 0, summaries: duplicateSummaries,
      beforeChars: sizeOf(repeated), afterChars: sizeOf(pruned.messages) }, weakQuery: { hits: absent.hits.length, matchQuality: absent.matchQuality } };
}
