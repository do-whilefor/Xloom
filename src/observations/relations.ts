import type { Attempt, BoardSnapshot, Fact, Finding } from "../types.js";
import { attemptKeys, hypothesisKey } from "../loop/attempts.js";

/** A merged Attempt keeps each producing Step paired with its own originals.
 * Older records can only attest to the origin they actually retained. */
export function attemptSources(attempt: Pick<Attempt, "sources" | "stepId" | "evidenceIds">): NonNullable<Attempt["sources"]> {
  const byStep = new Map<string, Set<string>>(), evidence = new Set(attempt.evidenceIds);
  for (const source of attempt.sources ?? [{ stepId: attempt.stepId, evidenceIds: attempt.evidenceIds }]) {
    const ids = byStep.get(source.stepId) ?? new Set<string>();
    for (const id of source.evidenceIds) if (evidence.has(id)) ids.add(id);
    if (ids.size) byStep.set(source.stepId, ids);
  }
  return [...byStep].sort(([a], [b]) => a.localeCompare(b)).map(([stepId, ids]) => ({ stepId, evidenceIds: [...ids].sort() }));
}

/** Operation-local indexes: sharing content-addressed bytes is not by itself
 * an experiment relationship. No identity/revision cache survives this call. */
export function observationRelations(board: BoardSnapshot) {
  const bySource = new Map<string, Set<string>>(), byHypothesis = new Map<string, Set<string>>(), byCondition = new Map<string, Set<string>>();
  const conditions = new Map<string, string>();
  const facts = new Map(board.facts.map(item => [item.id, item])), steps = new Map(board.steps.map(item => [item.id, item]));
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const ids = map.get(key) ?? new Set<string>(); ids.add(id); map.set(key, ids);
  };
  for (const attempt of board.attempts ?? []) {
    for (const source of attemptSources(attempt)) for (const id of source.evidenceIds) add(bySource, JSON.stringify([source.stepId, id]), attempt.id);
    add(byHypothesis, hypothesisKey(attempt.hypothesis), attempt.id);
    const condition = attemptKeys(attempt).conditionKey;
    conditions.set(attempt.id, condition); add(byCondition, condition, attempt.id);
  }
  const fact = (record: Fact): string[] => [...new Set(record.stepId
    ? record.evidenceIds.flatMap(id => [...bySource.get(JSON.stringify([record.stepId, id])) ?? []]) : [])].sort();
  const finding = (record: Pick<Finding, "key" | "factIds" | "evidenceIds">) => {
    const factIds = new Set(record.factIds), evidenceIds = new Set(record.evidenceIds);
    const attemptIds = new Set(byHypothesis.get(hypothesisKey(record.key))), pending = [...factIds];
    for (let i = 0; i < pending.length; i++) {
      const source = facts.get(pending[i]!); if (!source) continue;
      source.evidenceIds.forEach(id => evidenceIds.add(id));
      fact(source).forEach(id => attemptIds.add(id));
      const step = source.stepId ? steps.get(source.stepId) : undefined;
      for (const id of [...step?.from ?? [], ...step?.combination?.requires ?? [], ...step?.combination?.counterEvidence ?? []])
        if (!factIds.has(id)) { factIds.add(id); pending.push(id); }
    }
    // Repeated observations and counterexamples under the same declared
    // conditions remain related even when produced by another Step.
    for (const condition of new Set([...attemptIds].map(id => conditions.get(id)!)))
      for (const peer of byCondition.get(condition) ?? []) attemptIds.add(peer);
    return { factIds, evidenceIds, attemptIds };
  };
  return { fact, finding };
}
