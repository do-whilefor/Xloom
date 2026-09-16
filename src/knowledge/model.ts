import type { BoardSnapshot, Execution } from "../types.js";
import { applyGapRecords } from "./gaps.js";
import { wikiBasis, wikiDigest, wikiRecord, type WikiSource, type WikiStamp } from "../wiki/model.js";
import { compareConditions, portsMatch, type Capability, type Chain } from "./schema.js";

const sources = (kind: WikiSource["kind"], ids: string[]): WikiSource[] => [...new Set(ids)].map(id => ({ kind, id }));
function basisIssues(board: BoardSnapshot, basis: WikiStamp[], roots: WikiSource[]): string[] {
  try {
    const current = wikiBasis(board, roots);
    const issues = wikiDigest(current) === wikiDigest(basis) ? [] : ["source_changed"];
    if (roots.some(ref => {
      const record = wikiRecord(board, ref)?.value;
      return record && "reviewIssues" in record && Array.isArray(record.reviewIssues) && record.reviewIssues.some(code => code !== "source_replaced");
    })) issues.push("source_review_required");
    return issues;
  } catch { return ["source_missing"]; }
}
export function capabilityIssues(board: BoardSnapshot, capability: Capability): string[] {
  return [...basisIssues(board, capability.basis, sources("fact", [...capability.factIds, ...capability.counterFactIds])),
    ...(board.facts.some(fact => fact.supersedes && capability.factIds.includes(fact.supersedes)) ? ["source_replaced"] : [])];
}
export function chainSources(chain: Pick<Chain, "capabilityIds" | "links" | "resultFactIds" | "counterFactIds">): WikiSource[] {
  return [...sources("capability", chain.capabilityIds), ...sources("fact", [...chain.links.flatMap(link => link.factIds), ...chain.resultFactIds, ...chain.counterFactIds])];
}
export function chainIssues(board: BoardSnapshot, chain: Chain): string[] { return basisIssues(board, chain.basis, chainSources(chain)); }

/** No transcripts, internal run IDs, archived author history or cached index data. */
export function knowledgeRecord(board: BoardSnapshot, ref: WikiSource): { value: object; dependencies: WikiSource[] } | undefined {
  if (ref.kind === "capability") {
    const record = board.capabilities?.find(item => item.id === ref.id); if (!record) return;
    const { history: _history, basis: _basis, ...value } = record;
    return { value: { ...value, reviewIssues: capabilityIssues(board, record) }, dependencies: sources("fact", [...record.factIds, ...record.counterFactIds]) };
  }
  if (ref.kind === "chain") {
    const record = board.chains?.find(item => item.id === ref.id); if (!record) return;
    const { history: _history, basis: _basis, ...value } = record;
    return { value: { ...value, reviewIssues: chainIssues(board, record) }, dependencies: chainSources(record) };
  }
}

export function applyKnowledge(board: BoardSnapshot, output: Execution, resolveFact: (ref: string) => string, verify: (id: string) => void): void {
  const facts = (refs: string[]) => [...new Set(refs.map(ref => {
    const id = resolveFact(ref), fact = board.facts.find(item => item.id === id);
    if (!fact?.evidenceIds.length) throw new Error(`Knowledge requires an evidence-backed Fact: ${JSON.stringify(ref)}`);
    fact.evidenceIds.forEach(verify); return id;
  }))];
  const seal = (roots: WikiSource[]) => {
    const basis = wikiBasis(board, roots);
    basis.filter(ref => ref.kind === "evidence").forEach(ref => verify(ref.id));
    return basis;
  };
  for (const proposal of output.capabilities ?? []) {
    const { factRefs, counterFactRefs, ...fields } = proposal;
    const factIds = facts(factRefs), counterFactIds = facts(counterFactRefs);
    const basis = seal(sources("fact", [...factIds, ...counterFactIds]));
    const records = board.capabilities ??= [], index = records.findIndex(item => item.id === proposal.id), old = records[index];
    const value = { ...fields, factIds, counterFactIds, basis, revision: old?.revision ?? 1 };
    if (old && wikiDigest({ ...old, history: undefined }) === wikiDigest(value)) continue;
    const { history = [], ...previous } = old ?? {};
    const record: Capability = { ...value, revision: old ? old.revision + 1 : 1, history: old ? [...history, previous as Omit<Capability, "history">] : [] };
    if (index < 0) records.push(record); else records[index] = record;
  }
  for (const proposal of output.chains ?? []) {
    const { links: proposals, resultFactRefs, counterFactRefs, ...fields } = proposal;
    const capabilities = proposal.capabilityIds.map(id => {
      const record = board.capabilities?.find(item => item.id === id);
      if (!record) throw new Error(`Unknown chain capability: ${JSON.stringify(id)}`); return record;
    });
    const links = proposals.map(({ factRefs, ...link }) => {
      const producer = capabilities.find(item => item.id === link.producerId), consumer = capabilities.find(item => item.id === link.consumerId);
      if (!producer || !consumer || capabilities.indexOf(producer) >= capabilities.indexOf(consumer)) throw new Error("Chain links must follow capabilityIds topological order.");
      const provide = producer.provides[link.provideIndex], need = consumer.needs[link.needIndex];
      if (!provide || !need || !portsMatch(provide, need)) throw new Error("Chain link has invalid port indices or unmatched explicit types/aliases.");
      const factIds = facts(factRefs);
      if (link.status === "verified") {
        if (!factIds.length || producer.status !== "available" || consumer.status !== "available" || capabilityIssues(board, producer).length || capabilityIssues(board, consumer).length)
          throw new Error("Verified links require fresh available capabilities and actual consumption Facts.");
        if (compareConditions([producer.conditions, consumer.conditions, link.conditions, proposal.conditions]).status !== "compatible")
          throw new Error("Verified links require known, jointly compatible conditions.");
      }
      return { ...link, factIds };
    });
    const resultFactIds = facts(resultFactRefs), counterFactIds = facts(counterFactRefs);
    if (new Set(links.map(link => JSON.stringify([link.producerId, link.consumerId, link.provideIndex, link.needIndex]))).size !== links.length) throw new Error("Duplicate chain link.");
    if (proposal.status === "verified") {
      if (!resultFactIds.length || links.some(link => link.status !== "verified")) throw new Error("Verified chains require verified links and final-result Facts.");
      if (compareConditions([proposal.conditions, ...capabilities.map(item => item.conditions), ...links.map(link => link.conditions)]).status !== "compatible") throw new Error("Chain conditions cannot all hold together.");
      for (const capability of capabilities) {
        if (capability.status !== "available" || capabilityIssues(board, capability).length) throw new Error("Verified chain includes unavailable or stale capabilities.");
        capability.needs.forEach((_, index) => { if (!links.some(link => link.consumerId === capability.id && link.needIndex === index)) throw new Error("Verified chain is missing a required input."); });
      }
      const reachesResult = new Set([capabilities.at(-1)!.id]);
      for (const capability of capabilities.slice().reverse()) if (links.some(link => link.producerId === capability.id && reachesResult.has(link.consumerId))) reachesResult.add(capability.id);
      if (reachesResult.size !== capabilities.length) throw new Error("Every verified chain capability must reach its final consumer.");
    }
    if (proposal.status === "refuted" && !resultFactIds.length && !counterFactIds.length) throw new Error("Refuted chains require result or counterevidence Facts.");
    const records = board.chains ??= [], index = records.findIndex(item => item.id === proposal.id), old = records[index];
    const value = { ...fields, links, resultFactIds, counterFactIds, basis: seal(chainSources({ capabilityIds: fields.capabilityIds, links, resultFactIds, counterFactIds })), revision: old?.revision ?? 1 };
    if (old && wikiDigest({ ...old, history: undefined }) === wikiDigest(value)) continue;
    const { history = [], ...previous } = old ?? {};
    const record: Chain = { ...value, revision: old ? old.revision + 1 : 1, history: old ? [...history, previous as Omit<Chain, "history">] : [] };
    if (index < 0) records.push(record); else records[index] = record;
  }
}

/** Diagnose semantic/reference errors before the existing no-tool repair request.
 * Temporary records stand for this batch's references, never committed evidence. */
export function validateKnowledgeSubmission(board: BoardSnapshot, output: Execution, stepId?: string): void {
  if (!output.capabilities?.length && !output.chains?.length && !output.gaps?.length && !output.gapLinks?.length) return;
  const staged = structuredClone(board);
  for (const fact of output.facts ?? []) {
    if (staged.facts.some(item => item.id === fact.ref)) throw new Error("Ambiguous local Fact reference in knowledge submission.");
    staged.facts.push({ id: fact.ref, description: fact.description, evidenceIds: fact.evidenceRefs, stepId: null, ...(fact.supersedes ? { supersedes: fact.supersedes } : {}) });
  }
  for (const evidence of output.evidence ?? []) {
    if (staged.evidence.some(item => item.id === evidence.ref)) throw new Error("Ambiguous local Evidence reference in knowledge submission.");
    staged.evidence.push({ id: evidence.ref, description: evidence.description, path: evidence.path, sha256: "pending-archive", bytes: 0, runId: "", stepId: "" });
  }
  applyKnowledge(staged, output, ref => ref, () => {});
  if (output.gaps?.length || output.gapLinks?.length) {
    const step = staged.steps.find(item => item.id === stepId);
    if (!step) throw new Error("Gap records require the assigned Step.");
    applyGapRecords(staged, step, output, ref => ref);
  }
}

export function knowledgeChanges(before: BoardSnapshot, after: BoardSnapshot) {
  const changed = (kind: "capability" | "chain", ids: string[]) => ids.filter(id => wikiDigest(knowledgeRecord(before, { kind, id })?.value ?? null) !== wikiDigest(knowledgeRecord(after, { kind, id })?.value ?? null));
  return { capabilityIds: changed("capability", after.capabilities?.map(item => item.id) ?? []), chainIds: changed("chain", after.chains?.map(item => item.id) ?? []) };
}
