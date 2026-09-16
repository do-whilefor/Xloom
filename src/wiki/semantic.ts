import { z } from "zod";
import { gapQueue, gapSearchGroups, gapSearchQuery } from "../knowledge/gaps.js";
import { cachedEntries, cachedEntry, pruneEntries, putEntry, removeEntry, withIndexCache } from "./cache.js";
import { refKey, terms, type RetrievalDocument, type RetrievalIndex, type RetrievalRef } from "./catalog.js";
import { incrementalRetrievalIndex, retrievalInputSignature } from "./incremental.js";
import { wikiDigest } from "./model.js";
import { searchOriginals } from "./originals.js";
import { retrieveWiki } from "./retrieval.js";
import { compileQueryGroups, type QueryGroup } from "./search-groups.js";
import type { TaskReadContext, createTaskReader } from "./read.js";
import type { SearchEnhancement } from "./query.js";

export interface SemanticModel {
  /** Provider/model/endpoint/protocol identity, without credentials. */
  identity: string;
  generate(stage: "index" | "expand" | "rerank", input: unknown, signal?: AbortSignal): Promise<unknown>;
}
const hintSchema = z.array(z.string().trim().min(1).max(512)).min(1).max(6);
const indexingSchema = z.object({ documents: z.array(z.object({ id: z.string(), queries: hintSchema }).strict()).min(1).max(8) }).strict();
const expansionSchema = z.object({ groups: z.array(z.object({ id: z.string(), queries: z.array(z.string().trim().min(1).max(512)).max(4) }).strict()).min(1).max(9) }).strict();
const rankingSchema = z.object({ scores: z.array(z.object({ id: z.string(), score: z.number().finite().min(0).max(100) }).strict()).max(12) }).strict();
const protocol = "semantic-retrieval-v3";
export const semanticLimits = { indexDocuments: 8, indexInputChars: 48000, rerankCandidates: 12, rerankInputChars: 48000 } as const;
type Stage = Parameters<SemanticModel["generate"]>[0];
type StageCost = { requests: number; cacheHits: number; inputChars: number; elapsedMs: number };
type Counters = { requests: number; cacheHits: number; indexedDocuments: number; reusedDocuments: number;
  deferredDocuments: number; oversizedDocuments: number; deferredCandidates: number; oversizedCandidates: number;
  stages: Record<Stage, StageCost> };

async function generate(model: SemanticModel, stage: Stage, input: unknown, signal: AbortSignal | undefined, counters: Counters) {
  signal?.throwIfAborted();
  const cost = counters.stages[stage], started = performance.now();
  counters.requests++; cost.requests++; cost.inputChars += JSON.stringify(input).length;
  try { return await model.generate(stage, input, signal); }
  finally { cost.elapsedMs += Math.round(performance.now() - started); }
}

/** Query must consist entirely of known IDs; ordinary words alongside an ID
 * still use the requested strategy. Block IDs require their page ID. */
function exactReferenceQuery(query: string, index: RetrievalIndex): boolean {
  const value = query.normalize("NFKC").toLowerCase().trim();
  if (!/^[a-z0-9_-]+(?:\s+[a-z0-9_-]+)*$/.test(value)) return false;
  const tokens = new Set(value.split(/\s+/)), matched = new Set<string>();
  for (const { ref } of index.documents) if (tokens.has(ref.id.toLowerCase()) && (ref.kind !== "block" || tokens.has(ref.pageId!.toLowerCase()))) {
    matched.add(ref.id.toLowerCase());
    if (ref.pageId) matched.add(ref.pageId.toLowerCase());
  }
  return [...tokens].every(token => matched.has(token));
}

function closure(ref: RetrievalRef, documents: Map<string, RetrievalDocument>): RetrievalDocument[] {
  const pending = [ref], sources = new Map<string, RetrievalDocument>();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const key = refKey(pending[cursor]!), doc = documents.get(key);
    if (!doc || sources.has(key)) continue;
    sources.set(key, doc); pending.push(...doc.sources, ...doc.requiredBlocks ?? []);
  }
  return [...sources.values()];
}

/** One durable hint entry per Wiki judgment and full source basis. Metadata-only
 * author edits remain author edits: generated questions live solely in cache. */
async function enrichIndex(index: RetrievalIndex, context: TaskReadContext, workspace: string, model: SemanticModel,
  refresh: boolean, signal: AbortSignal | undefined, counters: Counters, preferred: RetrievalRef[]): Promise<RetrievalIndex> {
  const docs = new Map(index.documents.map(doc => [refKey(doc.ref), doc]));
  const entries = index.documents.filter(doc => doc.ref.kind === "block").map((doc, i) => {
    const records = closure(doc.ref, docs);
    return { id: `H${i}`, key: refKey(doc.ref), records, signature: wikiDigest([protocol, model.identity, records]) };
  });
  if (!entries.length) return index;
  const previous = withIndexCache(context.dataDir, workspace, db => cachedEntries<string[]>(db, "semantic-doc"));
  const hints: Record<string, string[]> = Object.create(null), pending: typeof entries = [];
  for (const entry of entries) {
    const cached = previous.get(entry.key), value = hintSchema.safeParse(cached?.value);
    if (!refresh && cached?.signature === entry.signature && value.success) { hints[entry.key] = value.data; counters.reusedDocuments++; }
    else pending.push(entry);
  }
  const order = new Map(preferred.map((ref, i) => [refKey(ref), i]));
  pending.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  const batch: typeof entries = [];
  const input = (items: typeof entries) => ({ documents: items.map(({ id, records }) => ({ id, records })) });
  for (const entry of pending) {
    if (JSON.stringify(input([entry])).length > semanticLimits.indexInputChars) { counters.oversizedDocuments++; continue; }
    if (batch.length >= semanticLimits.indexDocuments || JSON.stringify(input([...batch, entry])).length > semanticLimits.indexInputChars) continue;
    batch.push(entry);
  }
  counters.deferredDocuments = pending.length - batch.length;
  if (batch.length) {
    const result = indexingSchema.parse(await generate(model, "index", input(batch), signal, counters));
    const ids = new Set(batch.map(entry => entry.id));
    if (result.documents.length !== ids.size || new Set(result.documents.map(entry => entry.id)).size !== ids.size || result.documents.some(entry => !ids.has(entry.id))) throw new Error("Invalid indexed document IDs");
    signal?.throwIfAborted();
    withIndexCache(context.dataDir, workspace, db => {
      for (const entry of batch) {
        const queries = result.documents.find(value => value.id === entry.id)!.queries;
        hints[entry.key] = queries; putEntry(db, "semantic-doc", entry.key, entry.signature, queries, []);
      }
    });
    counters.indexedDocuments += batch.length;
  }
  withIndexCache(context.dataDir, workspace, db => pruneEntries(db, "semantic-doc", new Set(entries.map(entry => entry.key))));
  const postings = { ...index.postings }, lengths = [...index.lengths];
  index.documents.forEach((doc, i) => {
    const counts = new Map<string, number>();
    for (const word of terms((hints[refKey(doc.ref)] ?? []).join(" "))) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [word, count] of counts) {
      const values: [number, number][] = (postings[word] ?? []).map(([id, n]) => [id, n]);
      const existing = values.find(value => value[0] === i);
      if (existing) existing[1] += count; else values.push([i, count]);
      postings[word] = values; lengths[i]! += count;
    }
  });
  // Cache identity cannot depend on the order in which cold batches finished.
  const stableHints = Object.fromEntries(Object.entries(hints).sort(([a], [b]) => a.localeCompare(b)));
  return { ...index, postings, lengths, semanticHints: stableHints, signature: wikiDigest([index.signature, stableHints]) };
}

/** Derived query/ranking hints only. No source text, evidence verdict, author
 * review or generated answer is persisted here. Disk failures recompute. */
async function memo<T>(context: TaskReadContext, workspace: string, model: SemanticModel, stage: "expand" | "rerank", input: unknown,
  parse: (value: unknown) => T, refresh: boolean, signal: AbortSignal | undefined, counters: Counters) {
  const key = wikiDigest([protocol, model.identity, stage, input]);
  if (!refresh) {
    const cached = withIndexCache(context.dataDir, workspace, db => {
      const entry = cachedEntry<unknown>(db, "semantic", key);
      return entry?.signature === key ? parse(entry.value) : undefined;
    });
    if (cached !== undefined) { counters.cacheHits++; counters.stages[stage].cacheHits++; return cached; }
  }
  const value = parse(await generate(model, stage, input, signal, counters));
  signal?.throwIfAborted();
  withIndexCache(context.dataDir, workspace, db => {
    putEntry(db, "semantic", key, key, value, []);
    // Bound abandoned query/corpus/model generations. No authoritative rows.
    for (const row of db.prepare("SELECT key FROM entries WHERE namespace='semantic' ORDER BY rowid DESC LIMIT -1 OFFSET 512").all()) removeEntry(db, "semantic", String(row.key));
  });
  return value;
}

/** Uses the same native reader for delivery and its receipt/reading accounting.
 * Candidate collection is internal and never acknowledges unseen material. */
export function createSemanticTaskReader(workspace: string, context: TaskReadContext, read: ReturnType<typeof createTaskReader>) {
  return async (path: string, signal?: AbortSignal): Promise<object> => {
    const url = new URL(path), p = url.searchParams;
    const strategy = p.get("strategy");
    if (strategy === null) return read(path);
    if (p.getAll("strategy").length !== 1 || !["lexical", "semantic"].includes(strategy)) throw new Error("Search strategy must be lexical or semantic");
    if (!["search", "question"].includes(url.hostname)) throw new Error("strategy is supported only for search/question");
    p.delete("strategy");
    if (strategy === "lexical") return read(url.href);
    const allowed = url.hostname === "search" ? ["query", "mode", "limit", "budgetChars", "refresh"] : ["stepId", "gapId", "query", "limit", "budgetChars", "refresh"];
    if (url.protocol !== "xloom:" || url.username || url.password || url.port || url.hash || url.pathname && url.pathname !== "/"
      || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)) throw new Error("Invalid semantic search parameters");
    const numeric = (key: string, fallback: number, min: number, max: number) => {
      const raw = p.get(key), value = raw === null ? fallback : Number(raw);
      if (raw !== null && !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid semantic ${key}`);
      return value;
    };
    const budget = numeric("budgetChars", 16000, url.hostname === "search" ? 1024 : 128, 64000);
    numeric("limit", 3, 1, 20);
    if (p.has("refresh") && !["true", "false"].includes(p.get("refresh")!)) throw new Error("refresh must be true or false");
    const refresh = p.get("refresh") === "true", mode = p.get("mode") ?? "originals";
    if (!["wiki", "originals", "combined"].includes(mode)) throw new Error("Search mode must be wiki, originals or combined");
    const board = context.snapshot(), signature = retrievalInputSignature(board);
    const gap = url.hostname === "question" ? gapQueue(board).find(gap => gap.stepId === p.get("stepId") && gap.gapId === p.get("gapId")) : undefined;
    if (url.hostname === "question" && !gap) throw new Error("Unknown Step/gap in this task");
    const query = p.get("query") ?? (gap ? gapSearchQuery(gap) : "");
    if (!query.trim() || query.length > 4000 || url.hostname === "search" && query.length > 2048) throw new Error("Invalid semantic query length");
    const next = new URL(path); next.searchParams.set("budgetChars", "64000");
    if (budget < 2048) return { type: url.hostname === "question" ? "question_context" : "task_search", evidence: false, complete: false, status: "budget_exhausted", nextReadPath: next.href };
    if (url.hostname === "search" && !p.has("mode")) p.set("mode", mode);
    p.set("budgetChars", String(budget));
    const cost = (): StageCost => ({ requests: 0, cacheHits: 0, inputChars: 0, elapsedMs: 0 });
    const model = context.semantic, counters: Counters = { requests: 0, cacheHits: 0, indexedDocuments: 0, reusedDocuments: 0,
      deferredDocuments: 0, oversizedDocuments: 0, deferredCandidates: 0, oversizedCandidates: 0,
      stages: { expand: cost(), index: cost(), rerank: cost() } };
    const deliver = (enhancement: SearchEnhancement, status: string) => {
      const output = read(url.href, { ...enhancement, semantic: { status, ...counters, limits: semanticLimits,
        notice: "Retrieval hints only; read current sources and conditions. Deferred packages remain lexical candidates. inputChars counts serialized inputs, not billed tokens; elapsedMs measures model calls. No evidence validity or gap resolution is asserted." } });
      // Continuations must retain the requested strategy, not silently revert.
      if ("nextReadPath" in output && typeof output.nextReadPath === "string") {
        const next = new URL(output.nextReadPath); next.searchParams.set("strategy", "semantic"); output.nextReadPath = next.href;
      }
      return output;
    };
    try {
      signal?.throwIfAborted();
      const baseIndex = incrementalRetrievalIndex(board, context.dataDir, workspace).index;
      if (url.hostname === "search" && mode === "wiki" && exactReferenceQuery(query, baseIndex)) return deliver({ index: baseIndex }, "exact_reference_local");
      if (!model) return deliver({}, "unavailable_lexical_fallback");
      const groups: QueryGroup[] = (gap && !p.has("query") ? gapSearchGroups(gap) : undefined) ?? [{ id: "query", alternatives: [query] }];
      const expanded = await memo(context, workspace, model, "expand", { query, groups }, value => {
        const result = expansionSchema.parse(value);
        if (result.groups.length !== groups.length || new Set(result.groups.map(group => group.id)).size !== groups.length
          || result.groups.some(group => !groups.some(expected => expected.id === group.id))) throw new Error("Invalid expanded group IDs");
        return result;
      }, refresh, signal, counters);
      const queryGroups = groups.map(group => ({ id: group.id, alternatives: [...new Set([...group.alternatives,
        ...expanded.groups.find(item => item.id === group.id)!.queries])].slice(0, 10) }));
      compileQueryGroups(query, queryGroups);
      const priority = retrieveWiki(board, context.dataDir, workspace, query, { queryGroups, limit: 40 }, baseIndex).hits.map(hit => hit.ref);
      const index = await enrichIndex(baseIndex, context, workspace, model, refresh, signal, counters, priority);
      const lexical = retrieveWiki(board, context.dataDir, workspace, query, { queryGroups, limit: 40 }, index);
      const originals = url.hostname === "search" && mode === "wiki" ? undefined : searchOriginals(board, context.dataDir, workspace, query, 20, refresh, queryGroups);
      const refs = new Map<string, RetrievalRef>();
      for (const hit of lexical.hits) refs.set(refKey(hit.ref), hit.ref);
      for (const hit of originals?.hits ?? []) { const ref = { kind: "evidence" as const, id: hit.locator.evidenceId }; refs.set(refKey(ref), ref); }
      const documents = new Map(index.documents.map(doc => [refKey(doc.ref), doc]));
      const candidates = [...refs.values()].map((ref, i) => {
        return { id: `C${i}`, ref, records: closure(ref, documents), originals: (originals?.hits ?? []).filter(hit => hit.locator.evidenceId === ref.id)
          .map(hit => ({ locator: hit.locator, snippet: hit.snippet })) };
      });
      const scores = new Map<string, number>();
      // One bounded request, with complete judgments/source closures. Oversized
      // packages and candidates beyond the budget keep their lexical ordering.
      const batch: typeof candidates = [];
      const input = (items: typeof candidates) => ({ query, groups, corpusSignature: index.signature, candidates: items });
      for (const candidate of candidates) {
        if (JSON.stringify(input([candidate])).length > semanticLimits.rerankInputChars) { counters.oversizedCandidates++; continue; }
        if (batch.length >= semanticLimits.rerankCandidates || JSON.stringify(input([...batch, candidate])).length > semanticLimits.rerankInputChars) continue;
        batch.push(candidate);
      }
      counters.deferredCandidates = candidates.length - batch.length;
      if (batch.length) {
        const ranked = await memo(context, workspace, model, "rerank", input(batch), value => {
          const result = rankingSchema.parse(value), ids = new Set(batch.map(item => item.id));
          if (result.scores.length !== ids.size || new Set(result.scores.map(item => item.id)).size !== ids.size || result.scores.some(item => !ids.has(item.id))) throw new Error("Invalid ranking references");
          return result;
        }, refresh, signal, counters);
        ranked.scores.forEach(item => scores.set(item.id, item.score));
      }
      signal?.throwIfAborted();
      if (retrievalInputSignature(context.snapshot()) !== signature) return deliver({}, "sources_changed_lexical_fallback");
      // Leave unranked slots in place rather than demoting every deferred item.
      const ranked = candidates.filter(item => scores.has(item.id)).sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
      let cursor = 0;
      const ordered = candidates.map(item => scores.has(item.id) ? ranked[cursor++]! : item);
      const preferredRefs = ordered.map(item => item.ref), preferredOriginals = preferredRefs.filter(ref => ref.kind === "evidence").map(ref => ref.id);
      return deliver({ queryGroups, preferredRefs, preferredOriginals, index }, "applied");
    } catch {
      signal?.throwIfAborted();
      return deliver({}, "failed_lexical_fallback");
    }
  };
}
