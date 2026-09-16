import type { BoardSnapshot } from "../types.js";
import { wikiDigest } from "./model.js";
import { readOriginal, searchOriginals } from "./originals.js";
import { retrieveQuestion } from "./questions.js";
import { planningMaterials } from "./materials.js";
import { retrieveWiki } from "./retrieval.js";
import { refKey, retrievalDocuments, type RetrievalRef } from "./catalog.js";
import { readDiscovery, searchTask, type SearchEnhancement } from "./query.js";
import type { SemanticModel } from "./semantic.js";
import { createReadingTracker } from "./reading.js";
import { compareEvidence } from "../observations/read.js";
import { createSourcePager } from "./source-pages.js";
import { readHistory } from "./history.js";

export interface TaskReadContext {
  dataDir: string; snapshot: () => BoardSnapshot; materialBaseline?: Record<string, string>;
  /** Changed by the owning runtime after replacing its active context. */
  epoch?: number;
  onAnnounced?: (items: { key: string; signature: string }[]) => void;
  semantic?: SemanticModel;
}
/** Native read destinations, scoped to the supplied task snapshot. No shell,
 * network, alternate session, or implicit research-state mutation. */
export function createTaskReader(workspace: string, context: TaskReadContext) {
  const seen = new Map<string, string>();
  let trackReading = createReadingTracker(), sourcePage = createSourcePager(), epoch = context.epoch;
  const baseline = { ...context.materialBaseline };
  const announce = (items: { key: string; signature: string }[]) => {
    for (const item of items) baseline[item.key] = item.signature;
    context.onAnnounced?.(items);
  };
  const progress = <T extends { complete?: boolean }>(url: URL, result: T, board: BoardSnapshot, budget: number) => {
    // Track unsuccessful reads too: repeating an unchanged, undersized request
    // cannot deliver new material. Cache counters are not material changes.
    const signature = wikiDigest(JSON.parse(JSON.stringify(result, (key, value) => key === "index" && value?.storage ? undefined
      : key === "semantic" && value?.status ? { status: value.status } : value)));
    const key = `${url.hostname}?${[...url.searchParams].filter(([key]) => key !== "refresh").sort(([a], [b]) => a.localeCompare(b)).map(pair => JSON.stringify(pair)).join("&")}`;
    const repeated = seen.get(key) === signature;
    seen.set(key, signature);
    const retrievalProgress = !result.complete ? repeated ? "stop_repeating_incomplete_query" : "resolve_incomplete_retrieval"
      : repeated ? "stop_repeating_query" : "inspect_material";
    const hinted = { ...result, retrievalProgress };
    return trackReading(JSON.stringify(hinted).length <= budget ? hinted : result, board, budget);
  };
  return (path: string, enhancement: SearchEnhancement = {}) => {
    if (context.epoch !== epoch) {
      epoch = context.epoch; seen.clear(); trackReading = createReadingTracker(); sourcePage = createSourcePager();
    }
    const url = new URL(path), p = url.searchParams;
    if (url.protocol !== "xloom:" || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== "/") throw new Error("Invalid xloom read path");
    const allowed = url.hostname === "history" ? ["kind", "offset", "limit", "budgetChars", "signature"]
      : url.hostname === "question" ? ["stepId", "gapId", "query", "limit", "budgetChars", "refresh"]
      : url.hostname === "materials" ? ["budgetChars", "refresh"] : url.hostname === "record" ? ["kind", "id", "page", "budgetChars", "sourceOffset", "packageSignature"]
      : url.hostname === "original" ? ["evidenceId", "sha256", "byteOffset", "byteLength", "contextBytes"]
      : url.hostname === "discover" ? ["consumerId", "limit", "maxAlternatives", "budgetChars"]
      : url.hostname === "compare" ? ["left", "right", "fields"]
      : url.hostname === "search" ? ["query", "limit", "refresh", "mode", "budgetChars"] : [];
    if (!allowed.length || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)) throw new Error("Unknown or duplicate xloom read parameters");
    const required = (key: string) => { const value = p.get(key); if (!value) throw new Error(`Missing xloom read parameter: ${key}`); return value; };
    const number = (key: string) => { if (!p.has(key)) return undefined; const value = required(key); if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key}`); return Number(value); };
    const board = context.snapshot();
    if (url.hostname === "history") return readHistory(board, url);
    if (p.has("refresh") && !["true", "false"].includes(required("refresh"))) throw new Error("refresh must be true or false");
    const refresh = p.get("refresh") === "true";
    if (url.hostname === "compare") return compareEvidence(board, context.dataDir, workspace, required("left"), required("right"), p.has("fields") ? JSON.parse(required("fields")) : []);
    if (url.hostname === "materials") {
      const result = planningMaterials(board, refresh ? {} : baseline, context.dataDir, workspace, number("budgetChars") ?? 6000);
      announce(result.items);
      return result;
    }
    if (url.hostname === "record") {
      const kind = required("kind"), id = required("id"), pageId = p.get("page") ?? undefined;
      if (!["goal", "step", "fact", "finding", "evidence", "attempt", "capability", "chain", "block"].includes(kind)) {
        throw new Error("Invalid exact record kind. Supported: goal, step, fact, finding, evidence, attempt, capability, chain, block. For Wiki page metadata/aliases use kind=block&page=<page ID>&id=<block ID>; discover block IDs with xloom://search?mode=wiki&query=<title-or-alias>.");
      }
      if ((kind === "block") !== Boolean(pageId)) throw new Error("Invalid exact record reference: kind=block requires page=<Wiki page ID> and id=<block ID>; other kinds must omit page.");
      const ref = { kind: kind as RetrievalRef["kind"], id, ...(pageId ? { pageId } : {}) };
      const anchors: RetrievalRef[] = [ref, ...(kind === "evidence" ? board.facts.filter(fact => fact.evidenceIds.includes(id)).map(fact => ({ kind: "fact" as const, id: fact.id })) : [])];
      const budgetChars = number("budgetChars") ?? 16000;
      if (budgetChars < 1024 || budgetChars > 64000) throw new Error("Record budgetChars must be 1024–64000");
      const result = retrieveWiki(board, context.dataDir, workspace, "", { anchors, limit: anchors.length, budgetChars: Math.max(1, budgetChars - 1024) });
      if (p.has("sourceOffset")) number("sourceOffset");
      if (p.has("packageSignature") && (!p.has("sourceOffset") || !/^[a-f0-9]{64}$/.test(required("packageSignature")))) throw new Error("Invalid source package cursor");
      if (p.has("sourceOffset") || result.budgetDeferredCount && budgetChars === 64000) {
        const full = retrieveWiki(board, context.dataDir, workspace, "", { anchors, limit: anchors.length });
        if (full.records.length) {
          const page = sourcePage(full, ref, url, budgetChars);
          // Announce only fully delivered source packages, never partial pages.
          if (page.complete) {
            const keys = new Set(anchors.map(refKey));
            announce(retrievalDocuments(board).documents.filter(doc => keys.has(refKey(doc.ref))).map(doc => ({ key: refKey(doc.ref), signature: wikiDigest(doc) })));
          }
          return progress(url, page, board, budgetChars);
        }
      }
      const complete = !result.deferredCount && !result.missingAnchors.length && !result.records.some(record => "status" in record && record.status === "source_missing");
      const nextUrl = new URL(url); nextUrl.searchParams.set("budgetChars", "64000");
      const status = result.missingAnchors.length || result.records.some(record => "status" in record && record.status === "source_missing")
        ? "source_missing" : result.budgetDeferredCount ? "source_package_deferred" : "inspect_material";
      const recovery = { requestedRef: ref, readPath: path, status,
        ...(!complete && result.budgetDeferredCount && budgetChars < 64000 ? { nextReadPath: nextUrl.href } : {}),
        next: complete ? "Read original ranges and preserve source conditions/corrections. A delivered record is not a reviewed or resolved gap."
          : status === "source_missing" ? "Referenced sources are missing. Inspect missingAnchors/source_missing; increasing the budget cannot restore them."
          : "Source package exceeds the current budget. Follow nextReadPath when provided; do not repeat the same undersized request or infer that evidence is missing. At the maximum budget inspect the referenced Wiki files and their dependencies; delivery is still incomplete." };
      const packet = { ...result, complete, ...recovery };
      if (JSON.stringify(packet).length > budgetChars) return progress(url, { type: "retrieval", evidence: false, complete: false,
        ...recovery, status: "budget_exhausted", hits: [], records: [], deferredCount: anchors.length }, board, budgetChars);
      if (complete) {
        const keys = new Set(anchors.map(refKey));
        announce(retrievalDocuments(board).documents.filter(doc => keys.has(refKey(doc.ref)))
          .map(doc => ({ key: refKey(doc.ref), signature: wikiDigest(doc) })));
      }
      return progress(url, packet, board, budgetChars);
    }
    if (url.hostname === "original") return trackReading(readOriginal(board, context.dataDir, workspace, { evidenceId: required("evidenceId"), sha256: required("sha256"), byteOffset: number("byteOffset") ?? 0, byteLength: number("byteLength"), contextBytes: number("contextBytes") }), board);
    const result = url.hostname === "question" ? retrieveQuestion(board, context.dataDir, workspace, { stepId: required("stepId"), gapId: required("gapId") },
      { query: p.get("query") ?? undefined, limit: number("limit"), budgetChars: number("budgetChars"), refresh, ...enhancement })
      : url.hostname === "discover" ? readDiscovery(board, context.dataDir, workspace,
        { consumerId: p.has("consumerId") ? required("consumerId") : undefined, limit: number("limit"), maxAlternatives: number("maxAlternatives"), budgetChars: number("budgetChars") })
      : p.has("mode") || p.has("budgetChars") ? searchTask(board, context.dataDir, workspace, required("query"),
        { mode: p.has("mode") ? required("mode") : "originals", limit: number("limit"), budgetChars: number("budgetChars"), refresh, ...enhancement })
      : searchOriginals(board, context.dataDir, workspace, required("query"), number("limit"), refresh);
    const budget = number("budgetChars") ?? (url.hostname === "search" && !p.has("mode") ? Infinity : 16000);
    return progress(url, enhancement.semantic ? { ...result, semantic: enhancement.semantic } : result, board, budget);
  };
}
