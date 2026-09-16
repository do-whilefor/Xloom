import { terms } from "./catalog.js";

// Question scaffolding alone must not retrieve the entire corpus. Deliberately
// keep negation, HTTP codes, identifiers and Chinese terms; this is not a
// language model or an instruction to discard contrary evidence.
const weakWords = new Set("a an the is are was were be been being of to for in on at by with this that these those what which who when where how do does did can could would should please tell me about".split(" "));
export const queryTerms = (expression: string): string[] => [...new Set(terms(expression))].filter(term => !weakWords.has(term));
export const ignoredQueryTerms = (expression: string): string[] => [...new Set(terms(expression))].filter(term => weakWords.has(term));

/** Retrieval alternatives only. Separate needs remain AND prerequisites in the
 * knowledge solver; matching expressions does not establish compatibility. */
export interface QueryGroup { id: string; alternatives: string[] }
export function compileQueryGroups(query: string, groups?: QueryGroup[]) {
  if (groups === undefined) return [{ id: "query", alternatives: [{ expression: query, tokens: queryTerms(query) }] }];
  const selected = groups;
  if (!selected.length || selected.length > 9 || new Set(selected.map(group => group.id)).size !== selected.length
    || selected.some(group => !group.id || group.id.length > 64 || !group.alternatives.length || group.alternatives.length > 10
      || group.alternatives.some(value => typeof value !== "string" || value.length > 4000))
    || selected.reduce((sum, group) => sum + group.alternatives.reduce((n, value) => n + value.length, 0), 0) > 32000) throw new Error("Invalid retrieval query groups");
  return selected.map(group => ({ id: group.id, alternatives: [...new Set(group.alternatives)].map(expression => ({ expression, tokens: queryTerms(expression) })) }));
}

/** Round-robin ranked candidates reserve space for each declared need. A record
 * can appear only once; source packages are still assembled atomically later. */
export function interleaveCandidates<T>(groups: T[][], key: (value: T) => string, first: T[] = []): T[] {
  const out: T[] = [], seen = new Set<string>(), cursors = groups.map(() => 0);
  const add = (value: T) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); out.push(value); return true; };
  first.forEach(add);
  let progress = true;
  while (progress) {
    progress = false;
    groups.forEach((group, i) => {
      while (cursors[i]! < group.length) {
        const value = group[cursors[i]!]!; cursors[i] = cursors[i]! + 1;
        if (add(value)) { progress = true; break; }
      }
    });
  }
  return out;
}
