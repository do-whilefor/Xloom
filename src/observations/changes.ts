import type { Attempt, BoardSnapshot, OuterLoopTrigger } from "../types.js";
import { attemptKeys } from "../loop/attempts.js";
import { attemptSources, observationRelations } from "./relations.js";
import { changedPaths } from "./compare.js";

export interface ObservationChange {
  kind: "new_observation" | "observation_conflict" | "source_changed";
  attemptIds: string[];
  factIds: string[];
  evidenceIds: string[];
}
const unique = (ids: string[]) => [...new Set(ids)].sort();
const different = (a: unknown, b: unknown) => changedPaths(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))).length > 0;
const signatures = (board: BoardSnapshot) => {
  const byId = new Map(board.evidence.map(item => [item.id, item]));
  return (ids: string[]) => unique(ids).map(id => {
    const item = byId.get(id);
    return item ? [id, item.sha256, item.bytes, item.pathBase ?? "workspace", item.path] : [id, "missing"];
  });
};
function conflictGroups(board: BoardSnapshot) {
  const groups = new Map<string, { supports: string[]; refutes: string[] }>();
  for (const attempt of board.attempts ?? []) {
    if (attempt.outcome !== "supports" && attempt.outcome !== "refutes") continue;
    const key = attemptKeys(attempt).conditionKey, group = groups.get(key) ?? { supports: [], refutes: [] };
    group[attempt.outcome].push(attempt.id); groups.set(key, group);
  }
  return groups;
}
export function observationConflicts(board: BoardSnapshot): Map<string, string[]> {
  const groups = conflictGroups(board), result = new Map<string, string[]>();
  for (const group of groups.values()) if (group.supports.length && group.refutes.length) {
    for (const id of group.supports) result.set(id, group.refutes);
    for (const id of group.refutes) result.set(id, group.supports);
  }
  return result;
}

/** Delta of explicit observations, never inferred contradictions in free text.
 * New source bytes are review material, not proof of a new experiment. */
export function observationChanges(before: BoardSnapshot, after: BoardSnapshot): ObservationChange[] {
  const changes: ObservationChange[] = [];
  const priorAttempts = new Map(before.attempts?.map(item => [item.id, item]));
  const priorFacts = new Map(before.facts.map(item => [item.id, item]));
  const priorSources = signatures(before), currentSources = signatures(after);
  const conflicts = conflictGroups(after), oldConflicts = conflictGroups(before);
  const add = (kind: ObservationChange["kind"], attempts: Attempt[], factIds: string[] = [], evidenceIds: string[] = []) => changes.push({ kind,
    attemptIds: unique(attempts.map(item => item.id)), factIds: unique(factIds), evidenceIds: unique([...evidenceIds, ...attempts.flatMap(item => item.evidenceIds)]) });
  const byAttempt = new Map(after.attempts?.map(item => [item.id, item]));
  for (const attempt of after.attempts ?? []) {
    const previous = priorAttempts.get(attempt.id);
    if (!previous || different([attemptKeys(previous), previous.observation], [attemptKeys(attempt), attempt.observation])) add("new_observation", [attempt]);
    if (previous && different([priorSources(previous.evidenceIds), attemptSources(previous)],
      [currentSources(attempt.evidenceIds), attemptSources(attempt)])) add("source_changed", [attempt]);
  }
  // Compare each condition group once, not every historical pair on each commit.
  for (const [key, group] of conflicts) if (group.supports.length && group.refutes.length) {
    const old = oldConflicts.get(key);
    if (!old || different([unique(old.supports), unique(old.refutes)], [unique(group.supports), unique(group.refutes)]))
      add("observation_conflict", [...group.supports, ...group.refutes].map(id => byAttempt.get(id)!));
  }
  for (const fact of after.facts) {
    const previous = priorFacts.get(fact.id);
    if (!previous && fact.evidenceIds.length) add(fact.supersedes ? "source_changed" : "new_observation", [], [fact.id, ...fact.supersedes ? [fact.supersedes] : []], fact.evidenceIds);
    else if (previous && different([previous.description, previous.stepId, previous.supersedes ?? null, priorSources(previous.evidenceIds)],
      [fact.description, fact.stepId, fact.supersedes ?? null, currentSources(fact.evidenceIds)])) add("source_changed", [], [fact.id], fact.evidenceIds);
  }
  for (const attempt of before.attempts ?? []) if (!byAttempt.has(attempt.id)) add("source_changed", [attempt]);
  const facts = new Set(after.facts.map(item => item.id));
  for (const fact of before.facts) if (!facts.has(fact.id)) add("source_changed", [], [fact.id], fact.evidenceIds);
  for (const evidence of before.evidence) if (different(priorSources([evidence.id]), currentSources([evidence.id]))
    && !changes.some(change => change.kind === "source_changed" && change.evidenceIds.includes(evidence.id))) add("source_changed", [], [], [evidence.id]);
  return changes;
}

export function observationReviewReason(changes: ObservationChange[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  const ids = unique(changes.flatMap(item => [...item.attemptIds, ...item.factIds, ...item.evidenceIds]));
  return `Review observations (${[...counts].map(([kind, n]) => `${kind}: ${n}`).join(", ")}): ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? `; ${ids.length - 8} more` : ""}. Read current sources and compare conditions; differences are not verdicts.`;
}

export function observationReviewTrigger(before: BoardSnapshot, after: BoardSnapshot): OuterLoopTrigger | undefined {
  const changes = observationChanges(before, after).filter(change => change.kind !== "new_observation" || change.attemptIds.length);
  return changes.length ? { kind: "observation_change", reason: observationReviewReason(changes) } : undefined;
}

/** Invalidate only an existing Finding review whose explicit support/hypothesis
 * is affected. Candidate sources are not silently attached as Finding evidence. */
export function invalidateObservationReviews(before: BoardSnapshot, board: BoardSnapshot): void {
  const changes = observationChanges(before, board);
  const prior = observationRelations(before), current = observationRelations(board);
  const priorFindings = new Map(before.findings.map(item => [item.id, item]));
  const priorSources = signatures(before), currentSources = signatures(board);
  // A change event may contain unchanged shared bytes alongside new sources.
  // Only a delta of the Evidence record itself can invalidate by Evidence ID.
  const changedEvidence = before.evidence.filter(item => different(priorSources([item.id]), currentSources([item.id]))).map(item => item.id);
  for (const finding of board.findings) {
    if (!finding.review && !finding.observationReview) continue;
    const old = prior.finding(priorFindings.get(finding.id) ?? finding), next = current.finding(finding);
    const affected = changes.filter(change => change.factIds.some(id => old.factIds.has(id) || next.factIds.has(id))
      || change.attemptIds.some(id => old.attemptIds.has(id) || next.attemptIds.has(id)));
    const evidenceIds = changedEvidence.filter(id => old.evidenceIds.has(id) || next.evidenceIds.has(id));
    if (evidenceIds.length) affected.push({ kind: "source_changed", attemptIds: [], factIds: [], evidenceIds });
    if (affected.length) finding.observationReview = { kinds: unique([...finding.observationReview?.kinds ?? [], ...affected.map(item => item.kind)]) as ObservationChange["kind"][],
      attemptIds: unique([...finding.observationReview?.attemptIds ?? [], ...affected.flatMap(item => item.attemptIds)]),
      factIds: unique([...finding.observationReview?.factIds ?? [], ...affected.flatMap(item => item.factIds)]),
      evidenceIds: unique([...finding.observationReview?.evidenceIds ?? [], ...affected.flatMap(item => item.evidenceIds)]) };
  }
}
