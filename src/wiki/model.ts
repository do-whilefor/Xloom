import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoardSnapshot, Execution } from "../types.js";
import { knowledgeRecord } from "../knowledge/model.js";
import { cvssIssues, projectCvss } from "../scoring/cvss.js";
import { observationConflicts } from "../observations/changes.js";
import { hypothesisKey } from "../loop/attempts.js";
import { factBasisReviews } from "../loop/fact-basis.js";

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"), "Must not contain NUL characters");
export const wikiSourceSchema = z.object({ kind: z.enum(["goal", "step", "fact", "finding", "evidence", "attempt", "capability", "chain"]), id: text(256) }).strict();
const pageId = z.string().regex(/^WK-[a-z0-9][a-z0-9_-]{0,63}$/, "Use WK- followed by lowercase letters, digits, underscores or hyphens");
const blockId = z.string().regex(/^B-[a-z0-9][a-z0-9_-]{0,63}$/);
const metadataShape = {
  summary: z.string().trim().max(2000).refine(value => !value.includes("\0")).optional(),
  questions: z.array(text(512)).max(16).optional(),
  keywords: z.array(text(128)).max(32).optional(),
  aliases: z.array(text(128)).max(32).optional(),
};
const metadataSchema = z.object(metadataShape);
const blockRefSchema = z.object({ pageId, blockId }).strict();
const blockKey = (ref: WikiBlockRef) => JSON.stringify([ref.pageId, ref.blockId]);
const blockSchema = z.object({ id: blockId, title: text(512), text: text(16_000), ...metadataShape,
  sources: z.array(wikiSourceSchema).min(1).max(64),
  requiredBlockRefs: z.array(blockRefSchema).max(32).refine(refs => new Set(refs.map(blockKey)).size === refs.length, "Required block refs must be unique").optional(),
}).strict();
const blockMetadataSchema = z.object({ id: blockId, title: text(512).optional(), ...metadataShape }).strict()
  .refine(value => Object.keys(value).some(key => key !== "id"), "Supply block metadata to update");
export const wikiPagesSchema = z.array(z.object({
  id: pageId, title: text(512).optional(), ...metadataShape, parentPageId: pageId.nullable().optional(),
  blocks: z.array(blockSchema).min(1).max(32).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length, "Block IDs must be unique within a page").optional(),
  blockMetadata: z.array(blockMetadataSchema).min(1).max(32).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length, "Block metadata IDs must be unique").optional(),
}).strict().superRefine((page, context) => {
  if (page.blocks && (!page.title || page.blockMetadata)) context.addIssue({ code: "custom", message: "Full pages require title and cannot include blockMetadata" });
  if (!Object.keys(page).some(key => key !== "id")) context.addIssue({ code: "custom", message: "Supply a full page or metadata to update" });
})).max(16).refine(pages => new Set(pages.map(page => page.id)).size === pages.length, "Page IDs must be unique within a submission");

export type WikiSource = z.infer<typeof wikiSourceSchema>;
export type WikiPageProposal = z.infer<typeof wikiPagesSchema>[number];
export type WikiMetadata = z.infer<typeof metadataSchema>;
export type WikiBlockRef = z.infer<typeof blockRefSchema>;
export type WikiBlockProposal = z.infer<typeof blockSchema>;
export interface WikiStamp extends WikiSource { signature: string }
export type WikiBlock = WikiBlockProposal & { basis: WikiStamp[]; requiredBasis?: (WikiBlockRef & { signature: string })[] };
export interface WikiRevision extends WikiMetadata { revision: number; boardRevision: number; title: string; parentPageId?: string | null; blocks: WikiBlock[] }
export interface WikiPage extends WikiRevision { id: string; history: WikiRevision[] }
export type WikiIssue = (WikiSource | { kind: "block"; id: string; pageId: string }) & {
  reason: "source_missing" | "source_changed" | "source_review_required" | "required_block_missing" | "required_block_changed";
  via?: WikiBlockRef;
};
/** Retrieval hints are never part of a source or required-block review stamp. */
export function wikiMetadata(value: WikiMetadata): WikiMetadata {
  return Object.fromEntries(Object.keys(metadataShape).filter(key => value[key as keyof WikiMetadata] !== undefined).map(key => [key, value[key as keyof WikiMetadata]]));
}
export const wikiDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (ref: WikiSource) => JSON.stringify([ref.kind, ref.id]);
const source = (kind: WikiSource["kind"], ids: string[]): WikiSource[] => ids.map(id => ({ kind, id }));

type PublicRecord = { value: object; dependencies: WikiSource[] };
function recordScope(board: BoardSnapshot) {
  const index = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, item]));
  const replacedBy = new Map<string, string[]>(), attemptsByEvidence = new Map<string, string[]>(), attemptsByHypothesis = new Map<string, string[]>();
  const counterSteps = new Map<string, BoardSnapshot["steps"]>();
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => { const items = map.get(key) ?? []; items.push(value); map.set(key, items); };
  for (const fact of board.facts) if (fact.supersedes) add(replacedBy, fact.supersedes, fact.id);
  for (const attempt of board.attempts ?? []) {
    for (const id of new Set(attempt.evidenceIds)) add(attemptsByEvidence, id, attempt.id);
    add(attemptsByHypothesis, hypothesisKey(attempt.hypothesis), attempt.id);
  }
  for (const step of board.steps) if (step.combination?.counterEvidence?.length)
    for (const id of new Set([...step.from, ...step.combination.requires])) add(counterSteps, id, step);
  return { goals: index(board.goals), steps: index(board.steps), facts: index(board.facts), findings: index(board.findings), evidence: index(board.evidence),
    attempts: index(board.attempts ?? []), replacedBy, attemptsByEvidence, attemptsByHypothesis, counterSteps, factReviews: factBasisReviews(board),
    conflicts: observationConflicts(board), records: new Map<string, PublicRecord | undefined>(),
    blocks: wikiBlocks(board.wikiPages ?? []), issues: new Map<WikiRevision, (WikiIssue & { blockId: string })[]>() };
}
const readScopes = new WeakMap<BoardSnapshot, ReturnType<typeof recordScope>>();
/** Synchronous operation-local cache. No revision/identity cache survives a read:
 * callers may edit the same BoardSnapshot in place without changing revision. */
export function withWikiReadScope<T>(board: BoardSnapshot, read: () => T): T {
  if (readScopes.has(board)) return read();
  readScopes.set(board, recordScope(board));
  try { return read(); } finally { readScopes.delete(board); }
}

/** Explicit public records only. Runtime fields and conversation data are never
 * hashed into the author basis or copied into a Wiki page. */
export function wikiRecord(board: BoardSnapshot, ref: WikiSource): PublicRecord | undefined {
  return withWikiReadScope(board, () => {
    const scope = readScopes.get(board)!, id = key(ref);
    if (!scope.records.has(id)) scope.records.set(id, projectWikiRecord(board, ref, scope));
    return scope.records.get(id);
  });
}
function projectWikiRecord(board: BoardSnapshot, ref: WikiSource, scope: ReturnType<typeof recordScope>): PublicRecord | undefined {
  if (ref.kind === "capability" || ref.kind === "chain") return knowledgeRecord(board, ref);
  if (ref.kind === "goal") {
    const r = scope.goals.get(ref.id);
    return r && { value: { id: r.id, description: r.description, status: r.status, parentId: r.parentId, factIds: r.factIds }, dependencies: source("fact", r.factIds) };
  }
  if (ref.kind === "step") {
    const r = scope.steps.get(ref.id);
    if (!r) return;
    const combination = r.combination && { requires: r.combination.requires, missing: r.combination.missing, scope: r.combination.scope,
      stateVersion: r.combination.stateVersion, expectedCapability: r.combination.expectedCapability, counterEvidence: r.combination.counterEvidence };
    return { value: { id: r.id, goalId: r.goalId, description: r.description, status: r.status, from: r.from,
      successSignal: r.successSignal, evidencePlan: r.evidencePlan, result: r.result, combination },
    dependencies: source("fact", [...r.from, ...(r.combination?.requires ?? []), ...(r.combination?.counterEvidence ?? [])]) };
  }
  if (ref.kind === "fact") {
    const r = scope.facts.get(ref.id);
    if (!r) return;
    const replacedBy = [...scope.replacedBy.get(r.id) ?? []].sort();
    const origin = r.stepId ? scope.steps.get(r.stepId) : undefined;
    const combination = origin?.combination;
    const originConditions = origin && { from: origin.from, ...(combination ? { requires: combination.requires, missing: combination.missing,
      scope: combination.scope, stateVersion: combination.stateVersion, expectedCapability: combination.expectedCapability, counterEvidence: combination.counterEvidence } : {}) };
    const counterContexts = (scope.counterSteps.get(r.id) ?? [])
      .map(step => ({ stepId: step.id, scope: step.combination!.scope, stateVersion: step.combination!.stateVersion, counterEvidence: step.combination!.counterEvidence! }));
    const attempts = [...new Set(r.evidenceIds.flatMap(id => scope.attemptsByEvidence.get(id) ?? []))].sort();
    const conflicts = scope.conflicts;
    const basisReview = scope.factReviews.get(r.id);
    const reviewIssues = [...(replacedBy.length ? ["source_replaced"] : []), ...(basisReview ? ["basis_review_required"] : []), ...(attempts.some(id => conflicts.has(id)) ? ["observation_conflict"] : [])];
    return { value: { id: r.id, description: r.description, stepId: r.stepId, evidenceIds: r.evidenceIds, supersedes: r.supersedes, replacedBy, originConditions, counterContexts, attempts,
      ...(reviewIssues.length ? { reviewIssues } : {}), ...(basisReview ? { basisReview } : {}) },
      dependencies: [...source("evidence", r.evidenceIds), ...source("fact", [...replacedBy, ...(r.supersedes ? [r.supersedes] : []),
        ...(origin?.from ?? []), ...(combination?.requires ?? []), ...(combination?.counterEvidence ?? []), ...counterContexts.flatMap(item => item.counterEvidence)]), ...source("attempt", attempts)] };
  }
  if (ref.kind === "finding") {
    const r = scope.findings.get(ref.id);
    if (!r) return;
    const attempts = [...new Set([...(scope.attemptsByHypothesis.get(hypothesisKey(r.key)) ?? []), ...r.evidenceIds.flatMap(id => scope.attemptsByEvidence.get(id) ?? [])])].sort();
    const impact = r.impact && { capability: r.impact.capability, object: r.impact.object, result: r.impact.result, scope: r.impact.scope, prerequisites: r.impact.prerequisites };
    return { value: { id: r.id, key: r.key, title: r.title, target: r.target, status: r.status, rating: r.rating, factIds: r.factIds,
      evidenceIds: r.evidenceIds, next: r.next, review: r.review, impact, pocEvidenceId: r.pocEvidenceId, attempts,
      ...(r.observationReview ? { observationReview: r.observationReview, reviewIssues: r.observationReview.kinds } : {}),
      ...(r.cvss ? { cvss: projectCvss(r.cvss), cvssIssues: cvssIssues(board, r) } : {}) },
    dependencies: [...source("fact", r.factIds), ...source("evidence", [...r.evidenceIds, ...(r.pocEvidenceId ? [r.pocEvidenceId] : [])]), ...source("attempt", attempts)] };
  }
  if (ref.kind === "evidence") {
    const r = scope.evidence.get(ref.id);
    return r && { value: { id: r.id, stepId: r.stepId, path: r.path, pathBase: r.pathBase, sha256: r.sha256, bytes: r.bytes, description: r.description }, dependencies: [] };
  }
  const r = scope.attempts.get(ref.id);
  const conflicts = scope.conflicts.get(ref.id) ?? [];
  return r && { value: { id: r.id, stepId: r.stepId, hypothesis: r.hypothesis, scope: r.scope, identity: r.identity, stateVersion: r.stateVersion,
    baseline: r.baseline, changedVariable: r.changedVariable, outcome: r.outcome, observation: r.observation, evidenceIds: r.evidenceIds,
    ...(conflicts.length ? { conflicts, reviewIssues: ["observation_conflict"] } : {}) }, dependencies: [...source("evidence", r.evidenceIds), ...source("attempt", conflicts)] };
}

export function wikiBasis(board: BoardSnapshot, roots: WikiSource[]): WikiStamp[] {
  return withWikiReadScope(board, () => collectWikiBasis(board, roots));
}
function collectWikiBasis(board: BoardSnapshot, roots: WikiSource[]): WikiStamp[] {
  const queue = [...roots];
  const found = new Map<string, WikiStamp>();
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i]!;
    if (found.has(key(ref))) continue;
    const record = wikiRecord(board, ref);
    if (!record) throw new Error(`Unknown Wiki source: ${ref.kind} ${JSON.stringify(ref.id)}. Use committed IDs or this batch's fact/evidence refs`);
    found.set(key(ref), { kind: ref.kind, id: ref.id, signature: wikiDigest(record.value) });
    queue.push(...record.dependencies);
  }
  return [...found.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Preflight even before new batch IDs exist; Store resolves and seals the same
 * sources after committing their records in its transaction. */
export function validateWikiReferences(board: BoardSnapshot, output: Execution): void {
  const local = { fact: new Set(output.facts?.map(item => item.ref)), evidence: new Set(output.evidence?.map(item => item.ref)),
    capability: new Set(output.capabilities?.map(item => item.id)), chain: new Set(output.chains?.map(item => item.id)) };
  const errors: string[] = [];
  output.wikiPages?.forEach((page, p) => page.blocks?.forEach((block, b) => block.sources.forEach((ref, s) => {
    if ((ref.kind === "fact" || ref.kind === "evidence" || ref.kind === "capability" || ref.kind === "chain") && local[ref.kind].has(ref.id)) return;
    if (!wikiRecord(board, ref)) errors.push(`wikiPages[${p}].blocks[${b}].sources[${s}]: Unknown ${ref.kind} ${JSON.stringify(ref.id)}`);
  })));
  if (errors.length) throw new Error(`${errors.join("; ")}. Wiki sources must belong to this task. Use exact committed IDs or this batch's fact/evidence refs; omit unsupported blocks instead of inventing sources.`);
  prepareWikiPages(board, output.wikiPages ?? []);
}

type WikiDraft = WikiMetadata & { id: string; title: string; parentPageId?: string | null; blocks: WikiBlockProposal[] };
/** Validate the entire proposed graph before any page is replaced, including forward refs. */
function prepareWikiPages(board: BoardSnapshot, proposals: WikiPageProposal[]): Map<string, WikiDraft> {
  const pages = new Map<string, WikiDraft>((board.wikiPages ?? []).map(page => [page.id, page]));
  for (const proposal of proposals) {
    const previous = pages.get(proposal.id);
    if (!previous && (!proposal.blocks || !proposal.title)) throw new Error(`New Wiki page ${proposal.id} requires title and blocks; metadata updates require an existing page`);
    const patches = new Map(proposal.blockMetadata?.map(block => [block.id, block]));
    for (const id of patches.keys()) if (!previous?.blocks.some(block => block.id === id)) throw new Error(`Unknown Wiki metadata block: ${proposal.id}/${id}`);
    pages.set(proposal.id, { id: proposal.id, title: proposal.title ?? previous!.title,
      ...wikiMetadata(previous ?? {}), ...wikiMetadata(proposal),
      ...(proposal.parentPageId !== undefined ? { parentPageId: proposal.parentPageId } : previous?.parentPageId !== undefined ? { parentPageId: previous.parentPageId } : {}),
      blocks: proposal.blocks ?? previous!.blocks.map(block => ({ ...block, ...patches.get(block.id) })),
    });
  }
  const blocks = new Map([...pages.values()].flatMap(page => page.blocks.map(block => [blockKey({ pageId: page.id, blockId: block.id }), block] as const)));
  for (const page of pages.values()) if (page.parentPageId && !pages.has(page.parentPageId)) throw new Error(`Unknown Wiki parent page: ${page.parentPageId}`);
  for (const proposal of proposals) for (const block of proposal.blocks ?? []) {
    const pending = [...block.requiredBlockRefs ?? []], seen = new Set<string>();
    for (let i = 0; i < pending.length; i++) {
      const ref = pending[i]!, id = blockKey(ref), required = blocks.get(id);
      if (!required) throw new Error(`Unknown required Wiki block: ${ref.pageId}/${ref.blockId}`);
      if (!seen.has(id)) { seen.add(id); pending.push(...required.requiredBlockRefs ?? []); }
    }
  }
  // Existing dependents may outlive a removed block. Preserve them with a missing
  // dependency warning; only a newly submitted full judgment must have valid refs.
  const acyclic = (nodes: string[], edges: (id: string) => string[], name: string) => {
    const active = new Set<string>(), done = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw new Error(`Wiki ${name} cycle: ${id}`);
      if (done.has(id)) return;
      active.add(id); edges(id).forEach(visit); active.delete(id); done.add(id);
    };
    nodes.forEach(visit);
  };
  acyclic([...pages.keys()], id => pages.get(id)?.parentPageId ? [pages.get(id)!.parentPageId!] : [], "parent page");
  acyclic([...blocks.keys()], id => blocks.get(id)?.requiredBlockRefs?.map(blockKey) ?? [], "required block");
  return pages;
}

export function wikiBreadcrumb(board: BoardSnapshot, id: string): { id: string; title: string }[] {
  const pages = new Map(board.wikiPages?.map(page => [page.id, page])), path: { id: string; title: string }[] = [], seen = new Set<string>();
  let page = pages.get(id);
  while (page && !seen.has(page.id)) { seen.add(page.id); path.unshift({ id: page.id, title: page.title }); page = pages.get(page.parentPageId ?? ""); }
  return path;
}

const requiredSignature = (block: WikiBlock) => wikiDigest({ text: block.text, sources: block.sources, basis: block.basis, requiredBlockRefs: block.requiredBlockRefs ?? [] });
const wikiBlocks = (pages: WikiPage[]) => new Map(pages.flatMap(page => page.blocks.map(block => [blockKey({ pageId: page.id, blockId: block.id }), block] as const)));

export function applyWikiPages(board: BoardSnapshot, proposals: WikiPageProposal[], resolve: (ref: WikiSource) => WikiSource,
  verify: (evidenceId: string) => void): void {
  if (!proposals.length) return;
  const drafts = prepareWikiPages(board, proposals);
  const pages = [...board.wikiPages ?? []];
  const replacements = new Map<string, WikiPage>();
  for (const proposal of proposals) {
    const previous = pages.find(page => page.id === proposal.id);
    const draft = drafts.get(proposal.id)!;
    const blocks: WikiBlock[] = proposal.blocks ? proposal.blocks.map(block => {
      const sources = [...new Map(block.sources.map(ref => { const resolved = resolve(ref); return [key(resolved), resolved]; })).values()];
      const basis = wikiBasis(board, sources);
      for (const ref of basis) if (ref.kind === "evidence") verify(ref.id);
      return { id: block.id, title: block.title, text: block.text, ...wikiMetadata(block), sources, basis,
        ...(block.requiredBlockRefs?.length ? { requiredBlockRefs: block.requiredBlockRefs } : {}) };
    }) : draft.blocks as WikiBlock[]; // Metadata patches retain all sealed bases.
    const page: WikiPage = { ...draft, blocks, revision: (previous?.revision ?? 0) + 1, boardRevision: board.revision + 1, history: previous?.history ?? [] };
    replacements.set(proposal.id, page);
    if (previous) pages[pages.indexOf(previous)] = page;
    else pages.push(page);
  }
  const byBlock = wikiBlocks(pages);
  for (const proposal of proposals) if (proposal.blocks) for (const block of replacements.get(proposal.id)!.blocks) {
    const pending = [...block.requiredBlockRefs ?? []], stamps = new Map<string, WikiBlockRef & { signature: string }>();
    for (let i = 0; i < pending.length; i++) {
      const ref = pending[i]!, id = blockKey(ref);
      if (stamps.has(id)) continue;
      const dependency = byBlock.get(id);
      if (!dependency) throw new Error(`Unknown required Wiki block: ${ref.pageId}/${ref.blockId}`);
      // Referencing a required explanation verifies its source archives too,
      // but does not acknowledge its old factual review baseline.
      for (const source of wikiBasis(board, dependency.sources)) if (source.kind === "evidence") verify(source.id);
      stamps.set(id, { ...ref, signature: requiredSignature(dependency) }); pending.push(...dependency.requiredBlockRefs ?? []);
    }
    if (stamps.size) block.requiredBasis = [...stamps.values()].sort((a, b) => blockKey(a).localeCompare(blockKey(b)));
  }
  for (const [id, page] of replacements) {
    const previous = board.wikiPages?.find(item => item.id === id);
    const content = (item: WikiPage) => ({ title: item.title, ...wikiMetadata(item), parentPageId: item.parentPageId, blocks: item.blocks });
    if (previous && wikiDigest(content(previous)) === wikiDigest(content(page))) { pages[pages.indexOf(page)] = previous; continue; }
    if (previous) { const { id: _id, history, ...revision } = previous; page.history = [...history, revision]; }
  }
  board.wikiPages = pages;
}

/** Review flags describe recorded-source changes, not file integrity or whether
 * an author's interpretation is true. Re-reading alone never clears them. */
export function wikiIssues(board: BoardSnapshot, page: WikiRevision): (WikiIssue & { blockId: string })[] {
  return withWikiReadScope(board, () => {
    const cache = readScopes.get(board)!.issues;
    if (!cache.has(page)) cache.set(page, collectWikiIssues(board, page));
    return cache.get(page)!;
  });
}
/** A Fact already carries transitive applicability warnings. Its historical
 * correction records remain in the signed basis, but their old applicability
 * does not invalidate an explicit correction. Other source kinds expand to
 * their directly claimed Facts before applying this rule. */
function judgmentFactRoots(board: BoardSnapshot, sources: WikiSource[]): Set<string> {
  const queue = [...sources], seen = new Set<string>(), facts = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i]!;
    if (seen.has(key(ref))) continue;
    seen.add(key(ref));
    if (ref.kind === "fact") facts.add(ref.id);
    else queue.push(...wikiRecord(board, ref)?.dependencies ?? []);
  }
  return facts;
}
function collectWikiIssues(board: BoardSnapshot, page: WikiRevision): (WikiIssue & { blockId: string })[] {
  const issues: (WikiIssue & { blockId: string })[] = [];
  const byBlock = readScopes.get(board)!.blocks;
  for (const root of page.blocks) {
    const pending: { block: WikiBlock; via?: WikiBlockRef }[] = [{ block: root }], seen = new Set<string>();
    const found = new Map<string, WikiIssue>();
    const add = (issue: WikiIssue) => found.set(wikiDigest(issue), issue);
    for (let i = 0; i < pending.length; i++) {
      const { block, via } = pending[i]!;
      const origin = via ? { via } : {};
      const claimedFacts = judgmentFactRoots(board, block.sources);
      for (const ref of block.basis) {
        const current = wikiRecord(board, ref);
        if (!current || wikiDigest(current.value) !== ref.signature) add({ kind: ref.kind, id: ref.id, reason: current ? "source_changed" : "source_missing", ...origin });
        if (current && "reviewIssues" in current.value && Array.isArray(current.value.reviewIssues) && current.value.reviewIssues.some(code =>
          code !== "source_replaced" && (code !== "basis_review_required" || ref.kind !== "fact" || claimedFacts.has(ref.id))))
          add({ kind: ref.kind, id: ref.id, reason: "source_review_required", ...origin });
      }
      for (const ref of block.requiredBasis ?? []) {
        const current = byBlock.get(blockKey(ref));
        if (!current || requiredSignature(current) !== ref.signature) add({ kind: "block", id: ref.blockId, pageId: ref.pageId,
          reason: current ? "required_block_changed" : "required_block_missing", ...origin });
      }
      for (const ref of block.requiredBlockRefs ?? []) {
        const current = byBlock.get(blockKey(ref));
        if (!current) add({ kind: "block", id: ref.blockId, pageId: ref.pageId, reason: "required_block_missing", ...origin });
        else if (!seen.has(blockKey(ref))) { seen.add(blockKey(ref)); pending.push({ block: current, via: ref }); }
      }
    }
    issues.push(...[...found.values()].map(issue => ({ blockId: root.id, ...issue })));
  }
  return issues;
}
