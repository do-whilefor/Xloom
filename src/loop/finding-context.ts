import { evidencePath } from "../paths.js";
import { cvssIssues } from "../scoring/cvss.js";
import { observationRelations } from "../observations/relations.js";
import type { Attempt, BoardSnapshot, Evidence, Fact, Finding, Step } from "../types.js";
import type { BlackboardContext, ContextAttempt, FactIndexEntry } from "./context.js";
import { hypothesisKey } from "./attempts.js";

interface Relation {
  kind: "shared_finding" | "source_step" | "referencing_step";
  id: string;
  via: { factId: string } | { evidenceId: string };
  candidateFactIds: string[];
  candidateEvidenceIds: string[];
  omittedFacts?: number;
  omittedEvidence?: number;
}
interface FindingView {
  findingId: string;
  reviewEvidence?: { attachedIds: string[]; recordedPocId?: string };
  cvssIssues?: string[];
  related: Relation[];
  revisions: { previous: string; replacement: string }[];
  conditions: { stepId: string; scope: string; stateVersion: string; missing: string[]; declaredCounterEvidence: string[] }[];
  attempts: { id: string; via: "hypothesis_key" | "linked_fact" }[];
  issues: { kind: "missing_fact" | "missing_evidence" | "missing_step" | "poc_not_linked"; id: string }[];
  unrecorded: string[];
  omitted?: { related: number; conditions: number; attempts: number };
}
export interface FindingContext {
  notice: string;
  items: FindingView[];
  /** Supplemental indexes only; do not repeat records already in the role view. */
  facts: FactIndexEntry[];
  evidence: Pick<Evidence, "id" | "path" | "sha256" | "bytes">[];
  attempts: ContextAttempt[];
}

const limit = 4;
const candidateLimit = 6;
const compact = (text: string, size = 240) => text.length > size ? `${text.slice(0, size)}…` : text;
const unique = (ids: string[]) => [...new Set(ids)];

/** Navigation over committed references, never evidence matching by title or a
 * second source of truth. Only Findings selected by the role projector get views. */
export function projectFindingContext(board: BoardSnapshot, context: BlackboardContext, dataDir: string, workspace: string): FindingContext | undefined {
  if (!context.findings.length) return undefined;
  const facts = new Map(board.facts.map(fact => [fact.id, fact]));
  const evidence = new Map(board.evidence.map(item => [item.id, item]));
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const observations = observationRelations(board);
  const replacements = new Map<string, Fact[]>();
  const factsByStep = new Map<string, Fact[]>();
  const evidenceByStep = new Map<string, Evidence[]>();
  const findingsByFact = new Map<string, Finding[]>();
  const findingsByEvidence = new Map<string, Finding[]>();
  const stepsByInput = new Map<string, Step[]>();
  const add = <T>(index: Map<string, T[]>, id: string, item: T) => {
    const items = index.get(id) ?? [];
    items.push(item); index.set(id, items);
  };
  for (const fact of board.facts) {
    if (fact.supersedes) add(replacements, fact.supersedes, fact);
    if (fact.stepId) add(factsByStep, fact.stepId, fact);
  }
  for (const item of board.evidence) add(evidenceByStep, item.stepId, item);
  for (const finding of board.findings) {
    for (const id of finding.factIds) add(findingsByFact, id, finding);
    for (const id of finding.evidenceIds) add(findingsByEvidence, id, finding);
  }
  for (const step of board.steps) for (const id of unique([
    ...step.from, ...(step.combination?.requires ?? []), ...(step.combination?.counterEvidence ?? []),
  ])) add(stepsByInput, id, step);

  const visibleFacts = new Set([...context.facts, ...context.factIndex].map(fact => fact.id));
  const visibleEvidence = new Set(context.evidence.map(item => item.id));
  const visibleAttempts = new Set(context.attempts.map(attempt => attempt.id));
  const extraFacts = new Map<string, FactIndexEntry>();
  const extraEvidence = new Map<string, FindingContext["evidence"][number]>();
  const extraAttempts = new Map<string, ContextAttempt>();

  const items = context.findings.map(finding => {
    const view: FindingView = { findingId: finding.id, related: [], revisions: [], conditions: [], attempts: [], issues: [], unrecorded: [] };
    if (context.projection.mode !== "execute") view.reviewEvidence = {
      attachedIds: unique(finding.evidenceIds).filter(id => evidence.has(id)),
      ...(finding.pocEvidenceId && finding.evidenceIds.includes(finding.pocEvidenceId) && evidence.has(finding.pocEvidenceId) ? { recordedPocId: finding.pocEvidenceId } : {}),
    };
    if (finding.cvss) view.cvssIssues = cvssIssues(board, finding);
    const issue = (kind: FindingView["issues"][number]["kind"], id: string) => {
      if (!view.issues.some(item => item.kind === kind && item.id === id)) view.issues.push({ kind, id });
    };
    const locateEvidence = (id: string) => {
      const item = evidence.get(id);
      if (!item) { issue("missing_evidence", id); return; }
      if (!steps.has(item.stepId)) issue("missing_step", item.stepId);
      if (!visibleEvidence.has(id) && !extraEvidence.has(id)) extraEvidence.set(id, {
        id, path: evidencePath(item, dataDir, workspace), sha256: item.sha256, bytes: item.bytes,
      });
    };
    const locateFact = (id: string) => {
      const fact = facts.get(id);
      if (!fact) { issue("missing_fact", id); return; }
      if (fact.stepId && !steps.has(fact.stepId)) issue("missing_step", fact.stepId);
      if (!visibleFacts.has(id) && !extraFacts.has(id)) extraFacts.set(id, {
        id, summary: compact(fact.description), stepId: fact.stepId, evidenceIds: [...fact.evidenceIds],
        ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
        replacedBy: (replacements.get(id) ?? []).map(item => item.id), status: replacements.has(id) ? "superseded" : "available",
      });
      for (const evidenceId of fact.evidenceIds) locateEvidence(evidenceId);
    };
    const linkedFacts = new Set(finding.factIds);
    const linkedEvidence = new Set(finding.evidenceIds);
    const sourceSteps = new Map<string, Relation["via"]>();
    for (const id of linkedFacts) {
      locateFact(id);
      const source = facts.get(id)?.stepId;
      if (source) sourceSteps.set(source, { factId: id });
    }
    for (const id of linkedEvidence) {
      locateEvidence(id);
      const source = evidence.get(id)?.stepId;
      if (source) sourceSteps.set(source, { evidenceId: id });
    }
    if (finding.pocEvidenceId) {
      locateEvidence(finding.pocEvidenceId);
      if (!linkedEvidence.has(finding.pocEvidenceId)) issue("poc_not_linked", finding.pocEvidenceId);
    } else view.unrecorded.push("pocEvidenceId");

    // Preserve both directions of recorded revisions, including distant changes
    // and cycles. A replacement is not automatically a refutation or current PoC.
    const queue = [...linkedFacts];
    const visited = new Set<string>();
    const edges = new Set<string>();
    const revision = (previous: string, replacement: string) => {
      const key = JSON.stringify([previous, replacement]);
      if (!edges.has(key)) { edges.add(key); view.revisions.push({ previous, replacement }); }
      queue.push(previous, replacement);
    };
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]!;
      if (visited.has(id)) continue;
      visited.add(id); locateFact(id);
      const fact = facts.get(id);
      if (fact?.supersedes) revision(fact.supersedes, id);
      for (const replacement of replacements.get(id) ?? []) revision(id, replacement.id);
    }

    const relations = new Map<string, Relation>();
    const related = (kind: Relation["kind"], id: string, via: Relation["via"], factIds: string[], evidenceIds: string[]) => {
      const candidateFacts = unique(factIds).filter(ref => !linkedFacts.has(ref));
      const candidateEvidence = unique(evidenceIds).filter(ref => !linkedEvidence.has(ref));
      if (!candidateFacts.length && !candidateEvidence.length) return;
      relations.set(`${kind}:${id}`, { kind, id, via, candidateFactIds: candidateFacts.slice(0, candidateLimit), candidateEvidenceIds: candidateEvidence.slice(0, candidateLimit),
        ...(candidateFacts.length > candidateLimit ? { omittedFacts: candidateFacts.length - candidateLimit } : {}),
        ...(candidateEvidence.length > candidateLimit ? { omittedEvidence: candidateEvidence.length - candidateLimit } : {}),
      });
    };
    const peers = new Map<string, { finding: Finding; via: Relation["via"] }>();
    for (const id of linkedEvidence) for (const peer of findingsByEvidence.get(id) ?? []) peers.set(peer.id, { finding: peer, via: { evidenceId: id } });
    for (const id of linkedFacts) for (const peer of findingsByFact.get(id) ?? []) peers.set(peer.id, { finding: peer, via: { factId: id } });
    for (const { finding: peer, via } of [...peers.values()].reverse()) if (peer.id !== finding.id) {
      related("shared_finding", peer.id, via, peer.factIds, peer.evidenceIds);
    }
    const referencingSteps = new Map<string, Relation["via"]>();
    for (const id of linkedFacts) for (const step of stepsByInput.get(id) ?? []) referencingSteps.set(step.id, { factId: id });
    const stepOutputs = (kind: Relation["kind"], id: string, via: Relation["via"]) => related(kind, id, via,
      (factsByStep.get(id) ?? []).map(fact => fact.id), (evidenceByStep.get(id) ?? []).map(item => item.id));
    for (const [id, via] of [...referencingSteps].reverse()) stepOutputs("referencing_step", id, via);
    for (const [id, via] of sourceSteps) if (!referencingSteps.has(id)) stepOutputs("source_step", id, via);
    view.related = [...relations.values()].slice(0, limit);
    for (const relation of view.related) {
      relation.candidateFactIds.forEach(locateFact);
      relation.candidateEvidenceIds.forEach(locateEvidence);
    }

    const conditionSteps = unique([...sourceSteps.keys(), ...[...referencingSteps.keys()].reverse()]);
    let conditionCount = 0;
    for (const id of conditionSteps) {
      const step = steps.get(id);
      if (!step) { issue("missing_step", id); continue; }
      if (!step.combination) continue;
      conditionCount++;
      if (view.conditions.length === limit) continue;
      const combination = step.combination;
      view.conditions.push({ stepId: id, scope: combination.scope, stateVersion: combination.stateVersion,
        missing: [...combination.missing], declaredCounterEvidence: [...(combination.counterEvidence ?? [])] });
      combination.counterEvidence?.forEach(locateFact);
    }
    if (!conditionCount) view.unrecorded.push("combination_conditions");

    const attemptIds = observations.finding(finding).attemptIds;
    const matchingAttempts = (board.attempts ?? []).filter(attempt => attemptIds.has(attempt.id));
    for (const attempt of matchingAttempts.slice(-limit).reverse()) {
      view.attempts.push({ id: attempt.id, via: hypothesisKey(attempt.hypothesis) === hypothesisKey(finding.key) ? "hypothesis_key" : "linked_fact" });
      attempt.evidenceIds.forEach(locateEvidence);
      if (!visibleAttempts.has(attempt.id) && !extraAttempts.has(attempt.id)) extraAttempts.set(attempt.id, attemptView(attempt));
    }
    if (!matchingAttempts.length) view.unrecorded.push("structured_attempts");
    const omitted = { related: Math.max(0, relations.size - limit), conditions: Math.max(0, conditionCount - limit), attempts: Math.max(0, matchingAttempts.length - limit) };
    if (Object.values(omitted).some(count => count > 0)) view.omitted = omitted;
    return view;
  });
  return {
    notice: "Navigation only. Linked Facts/Evidence/PoC remain in findings; candidates cannot be used as linked PoC. Use existing indexes plus these supplements to read originals; files are not revalidated here. Relations, declared counterevidence and attempts need scope/identity/state review. unrecorded/omitted do not mean absent or disproved; inspect blackboardFile for omitted records. Revisions do not relink evidence or settle impact.",
    items, facts: [...extraFacts.values()], evidence: [...extraEvidence.values()], attempts: [...extraAttempts.values()],
  };
}

function attemptView(attempt: Attempt): ContextAttempt {
  return { id: attempt.id, stepId: attempt.stepId, hypothesis: compact(attempt.hypothesis), scope: attempt.scope,
    identity: attempt.identity, stateVersion: attempt.stateVersion, baseline: compact(attempt.baseline),
    changedVariable: compact(attempt.changedVariable), outcome: attempt.outcome, observation: compact(attempt.observation, 500), evidenceIds: [...attempt.evidenceIds] };
}

/** Complete reference fallback in the existing readable projection. This does
 * not include runtime locks, transcripts, credentials or derived judgments. */
export function evidenceNavigationRecords(board: BoardSnapshot): object[] {
  return [
    ...board.findings.map(finding => ({ kind: "finding", id: finding.id, key: finding.key,
      factIds: [...finding.factIds], evidenceIds: [...finding.evidenceIds], pocEvidenceId: finding.pocEvidenceId })),
    ...board.facts.map(fact => ({ kind: "fact", id: fact.id, stepId: fact.stepId,
      evidenceIds: [...fact.evidenceIds], supersedes: fact.supersedes })),
    ...board.steps.map(step => ({ kind: "step", id: step.id, from: [...step.from],
      ...(step.combination ? { combination: {
        requires: [...step.combination.requires], scope: step.combination.scope, stateVersion: step.combination.stateVersion,
        missing: [...step.combination.missing], counterEvidence: [...(step.combination.counterEvidence ?? [])],
        expectedCapability: step.combination.expectedCapability,
      } } : {}),
    })),
  ];
}
