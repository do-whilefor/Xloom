import type { BoardSnapshot, Fact, Step } from "../types.js";

export const factInputs = (step: Step): string[] => [...step.from, ...step.combination?.requires ?? [], ...step.combination?.counterEvidence ?? []];

/** A correction can inspect the superseded observation without depending on its
 * continued applicability. Other prerequisites still require review. */
export function causalFactInputs(fact: Fact, facts: Map<string, Fact>, steps: Map<string, Step>): string[] {
  const corrected = new Set<string>();
  let prior = fact.supersedes;
  while (prior && !corrected.has(prior)) { corrected.add(prior); prior = facts.get(prior)?.supersedes; }
  const origin = fact.stepId ? steps.get(fact.stepId) : undefined;
  return origin ? [...new Set(factInputs(origin))].filter(id => !corrected.has(id)) : [];
}

export interface FactBasisReview { staleFactIds: string[]; replacementFactIds: string[]; missingFactIds: string[] }

/** Derived applicability only, never a rewrite of historical observations.
 * Propagate each affected prerequisite through reverse edges once, including cycles. */
export function factBasisReviews(board: BoardSnapshot): Map<string, FactBasisReview> {
  const facts = new Map(board.facts.map(fact => [fact.id, fact])), steps = new Map(board.steps.map(step => [step.id, step]));
  const dependents = new Map<string, Set<string>>(), replacements = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const entries = map.get(key) ?? new Set<string>(); entries.add(value); map.set(key, entries);
  };
  for (const fact of board.facts) {
    if (fact.supersedes) add(replacements, fact.supersedes, fact.id);
    for (const input of causalFactInputs(fact, facts, steps)) add(dependents, input, fact.id);
  }
  const affected = new Map<string, Set<string>>();
  for (const input of dependents.keys()) {
    if (!replacements.has(input) && facts.has(input)) continue;
    const queue = [...dependents.get(input)!], visited = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      if (visited.has(id)) continue;
      visited.add(id); add(affected, id, input); queue.push(...dependents.get(id) ?? []);
    }
  }
  const result = new Map<string, FactBasisReview>();
  for (const [id, inputs] of affected) {
    const staleFactIds = [...inputs].filter(input => replacements.has(input)).sort();
    const replacementFactIds = new Set<string>(), queue = staleFactIds.flatMap(input => [...replacements.get(input)!]);
    for (let i = 0; i < queue.length; i++) {
      const replacement = queue[i]!;
      if (replacementFactIds.has(replacement)) continue;
      replacementFactIds.add(replacement); queue.push(...replacements.get(replacement) ?? []);
    }
    result.set(id, { staleFactIds, replacementFactIds: [...replacementFactIds].sort(), missingFactIds: [...inputs].filter(input => !facts.has(input)).sort() });
  }
  return result;
}
