import type { BoardSnapshot } from "../types.js";
import { wikiBreadcrumb, wikiDigest, wikiIssues, wikiMetadata, wikiRecord, withWikiReadScope, type WikiMetadata, type WikiSource } from "./model.js";
import { wikiFilename, wikiGenerator } from "./format.js";

export interface RetrievalRef { kind: WikiSource["kind"] | "block"; id: string; pageId?: string }
export const refKey = (ref: RetrievalRef): string => JSON.stringify([ref.kind, ref.pageId ?? "", ref.id]);
export interface RetrievalDocument {
  ref: RetrievalRef;
  title: string;
  text: string;
  path: string;
  sources: WikiSource[];
  /** Directory membership is navigation, not an evidential dependency. */
  navigation?: WikiSource[];
  requiredBlocks?: RetrievalRef[];
  breadcrumb?: { id: string; title: string }[];
  retrievalMetadata?: { page: WikiMetadata; block: WikiMetadata };
  issues: { code: string; source: RetrievalRef; via?: { pageId: string; blockId: string } }[];
}
export interface RetrievalIndex {
  generator: typeof wikiGenerator;
  type: "retrieval_index";
  version: 1;
  evidence: false;
  boardRevision: number;
  signature: string;
  documents: RetrievalDocument[];
  lengths: number[];
  postings: Record<string, [number, number][]>;
  /** Derived model search expressions, never authoritative document content. */
  semanticHints?: Record<string, string[]>;
}

/** Unicode width, identifier components and Chinese bigrams; no embedding/model call. */
export function terms(text: string): string[] {
  const found: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(/[a-z0-9_]+(?:[-/.][a-z0-9_]+)*|[\u3400-\u9fff]+/gi)) {
    const original = match[0], token = original.toLowerCase();
    if (/^[\u3400-\u9fff]/.test(token)) {
      if (token.length === 1) found.push(token);
      else for (let i = 0; i < token.length - 1; i++) found.push(token.slice(i, i + 2));
    } else {
      found.push(token);
      if (/[-/._]/.test(token)) found.push(...token.match(/[a-z0-9]+/g) ?? []);
      const components = original.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
      if (components.length > 1) found.push(...components.flatMap(part => part.toLowerCase().match(/[a-z0-9]+/g) ?? []));
    }
  }
  return found;
}

const metadata = new Set(["id", "key", "stepId", "goalId", "parentId", "path", "pathBase", "sha256", "bytes", "status", "rating", "evidenceIds", "factIds", "from", "requires", "counterEvidence", "supersedes", "replacedBy", "attempts", "resultFactIds", "counterFactIds", "capabilityIds", "producerId", "consumerId", "revision"]);
function searchable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(searchable).join(" ");
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => !metadata.has(key)).map(([, item]) => searchable(item)).join(" ");
  return "";
}

/** Only explicit public state is projected. Author history and raw files are read on demand. */
export function retrievalDocuments(board: BoardSnapshot) {
  return withWikiReadScope(board, () => collectDocuments(board));
}
function collectDocuments(board: BoardSnapshot) {
  const documents: RetrievalDocument[] = [], fields: { title: string; body: string }[] = [];
  const collections = { goal: board.goals, step: board.steps, fact: board.facts, finding: board.findings, evidence: board.evidence, attempt: board.attempts ?? [], capability: board.capabilities ?? [], chain: board.chains ?? [] };
  for (const kind of Object.keys(collections) as WikiSource["kind"][]) for (const item of collections[kind]) {
    const ref = { kind, id: item.id }, record = wikiRecord(board, ref)!;
    const title = "title" in item ? String(item.title) : "description" in item ? String(item.description) : "hypothesis" in item ? String(item.hypothesis) : ref.id;
    const sources = [...record.dependencies];
    const navigation: WikiSource[] = [];
    if ("goalId" in item) navigation.push({ kind: "goal", id: item.goalId });
    if ("parentId" in item && item.parentId) navigation.push({ kind: "goal", id: item.parentId });
    // Content-addressed Evidence retains its first archive Step, not every
    // later experiment's causal origin. Keep that locator out of source closure.
    if ("stepId" in item && item.stepId) (kind === "evidence" ? navigation : sources).push({ kind: "step", id: item.stepId });
    const unique = [...new Map(sources.map(source => [refKey(source), source])).values()];
    documents.push({ ref, title, text: JSON.stringify(record.value), path: `pages/${wikiFilename(kind, item.id)}`, sources: unique, ...(navigation.length ? { navigation } : {}),
      issues: [...unique.filter(source => !wikiRecord(board, source)).map(source => ({ code: "source_missing", source })),
        ...navigation.filter(source => !wikiRecord(board, source)).map(source => ({ code: "navigation_missing", source })),
        ...("reviewIssues" in record.value && Array.isArray(record.value.reviewIssues) ? record.value.reviewIssues.map(code => ({ code: String(code), source: ref })) : [])] });
    fields.push({ title, body: searchable(record.value) });
  }
  for (const page of board.wikiPages ?? []) {
    const issues = wikiIssues(board, page);
    const breadcrumb = wikiBreadcrumb(board, page.id), title = breadcrumb.map(item => item.title).join(" / ");
    for (const block of page.blocks) {
      const sources = block.sources.map(({ kind, id }) => ({ kind, id }));
      const hints = { page: wikiMetadata(page), block: wikiMetadata(block) };
      const requiredBlocks = [...new Map([...block.requiredBlockRefs ?? [], ...block.requiredBasis ?? []]
        .map(ref => { const value = { kind: "block" as const, pageId: ref.pageId, id: ref.blockId }; return [refKey(value), value]; })).values()];
      documents.push({ ref: { kind: "block", pageId: page.id, id: block.id }, title: `${title} / ${block.title}`, text: block.text,
        path: `pages/${wikiFilename("note", page.id)}`, sources,
        ...(breadcrumb.length > 1 ? { breadcrumb } : {}),
        ...(Object.keys(hints.page).length || Object.keys(hints.block).length ? { retrievalMetadata: hints } : {}),
        ...(requiredBlocks.length ? { requiredBlocks } : {}),
        issues: [
          ...issues.filter(issue => issue.blockId === block.id).map(issue => ({ code: issue.reason,
            source: { kind: issue.kind, id: issue.id, ...(issue.kind === "block" ? { pageId: issue.pageId } : {}) }, ...(issue.via ? { via: issue.via } : {}) })),
          ...sources.filter(source => !wikiRecord(board, source)).map(source => ({ code: "source_missing", source })),
        ] });
      fields.push({ title: `${title} ${block.title}`, body: `${block.text}${searchable(hints) ? ` ${searchable(hints)}` : ""}` });
    }
  }
  return { documents, fields };
}

export function buildRetrievalIndex(board: BoardSnapshot): RetrievalIndex {
  const { documents, fields } = retrievalDocuments(board);
  const postings: RetrievalIndex["postings"] = Object.create(null), lengths: number[] = [];
  fields.forEach((field, index) => {
    const counts = new Map<string, number>();
    for (const [text, weight] of [[field.title, 3], [field.body, 1]] as const) for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + weight);
    lengths.push([...counts.values()].reduce((sum, value) => sum + value, 0));
    for (const [term, count] of counts) (postings[term] ??= []).push([index, count]);
  });
  return { generator: wikiGenerator, type: "retrieval_index", version: 1, evidence: false, boardRevision: board.revision,
    signature: wikiDigest(documents), documents, lengths, postings };
}

/** Organization is a reference view, never a merge, deletion or author acknowledgement. */
export function organizeWiki(board: BoardSnapshot, index = buildRetrievalIndex(board)) {
  const blocks = index.documents.filter(doc => doc.ref.kind === "block");
  const duplicateGroups = new Map<string, RetrievalRef[]>();
  for (const block of blocks) {
    // Exact full judgments only: negation, conditions and whitespace are preserved.
    const signature = wikiDigest(block.text);
    const group = duplicateGroups.get(signature) ?? [];
    group.push(block.ref); duplicateGroups.set(signature, group);
  }
  const usedEvidence = new Set(index.documents.flatMap(doc => doc.sources.filter(ref => ref.kind === "evidence").map(ref => ref.id)));
  const readPath = (ref: RetrievalRef) => `xloom://record?${new URLSearchParams({ kind: ref.kind, id: ref.id, ...(ref.pageId ? { page: ref.pageId } : {}) })}`;
  const connectedPages = new Set((board.wikiPages ?? []).flatMap(page => [
    ...(page.parentPageId ? [page.id, page.parentPageId] : []),
    ...page.blocks.flatMap(block => (block.requiredBlockRefs ?? []).flatMap(ref => [page.id, ref.pageId])),
  ]));
  const maintenance: { code: string; ref: RetrievalRef; readPath: string; action: string; relatedReadPaths?: string[] }[] = [];
  for (const block of blocks) {
    const hints = [block.retrievalMetadata?.page, block.retrievalMetadata?.block];
    const usefulHints = hints.some(hint => hint && (hint.summary?.trim() || hint.questions?.length || hint.keywords?.length || hint.aliases?.length));
    const add = (code: string, action: string, relatedReadPaths?: string[]) => maintenance.push({ code, ref: block.ref, readPath: readPath(block.ref), action, ...(relatedReadPaths ? { relatedReadPaths } : {}) });
    if (!usefulHints) add("missing_retrieval_hints", "Consider metadata-only summary/questions for the actual object, identity and version; keep qualifications in the original judgment. Hints are optional, not missing evidence.");
    else if (!hints.some(hint => hint?.questions?.length)) add("missing_questions", "Consider an actual question this judgment helps investigate; a question must not be rewritten as an established answer.");
    if (block.text.length > 8000) add("large_judgment", "Review readability of this long block. Split only independent judgments; retain qualifications and explicit requiredBlockRefs when explanations depend on each other.");
    const duplicates = duplicateGroups.get(wikiDigest(block.text))!;
    if (duplicates.length > 1) add("duplicate_judgment", "Read source and condition differences before deciding whether to consolidate; identical text alone does not justify merging.", duplicates.filter(ref => refKey(ref) !== refKey(block.ref)).map(readPath));
  }
  if ((board.wikiPages?.length ?? 0) > 1) for (const page of board.wikiPages ?? []) {
    if (connectedPages.has(page.id) || !page.blocks.length) continue;
    const ref = { kind: "block" as const, pageId: page.id, id: page.blocks[0]!.id };
    maintenance.push({ code: "unlinked_page", ref, readPath: readPath(ref), action: "This root page has no explicit directory or required-block connections. It may intentionally stand alone; consider navigation only if there is a real relationship." });
  }
  return { generator: wikiGenerator, type: "organization", evidence: false, boardRevision: board.revision,
    notice: "Derived navigation and review suggestions, not evidence or a verdict. Source equality does not verify original files. No records were merged, deleted or marked reviewed.",
    counts: { records: index.documents.length - blocks.length, pages: board.wikiPages?.length ?? 0, blocks: blocks.length },
    reviewRequired: index.documents.filter(doc => doc.issues.length).map(doc => ({ ref: doc.ref, path: doc.path, issues: doc.issues })),
    missingSources: index.documents.flatMap(doc => doc.issues.filter(issue => ["source_missing", "required_block_missing"].includes(issue.code)).map(issue => ({ ref: doc.ref, source: issue.source }))),
    missingNavigation: index.documents.flatMap(doc => doc.issues.filter(issue => issue.code === "navigation_missing").map(issue => ({ ref: doc.ref, source: issue.source }))),
    supersededFacts: board.facts.filter(fact => board.facts.some(other => other.supersedes === fact.id)).map(fact => ({ id: fact.id,
      replacedBy: board.facts.filter(other => other.supersedes === fact.id).map(other => other.id) })),
    duplicateText: [...duplicateGroups.values()].filter(group => group.length > 1).map(refs => ({ refs, action: "Review source and condition differences; identical text does not establish identical applicability." })),
    maintenance, maintenancePolicy: { optional: true, largeJudgmentChars: 8000, notice: "Author navigation only. No missing-evidence, semantic-duplication or review verdict; metadata-only edits preserve factual review bases." },
    unreferencedEvidenceIds: board.evidence.filter(item => !usedEvidence.has(item.id)).map(item => item.id),
    topics: board.wikiPages?.map(page => ({ id: page.id, title: page.title, path: `pages/${wikiFilename("note", page.id)}`,
      parentPageId: page.parentPageId ?? null, breadcrumb: wikiBreadcrumb(board, page.id), retrievalMetadata: wikiMetadata(page),
      blocks: page.blocks.map(block => ({ id: block.id, title: block.title, retrievalMetadata: wikiMetadata(block), requiredBlockRefs: block.requiredBlockRefs ?? [],
        sources: block.sources.map(({ kind, id }) => ({ kind, id })) })) })) ?? [],
  };
}

export const retrievalSearchText = (doc: RetrievalDocument): string => `${doc.title} ${doc.text} ${searchable(doc.retrievalMetadata)}`;
