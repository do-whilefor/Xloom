import type { BoardSnapshot } from "../types.js";
import type { FactIndexEntry } from "./context.js";

export function factIndexEntries(board: BoardSnapshot): FactIndexEntry[] {
  const replacements = new Map<string, string[]>();
  for (const fact of board.facts) if (fact.supersedes) {
    const ids = replacements.get(fact.supersedes) ?? []; ids.push(fact.id); replacements.set(fact.supersedes, ids);
  }
  return board.facts.map(fact => ({ id: fact.id, summary: fact.description.length > 240 ? `${fact.description.slice(0, 240)}…` : fact.description,
    stepId: fact.stepId, evidenceIds: [...fact.evidenceIds], ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
    replacedBy: replacements.get(fact.id) ?? [], status: replacements.has(fact.id) ? "superseded" : "available" }));
}

/** Bound navigation only. Required source records still travel in facts/evidence. */
export function boundedFactIndex(board: BoardSnapshot, selected: Set<string>, execute: boolean, budgetChars = 16000) {
  const entries = factIndexEntries(board).filter(item => !execute || selected.has(item.id));
  const chosen = new Set<string>(); let used = 2;
  for (const item of [...entries].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))) {
    const cost = JSON.stringify(item).length + (chosen.size ? 1 : 0);
    if (used + cost > budgetChars) continue;
    chosen.add(item.id); used += cost;
  }
  return { entries: entries.filter(item => chosen.has(item.id)), omitted: entries.length - chosen.size };
}
