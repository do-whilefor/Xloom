import type { BoardSnapshot } from "../types.js";
import { gapQueue, gapReadPath, gapSearchQuery, gapSearchGroups, type GapRef } from "../knowledge/gaps.js";
import { retrieveWiki } from "./retrieval.js";
import { searchOriginals } from "./originals.js";
import { wikiGenerator } from "./format.js";
import type { RetrievalRef } from "./catalog.js";
import type { SearchEnhancement } from "./query.js";

/** Search one recorded missing prerequisite, carrying its original context and
 * the explicit provenance/corrections of candidate material back to Decide. */
export function retrieveQuestion(board: BoardSnapshot, dataDir: string, workspace: string, ref: GapRef,
  options: { query?: string; limit?: number; budgetChars?: number; refresh?: boolean } & SearchEnhancement = {}) {
  const question = gapQueue(board).find(item => item.stepId === ref.stepId && item.gapId === ref.gapId);
  if (!question) throw new Error("Unknown Step/gap in this task; use an exact gaps.readPath");
  const requestedBudget = options.budgetChars ?? 16000;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 128 || requestedBudget > 64000) throw new Error("Question budgetChars must be 128–64000");
  const budget = requestedBudget - (options.semantic ? JSON.stringify(options.semantic).length + 80 : 0);
  const query = options.query ?? gapSearchQuery(question);
  const base = { generator: wikiGenerator, type: "question_context", evidence: false, boardRevision: board.revision, questionRef: ref,
    answerSupport: "not_assessed", queryOrigin: options.query === undefined ? "step_gap" : "explicit_query", query };
  const nextParams = new URLSearchParams({ stepId: ref.stepId, gapId: ref.gapId, budgetChars: "64000",
    ...(options.query !== undefined ? { query: options.query } : {}), ...(options.limit !== undefined ? { limit: String(options.limit) } : {}) });
  const overflow = { ...base, complete: false, status: "budget_exhausted", readPath: gapReadPath(ref),
    ...(requestedBudget < 64000 ? { nextReadPath: `xloom://question?${nextParams}` } : {}),
    notice: "Full question/source material exceeds delivery budget; increase budgetChars or narrow the query. Omitted material is not absent; no gap was resolved." };
  const incomplete = JSON.stringify(overflow).length <= budget ? overflow
    : { type: "question_context", evidence: false, complete: false, status: "budget_exhausted" };
  const questionSize = JSON.stringify({ ...base, question }).length;
  if (questionSize > budget / 2) return incomplete;
  const queryGroups = options.queryGroups ?? (options.query === undefined ? gapSearchGroups(question) : undefined);
  const originals = searchOriginals(board, dataDir, workspace, query, options.limit ?? 3, options.refresh, queryGroups, options.preferredOriginals, options.excludedOriginals);
  const anchors: RetrievalRef[] = [{ kind: "step", id: ref.stepId }, ...question.sources.map(item => item.source),
    ...question.candidates.map(item => ({ kind: "capability" as const, id: item.capabilityId })),
    ...originals.hits.flatMap(hit => [{ kind: "evidence" as const, id: hit.locator.evidenceId },
      ...board.facts.filter(fact => fact.evidenceIds.includes(hit.locator.evidenceId)).map(fact => ({ kind: "fact" as const, id: fact.id }))])];
  const unique = [...new Map(anchors.map(item => [JSON.stringify(item), item])).values()];
  const sourceContext = retrieveWiki(board, dataDir, workspace, queryGroups ? query : "", { anchors: unique, limit: Math.max(1, unique.length) + (queryGroups ? options.limit ?? 3 : 0),
    queryGroups, preferredRefs: options.preferredRefs, excludedRefs: options.excludedRefs, budgetChars: Math.max(1, Math.floor((budget - questionSize) / 2)) }, options.index);
  const missing = sourceContext.missingAnchors.length > 0 || sourceContext.records.some(record => "status" in record && record.status === "source_missing");
  const deferred = queryGroups ? sourceContext.budgetDeferredCount : sourceContext.deferredCount;
  const complete = originals.complete && !deferred && !missing;
  const result = { ...base, question, originals, sourceContext, complete,
    status: complete ? "inspect_material" : missing ? "source_missing" : deferred ? "source_package_deferred" : "originals_unavailable",
    ...(!complete && deferred && requestedBudget < 64000 ? { nextReadPath: `xloom://question?${nextParams}` } : {}),
    next: !complete ? "Source delivery is incomplete. Follow nextReadPath for a larger package when supplied. Otherwise inspect missing/unavailable sources or read deferred sourceContext records individually; do not repeat the same maximum-budget query or assume omitted conditions."
      : "Read xloom://original locators from originals.hits[].readPath or evidence.originalReadPath to verify archive bytes; nextReadPath continues. Preserve the full sourceContext including conditions/corrections/counterevidence. Narrow each remaining input. Only Decide revisits/gapReviews can resolve with evidence-backed Facts." };
  return JSON.stringify(result).length <= budget ? result : incomplete;
}
