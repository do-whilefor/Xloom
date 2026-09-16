import type { BoardSnapshot } from "../types.js";
import { factIndexEntries } from "../loop/history.js";
import { wikiDigest } from "./model.js";

/** Stable, paged navigation to all old clues; no source or review receipt. */
export function readHistory(board: BoardSnapshot, url: URL) {
  const p = url.searchParams, kind = p.get("kind") ?? "fact";
  if (!["fact", "attempt"].includes(kind)) throw new Error("History kind must be fact or attempt");
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = p.get(key), value = raw === null ? fallback : Number(raw);
    if (raw !== null && !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid history ${key}`);
    return value;
  };
  const offset = number("offset", 0, 0, Number.MAX_SAFE_INTEGER), limit = number("limit", 40, 1, 100), budget = number("budgetChars", 16000, 1024, 64000);
  const entries = kind === "fact" ? factIndexEntries(board) : (board.attempts ?? []).map(attempt => ({ id: attempt.id,
    hypothesis: attempt.hypothesis, scope: attempt.scope, identity: attempt.identity, stateVersion: attempt.stateVersion,
    outcome: attempt.outcome, evidenceIds: attempt.evidenceIds }));
  const signature = wikiDigest([kind, entries]);
  if (p.has("signature") && p.get("signature") !== signature || offset > 0 && !p.has("signature")) {
    return { type: "history_index", evidence: false, complete: false, status: "history_changed", nextReadPath: `xloom://history?kind=${kind}`, items: [] };
  }
  if (offset > entries.length) throw new Error("History offset exceeds available entries");
  const result = { type: "history_index", evidence: false, boardRevision: board.revision, kind, signature, offset, total: entries.length,
    complete: false, items: [] as object[], nextReadPath: undefined as string | undefined,
    notice: "Navigation only. Summaries may omit conditions; available means no recorded replacement. Read each record's full sources and original evidence. This is not review or proof." };
  for (const entry of entries.slice(offset, offset + limit)) {
    const readPath = `xloom://record?${new URLSearchParams({ kind, id: entry.id })}`;
    result.items.push({ ...entry, readPath });
    if (JSON.stringify(result).length + 400 > budget) {
      result.items.pop();
      if (!result.items.length) result.items.push({ id: entry.id, readPath, status: "read_full_record" });
      break;
    }
  }
  const next = offset + result.items.length;
  result.complete = next === entries.length;
  if (!result.complete) result.nextReadPath = `xloom://history?${new URLSearchParams({ kind, offset: String(next), limit: String(limit), budgetChars: String(budget), signature })}`;
  if (JSON.stringify(result).length > budget) return { type: "history_index", evidence: false, complete: false, status: "budget_exhausted", items: [],
    nextReadPath: `xloom://history?${new URLSearchParams({ kind, offset: String(offset), limit: String(limit), budgetChars: "64000", signature })}` };
  return result;
}
