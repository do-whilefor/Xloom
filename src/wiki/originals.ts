import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BoardSnapshot, Evidence } from "../types.js";
import { evidencePath } from "../paths.js";
import { terms } from "./catalog.js";
import { wikiGenerator } from "./format.js";
import { cachedEntry, pruneEntries, putEntry, removeEntry, withIndexCache } from "./cache.js";
import { wikiDigest } from "./model.js";
import { compileQueryGroups, interleaveCandidates, type QueryGroup } from "./search-groups.js";

const fingerprint = (s: Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
const inside = (root: string, file: string) => { const r = relative(root, file); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface OriginalLocator { evidenceId: string; sha256: string; byteOffset: number; byteLength: number }
export type OriginalReadRequest = Omit<OriginalLocator, "byteLength"> & { byteLength?: number; contextBytes?: number };
export function originalReadPath(locator: OriginalReadRequest): string {
  return `xloom://original?${new URLSearchParams(Object.entries(locator).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;
}

function archivePath(evidence: Evidence, dataDir: string, workspace: string): string {
  const root = join(dataDir, "evidence"), file = evidencePath(evidence, dataDir, workspace);
  if (lstatSync(root).isSymbolicLink() || !inside(root, file) || !inside(realpathSync(root), realpathSync(file))) throw new Error("Evidence escaped its task archive");
  let parent = root;
  for (const part of relative(root, file).split(sep)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink()) throw new Error("Evidence archive links are not supported");
  }
  return file;
}

/** Full streamed SHA/size/UTF-8 verification. Windows overlap at UTF-8 boundaries;
 * limits bound retained results, never silently cut the source corpus. */
function scan(evidence: Evidence, dataDir: string, workspace: string, window: (text: string, offset: number) => void,
  bytes?: (chunk: Buffer, offset: number) => void) {
  const file = archivePath(evidence, dataDir, workspace), fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Evidence must be a regular file");
    const checksum = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let total = 0, decodedBytes = 0, tail: Buffer = Buffer.alloc(0), textValid = true, count: number;
    const deliver = (text: string) => {
      const current = Buffer.from(text, "utf8"), combined = Buffer.concat([tail, current]);
      if (current.length) window(combined.toString("utf8"), decodedBytes - tail.length);
      decodedBytes += current.length;
      let start = Math.max(0, combined.length - 256);
      while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
      tail = Buffer.from(combined.subarray(start));
    };
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, count); checksum.update(chunk); bytes?.(chunk, total); total += count;
      if (textValid) {
        try { if (chunk.includes(0)) textValid = false; else deliver(decoder.decode(chunk, { stream: true })); }
        catch { textValid = false; }
      }
    }
    if (textValid) { try { deliver(decoder.decode()); } catch { textValid = false; } }
    if (fingerprint(before) !== fingerprint(fstatSync(fd)) || fingerprint(before) !== fingerprint(lstatSync(file))) throw new Error("Evidence changed during read");
    if (checksum.digest("hex") !== evidence.sha256 || total !== evidence.bytes) throw new Error("Evidence SHA-256/size mismatch");
    if (!textValid) throw new Error("Evidence is not UTF-8 text; inspect the original with its appropriate reader");
    return { file, fingerprint: fingerprint(before) };
  } finally { closeSync(fd); }
}

/** Comparison uses the same full archive checks as original reading. Retain only
 * the two explicitly selected originals, within the existing ingestion limit. */
export function readVerifiedArchive(evidence: Evidence, dataDir: string, workspace: string): string {
  if (evidence.bytes > 10 * 1024 * 1024) throw new Error("Comparison archive exceeds 10 MiB; read original ranges instead");
  const chunks: Buffer[] = [];
  scan(evidence, dataDir, workspace, () => {}, (chunk, offset) => {
    if (offset + chunk.length > 10 * 1024 * 1024) throw new Error("Comparison archive exceeds 10 MiB; read original ranges instead");
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks).toString("utf8");
}

export function searchOriginals(board: BoardSnapshot, dataDir: string, workspace: string, query: string, limit = 6, refresh = false, queryGroups?: QueryGroup[], preferredEvidence?: string[], excludedEvidence?: string[]) {
  if (!query.trim() || query.length > 4000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Use a nonempty query up to 4000 characters and limit 1–20.");
  const groups = compileQueryGroups(query, queryGroups);
  const tokens = [...new Set(groups.flatMap(group => group.alternatives.flatMap(item => item.tokens)))];
  const poolLimit = preferredEvidence ? 20 : limit;
  const exactTokens = new Set(query.normalize("NFKC").toLowerCase().match(/[a-z0-9_-]+/g));
  const excluded = new Set(excludedEvidence?.filter(id => !exactTokens.has(id.toLowerCase())));
  if (!tokens.length) throw new Error("Query has no searchable terms");
  return withIndexCache(dataDir, workspace, (db, index) => {
    type Hit = { locator: OriginalLocator; readPath: string; contextReadPath: string; snippet: string; score: number; matchedTerms: string[]; matches?: { groupId: string; expression: string; coverage: string }[] };
    type Window = { offset: number; byteLength: number };
    const lanes: Hit[][] = groups.map(() => []), laneMatches = groups.map(() => 0);
    const issues: { evidenceId: string; reason: string }[] = [], inspected: { evidenceId: string; file: string; fingerprint: string }[] = [];
    const windows = new Map<string, Window[]>();
    const updates = new Map<string, { signature: string; windows: Window[]; units: string[][] }>();
    const invalid = new Set<string>();
    for (const evidence of board.evidence) {
      let cacheOperation = false;
      try {
        const file = archivePath(evidence, dataDir, workspace), stat = lstatSync(file);
        if (!stat.isFile()) throw new Error("Evidence must be a regular file");
        const signature = wikiDigest([evidence.path, evidence.pathBase, evidence.sha256, evidence.bytes, fingerprint(stat)]);
        cacheOperation = true;
        const previous = cachedEntry<Window[]>(db, "original", evidence.id);
        if (previous && (!Array.isArray(previous.value) || previous.value.some(window => !Number.isSafeInteger(window?.offset) || window.offset < 0
          || !Number.isSafeInteger(window?.byteLength) || window.byteLength < 1))) throw new Error("Invalid original cache windows");
        cacheOperation = false;
        let current: Window[];
        if (!refresh && previous?.signature === signature) { current = previous.value; index.reused++; }
        else {
          current = []; const units: string[][] = [];
          scan(evidence, dataDir, workspace, (text, offset) => {
            current.push({ offset, byteLength: Buffer.byteLength(text) }); units.push([...new Set(terms(text))]);
          });
          index.indexedBytes += evidence.bytes;
          previous ? index.updated++ : index.added++;
          updates.set(evidence.id, { signature, windows: current, units });
        }
        windows.set(evidence.id, current);
        inspected.push({ evidenceId: evidence.id, file, fingerprint: fingerprint(stat) });
      } catch (error) {
        if (cacheOperation) throw error;
        invalid.add(evidence.id);
        issues.push({ evidenceId: evidence.id, reason: (error as Error).message });
      }
    }
    const selected = new Map<string, Set<number>>();
    const lookup = db.prepare("SELECT key,unit FROM terms WHERE namespace='original' AND term=?");
    for (const term of tokens) for (const row of lookup.all(term)) {
      const key = String(row.key);
      if (updates.has(key) || invalid.has(key) || !windows.has(key)) continue;
      const set = selected.get(key) ?? new Set<number>();
      set.add(Number(row.unit)); selected.set(key, set);
    }
    const queryTerms = new Set(tokens);
    for (const [key, update] of updates) update.units.forEach((unit, i) => {
      if (!unit.some(term => queryTerms.has(term))) return;
      const set = selected.get(key) ?? new Set<number>(); set.add(i); selected.set(key, set);
    });
    let matchedWindows = 0;
    const order = (a: Hit, b: Hit) => b.score - a.score || a.locator.evidenceId.localeCompare(b.locator.evidenceId) || a.locator.byteOffset - b.locator.byteOffset;
    for (const evidence of board.evidence) {
      if (excluded.has(evidence.id) || !windows.has(evidence.id) || !selected.has(evidence.id)) continue;
      const offsets = new Set([...selected.get(evidence.id)!].map(unit => windows.get(evidence.id)![unit]?.offset));
      const candidates: Hit[][] = groups.map(() => []), counts = groups.map(() => 0); let matches = 0;
      try {
        scan(evidence, dataDir, workspace, (text, offset) => {
          if (!offsets.has(offset)) return;
          const words = new Set(terms(text)), matchedTerms = tokens.filter(term => words.has(term));
          if (!matchedTerms.length) return;
          matches++;
          groups.forEach((group, groupIndex) => {
            const alternatives = group.alternatives.map(item => ({ ...item, found: item.tokens.filter(term => words.has(term)) }))
              .filter(item => item.found.length).sort((a, b) => Number(b.found.length === b.tokens.length) - Number(a.found.length === a.tokens.length)
                || b.found.length / b.tokens.length - a.found.length / a.tokens.length || b.found.length - a.found.length);
            const best = alternatives[0]; if (!best) return;
            const key = [...best.found].sort((a, b) => b.length - a.length)[0]!;
            const position = originalTermOffset(text, key);
            let start = Math.max(0, position - 160), end = Math.min(text.length, position + 1200);
            if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
            if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
            const snippet = text.slice(start, end), snippetTerms = new Set(terms(snippet));
            const retainedTerms = best.found.filter(term => snippetTerms.has(term));
            if (!retainedTerms.length) return;
            const locator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: offset + Buffer.byteLength(text.slice(0, start)), byteLength: Buffer.byteLength(snippet) };
            if (!locator.byteLength) return;
            counts[groupIndex] = counts[groupIndex]! + 1;
            const score = retainedTerms.reduce((sum, term) => sum + 1 + Math.min(term.length, 24) / 24, 0)
              + (queryGroups ? 100 * retainedTerms.length / best.tokens.length : 0);
            candidates[groupIndex]!.push({ locator, readPath: originalReadPath(locator), contextReadPath: originalReadPath({ ...locator, contextBytes: 1024 }), snippet, matchedTerms: retainedTerms, score,
              ...(queryGroups ? { matches: [{ groupId: group.id, expression: best.expression, coverage: retainedTerms.length === best.tokens.length ? "full_expression" : "partial_expression" }] } : {}) });
            candidates[groupIndex]!.sort(order); if (candidates[groupIndex]!.length > poolLimit) candidates[groupIndex]!.length = poolLimit;
          });
        });
        index.verifiedOriginals++; matchedWindows += matches;
        candidates.forEach((items, i) => {
          laneMatches[i] = laneMatches[i]! + counts[i]!;
          lanes[i]!.push(...items); lanes[i]!.sort(order); if (lanes[i]!.length > poolLimit) lanes[i]!.length = poolLimit;
        });
      } catch (error) { issues.push({ evidenceId: evidence.id, reason: (error as Error).message }); }
    }
    for (const item of inspected) {
      try { if (fingerprint(lstatSync(item.file)) !== item.fingerprint) throw new Error("changed"); }
      catch { issues.push({ evidenceId: item.evidenceId, reason: "Evidence changed during search; retry" }); }
    }
    const unavailable = new Set(issues.map(item => item.evidenceId));
    const hitKey = (hit: Hit) => JSON.stringify(hit.locator);
    const merged = new Map<string, Hit>();
    for (const lane of lanes) for (const hit of lane) {
      const old = merged.get(hitKey(hit));
      if (!old) merged.set(hitKey(hit), hit);
      else if (queryGroups) {
        old.score = Math.max(old.score, hit.score);
        old.matches = [...new Map([...old.matches ?? [], ...hit.matches ?? []].map(match => [match.groupId, match])).values()];
        old.matchedTerms = [...new Set([...old.matchedTerms, ...hit.matchedTerms])];
      }
    }
    if (preferredEvidence) {
      const preference = new Map(preferredEvidence.map((id, i) => [id, i]));
      for (const lane of lanes) lane.sort((a, b) => (preference.get(a.locator.evidenceId) ?? Infinity) - (preference.get(b.locator.evidenceId) ?? Infinity));
    }
    const valid = interleaveCandidates(lanes.map(lane => lane.filter(hit => !unavailable.has(hit.locator.evidenceId)).map(hit => merged.get(hitKey(hit))!)), hitKey).slice(0, limit);
    // Publish only after all archive scanning/verification. No writer lock is
    // held while reading original bytes; a concurrent cache writer may cause a
    // disposable-cache fallback, never a partially published index.
    index.removed = pruneEntries(db, "original", new Set(board.evidence.map(item => item.id)));
    for (const key of invalid) removeEntry(db, "original", key);
    for (const [key, update] of updates) if (!unavailable.has(key)) putEntry(db, "original", key, update.signature, update.windows, update.units);
    return { generator: wikiGenerator, type: "original_search", evidence: false, boardRevision: board.revision, query,
      coverage: "All registered task evidence bodies, indexed in overlapping UTF-8 windows. Unchanged file fingerprints reuse term postings; candidate originals are fully hash/size/UTF-8 verified before delivery. No private transcripts or other tasks.",
      notice: "Lexical source windows are navigation, not independent evidence or an answer. Use contextReadPath for nearby qualifications and source packages for corrections; distant conditions may still be omitted. Warm no-match is not a fresh integrity audit and does not establish absence; use refresh=true to rebuild from bytes.",
      index,
      ...(queryGroups ? { queryGroups: groups.map((group, i) => ({ id: group.id, matchedWindows: laneMatches[i], deliveredWindows: valid.filter(hit => hit.matches?.some(match => match.groupId === group.id)).length,
        fullExpressionWindows: valid.filter(hit => hit.matches?.some(match => match.groupId === group.id && match.coverage === "full_expression")).length })),
        groupingNotice: "Per-input lexical windows, not fulfilled prerequisites. A displayed expression may match partially; matchedTerms describe this snippet only." } : {}),
      complete: !issues.length, inspectedCount: inspected.length, registeredCount: board.evidence.length, matchedWindows,
      deferredWindows: Math.max(0, matchedWindows - valid.length), issues, hits: valid };
  });
}

/** Locate normalized identifier/CJK matches in original UTF-16 coordinates so
 * full-width spelling and supplementary characters retain exact byte locators. */
function originalTermOffset(text: string, term: string): number {
  for (const match of text.matchAll(/[\p{L}\p{N}_]+(?:[-/.][\p{L}\p{N}_]+)*/gu)) {
    if (!terms(match[0]).includes(term)) continue;
    const direct = match[0].toLowerCase().indexOf(term);
    if (direct >= 0) return match.index + direct;
    let normalized = "", offset = 0; const positions: number[] = [];
    for (const char of match[0]) {
      const value = char.normalize("NFKC").toLowerCase(); normalized += value;
      for (let i = 0; i < value.length; i++) positions.push(offset);
      offset += char.length;
    }
    return match.index + (positions[Math.max(0, normalized.indexOf(term))] ?? 0);
  }
  return 0;
}

export function readOriginal(board: BoardSnapshot, dataDir: string, workspace: string, request: OriginalReadRequest) {
  const evidence = board.evidence.find(item => item.id === request.evidenceId);
  if (!evidence) throw new Error("Unknown evidence ID in this task");
  if (request.sha256 !== evidence.sha256) throw new Error("Stale evidence locator; search the current original again");
  const { byteOffset } = request;
  const byteLength = request.byteLength ?? Math.min(4096, evidence.bytes - byteOffset);
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 8192 || byteOffset + byteLength > evidence.bytes)
    throw new Error(`Original locator must be within the registered file, with byteLength 1–8192. File has ${evidence.bytes} bytes; byteOffset is zero-based and offset + length must not exceed file size. Omit byteLength for automatic UTF-8 paging and copy returned nextReadPath. Restart path: ${originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: 0 })}`);
  const contextBytes = request.contextBytes ?? 0;
  if (!Number.isSafeInteger(contextBytes) || contextBytes < 0 || contextBytes > 2048)
    throw new Error("contextBytes must be an integer from 0 to 2048 per side");
  const rangeStart = Math.max(0, byteOffset - contextBytes), rangeEnd = Math.min(evidence.bytes, byteOffset + byteLength + contextBytes);
  if (rangeEnd - rangeStart > 8192) throw new Error("Original range with context exceeds 8192 bytes; reduce byteLength or contextBytes");
  const chunks: Buffer[] = [];
  scan(evidence, dataDir, workspace, () => {}, (chunk, offset) => {
    const start = Math.max(rangeStart, offset), end = Math.min(rangeEnd, offset + chunk.length);
    if (start < end) chunks.push(Buffer.from(chunk.subarray(start - offset, end - offset)));
  });
  const collected = Buffer.concat(chunks);
  let focus = collected.subarray(byteOffset - rangeStart, byteOffset - rangeStart + byteLength);
  // Default pages end on a UTF-8 boundary; explicit search locators remain exact.
  if (request.byteLength === undefined && byteOffset + byteLength < evidence.bytes) {
    for (let removed = 0; removed < 4; removed++) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(focus); break; }
      catch { if (removed === 3) break; focus = focus.subarray(0, -1); }
    }
  }
  const decode = (bytes: Buffer) => {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("Locator splits UTF-8 characters; use an exact returned search locator"); }
  };
  // Expansion never makes an invalid explicit anchor look valid.
  decode(focus);
  const focusLocator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset, byteLength: focus.length };
  let selected = focus, deliveredOffset = byteOffset;
  if (contextBytes) {
    let start = 0;
    while ((collected[start]! & 0xc0) === 0x80) start++;
    deliveredOffset = rangeStart + start;
    selected = collected.subarray(start, Math.min(evidence.bytes, byteOffset + focus.length + contextBytes) - rangeStart);
    for (let removed = 0; removed < 3; removed++) {
      try { decode(selected); break; } catch { selected = selected.subarray(0, -1); }
    }
  }
  const text = decode(selected);
  const locator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: deliveredOffset, byteLength: selected.length };
  const end = deliveredOffset + selected.length;
  return { generator: wikiGenerator, type: "original_read", evidence: false, boardRevision: board.revision, locator, rangeSha256: hash(selected),
    ...(contextBytes ? { focusLocator, contextBytes } : {}),
    originalFile: evidencePath(evidence, dataDir, workspace), integrity: "verified", text,
    omittedBefore: deliveredOffset, omittedAfter: evidence.bytes - end,
    ...(end < evidence.bytes ? { nextReadPath: originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: end }) } : {}),
    ...(deliveredOffset ? { startReadPath: originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: 0 }) } : {}),
    sourceContextReadPath: `xloom://record?${new URLSearchParams({ kind: "evidence", id: evidence.id })}`,
    notice: "Verified archive bytes, not a new observation. Follow nextReadPath for sequential pages; for full native delivery follow reading.nextOriginalReadPath until reading.originalsWithUnreadBytes is 0. Reaching the last window alone leaves earlier gaps unread; hashes and shell summaries do not fill native delivery receipts. Preserve source conditions/corrections. Delivery does not mean reviewed or true." };
}
