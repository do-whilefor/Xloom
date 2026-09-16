import type { BoardSnapshot } from "../types.js";
import { discoverKnowledge } from "../knowledge/discovery.js";
import { retrieveWiki } from "./retrieval.js";
import { searchOriginals } from "./originals.js";
import { refKey, type RetrievalIndex, type RetrievalRef } from "./catalog.js";
import { wikiGenerator } from "./format.js";
import type { QueryGroup } from "./search-groups.js";

export interface SearchEnhancement { queryGroups?: QueryGroup[]; preferredRefs?: RetrievalRef[]; preferredOriginals?: string[];
  excludedRefs?: RetrievalRef[]; excludedOriginals?: string[]; index?: RetrievalIndex; semantic?: object }

// Reserve space for createTaskReader's progress diagnostics. Budgets measure compact JSON.
function limits(limit = 3, budgetChars = 16000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Native query limit must be 1–20");
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 1024 || budgetChars > 64000) throw new Error("Native query budgetChars must be 1024–64000");
  return { limit, budget: budgetChars - 512 };
}
const size = (value: unknown) => JSON.stringify(value).length;
const unique = (refs: RetrievalRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()];
const sourceComplete = (result: ReturnType<typeof retrieveWiki>) => !result.budgetDeferredCount && !result.missingAnchors.length
  && !result.records.some(record => "status" in record && record.status === "source_missing");
function exhausted(type: string, revision: number, budget: number, refs: RetrievalRef[] = []) {
  const result = { generator: wikiGenerator, type, evidence: false, boardRevision: revision, complete: false, status: "budget_exhausted", deferredRefs: [] as RetrievalRef[],
    next: "No partial source package delivered. Increase budgetChars, reduce limit or focus query/consumer. Use deferredRefs with xloom://record or task wiki/index.md for file reading when one source package exceeds 64000 chars. Omission is not absence." };
  for (const ref of unique(refs).slice(0, 3)) {
    result.deferredRefs.push(ref);
    if (size(result) > budget) result.deferredRefs.pop();
  }
  return result;
}

/** Explicitly selected search modes; original hits carry their current provenance even without a recorded gap. */
export function searchTask(board: BoardSnapshot, dataDir: string, workspace: string, query: string,
  options: { mode: string; limit?: number; budgetChars?: number; refresh?: boolean } & SearchEnhancement) {
  if (!["wiki", "originals", "combined"].includes(options.mode)) throw new Error("Search mode must be wiki, originals or combined");
  if (!query.trim() || query.length > 2048) throw new Error("Search query must contain 1–2048 characters");
  const { limit, budget: available } = limits(options.limit, options.budgetChars);
  const budget = available - (options.semantic ? size(options.semantic) + 80 : 0);
  const base = { generator: wikiGenerator, type: "task_search", evidence: false, boardRevision: board.revision, mode: options.mode, query,
    answerSupport: "not_assessed", notice: "Task-local lexical search. Wiki judgments and source windows are ranked separately. Top-k omissions are reported, not absence. Read originals and preserve source conditions/corrections; retrieval never reviews or resolves a gap." };
  const originals = options.mode === "wiki" ? undefined : searchOriginals(board, dataDir, workspace, query, limit, options.refresh, options.queryGroups, options.preferredOriginals, options.excludedOriginals);
  const remaining = budget - size({ ...base, originals }) - 1500;
  if (remaining < 1) return exhausted(base.type, board.revision, budget, originals?.hits.map(hit => ({ kind: "evidence", id: hit.locator.evidenceId })));
  const anchors = unique(originals?.hits.flatMap(hit => [{ kind: "evidence" as const, id: hit.locator.evidenceId },
    ...board.facts.filter(fact => fact.evidenceIds.includes(hit.locator.evidenceId)).map(fact => ({ kind: "fact" as const, id: fact.id }))]) ?? []);
  const wiki = retrieveWiki(board, dataDir, workspace, options.mode === "originals" ? "" : query,
    { anchors, limit: anchors.length + limit, budgetChars: remaining, refresh: options.refresh,
      ...(options.mode !== "originals" ? { queryGroups: options.queryGroups, preferredRefs: options.preferredRefs, excludedRefs: options.excludedRefs } : {}) }, options.index);
  const result = { ...base, wiki, ...(originals ? { originals } : {}), complete: sourceComplete(wiki) && (originals?.complete ?? true) };
  // Original windows cannot be delivered without their full current source/correction packages.
  if (wiki.budgetDeferredCount || size(result) > budget) return exhausted(base.type, board.revision, budget, [...wiki.deferred, ...anchors, ...wiki.hits.map(hit => hit.ref)]);
  return result;
}

/** Uses the existing AND/OR solver and the same full-source reader available to all research roles. */
export function readDiscovery(board: BoardSnapshot, dataDir: string, workspace: string,
  options: { consumerId?: string; limit?: number; maxAlternatives?: number; budgetChars?: number }) {
  const { limit, budget } = limits(options.limit, options.budgetChars);
  const maxAlternatives = options.maxAlternatives ?? 6;
  if (!Number.isSafeInteger(maxAlternatives) || maxAlternatives < 1 || maxAlternatives > 20) throw new Error("maxAlternatives must be 1–20");
  const discovery = discoverKnowledge(board, { consumerId: options.consumerId, limit, maxAlternatives });
  const base = { ...discovery, type: "discovery_context", answerSupport: "not_assessed",
    ...(options.consumerId ? { consumerId: options.consumerId } : {}),
    next: "Inspect sourceContext and originals. A candidate plan does not prove actual consumption. Use consumerId for another consumer, maxAlternatives to expand alternatives, or read xloom://record?kind=capability&id=<ID>. No declared needs means nothing to solve, not a verified result." };
  const remaining = budget - size(base) - 1500;
  if (remaining < 1) return exhausted(base.type, board.revision, budget, discovery.items.map(item => ({ kind: "capability", id: item.consumerId })));
  const anchors = unique(discovery.items.flatMap(item => [item.consumerId, ...item.inputs.flatMap(input => input.alternatives.map(alt => alt.producerId)),
    ...(item.plan?.capabilityIds ?? [])]).map(id => ({ kind: "capability", id })));
  // Even a capability with no declared needs must return its source conditions.
  if (options.consumerId && !anchors.length) anchors.push({ kind: "capability", id: options.consumerId });
  const sourceContext = retrieveWiki(board, dataDir, workspace, "", { anchors, limit: Math.max(1, anchors.length), budgetChars: remaining });
  const result = { ...base, sourceContext, complete: sourceComplete(sourceContext) && !discovery.searchTruncated };
  if (sourceContext.budgetDeferredCount || size(result) > budget) return exhausted(base.type, board.revision, budget, [...sourceContext.deferred, ...anchors]);
  return result;
}
