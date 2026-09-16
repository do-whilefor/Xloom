import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BoardSnapshot, Execution, Finding } from "../types.js";
import { wikiBasis, wikiDigest, type WikiStamp } from "../wiki/model.js";

export const metricKeys = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;
export type Metric = typeof metricKeys[number];
export interface CvssResult {
  vector: string; version: "3.1"; metricGroup: "Base"; metrics: Record<Metric, string>;
  ISCBase: number; impact: number; impactLabel: string; exploitability: number;
  baseScore: number; severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}
export const calculatorFile = fileURLToPath(new URL("../../resources/cvss/cvss31-calculator.cjs", import.meta.url));
// Load the bundled calculator in process. Importing it
// does not start a CLI, open stdin, spawn Python or establish another state store.
const calculator = createRequire(import.meta.url)(calculatorFile) as { calc(vector: string): CvssResult; roundup(value: number): number };
export const calculateCvss = (vector: string): CvssResult => calculator.calc(vector);
export const roundup = (value: number): number => calculator.roundup(value);
const text = (max = 2048) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"), "Must not contain NUL");
const metricReason = z.object({ reason: text(), factRefs: z.array(text(256)).max(32), assumption: z.boolean() }).strict()
  .refine(value => value.assumption || value.factRefs.length > 0, "Observed metrics require Fact references; otherwise mark assumption:true");
export const cvssProposalSchema = z.object({ vector: text(256).superRefine((value, ctx) => {
  try { calculateCvss(value); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid CVSS 3.1 Base vector; provide each of AV/AC/PR/UI/S/C/I/A once with valid values." }); }
}), rationale: z.object(Object.fromEntries(metricKeys.map(key => [key, metricReason])) as Record<Metric, typeof metricReason>).strict() }).strict();
export type CvssProposal = z.infer<typeof cvssProposalSchema>;
export interface CvssAssessment extends CvssResult {
  rationale: Record<Metric, { reason: string; factIds: string[]; assumption: boolean }>;
  status: "proposed" | "reviewed";
  reviewReason?: string;
  basis: WikiStamp[];
  findingSignature: string;
}
export const cvssReviewsSchema = z.array(z.object({ findingId: text(256), assessment: cvssProposalSchema, reason: text() }).strict()).max(32)
  .refine(items => new Set(items.map(item => item.findingId)).size === items.length, "Review each Finding CVSS once per decision");

const findingSignature = (finding: Finding) => wikiDigest({ target: finding.target, factIds: [...finding.factIds].sort(), evidenceIds: [...finding.evidenceIds].sort(), impact: finding.impact });
export function assessCvss(board: BoardSnapshot, finding: Finding, proposal: CvssProposal, resolveFact: (id: string) => string,
  verify: (id: string) => void, status: CvssAssessment["status"], reviewReason?: string): CvssAssessment {
  const rationale = Object.fromEntries(metricKeys.map(key => {
    const value = proposal.rationale[key];
    const factIds = [...new Set(value.factRefs.map(ref => {
      const id = resolveFact(ref), fact = board.facts.find(item => item.id === id);
      if (!fact?.evidenceIds.length || !finding.factIds.includes(id)) throw new Error(`CVSS ${key} must reference evidence-backed Facts attached to this Finding.`);
      if (board.facts.some(item => item.supersedes === id)) throw new Error(`CVSS ${key} references a superseded Fact; inspect its replacement.`);
      fact.evidenceIds.forEach(verify); return id;
    }))];
    return [key, { reason: value.reason, factIds, assumption: value.assumption }];
  })) as CvssAssessment["rationale"];
  const refs = [...new Set(Object.values(rationale).flatMap(value => value.factIds))].map(id => ({ kind: "fact" as const, id }));
  const basis = wikiBasis(board, refs);
  basis.filter(ref => ref.kind === "evidence").forEach(ref => verify(ref.id));
  return { ...calculateCvss(proposal.vector), rationale, status, ...(reviewReason ? { reviewReason } : {}), basis, findingSignature: findingSignature(finding) };
}

/** Derived applicability warnings; the supplied vector's arithmetic never changes. */
export function cvssIssues(board: BoardSnapshot, finding: Finding): string[] {
  const cvss = finding.cvss;
  if (!cvss) return [];
  const issues: string[] = [];
  if (cvss.status === "proposed") issues.push("awaiting_decide_review");
  if (Object.values(cvss.rationale).some(value => value.assumption)) issues.push("conditional_metrics");
  if (finding.status === "closed") issues.push("finding_closed");
  if (cvss.findingSignature !== findingSignature(finding)) issues.push("finding_changed");
  const refs = [...new Set(Object.values(cvss.rationale).flatMap(value => value.factIds))].map(id => ({ kind: "fact" as const, id }));
  try { if (wikiDigest(wikiBasis(board, refs)) !== wikiDigest(cvss.basis)) issues.push("sources_changed"); }
  catch { issues.push("source_missing"); }
  return issues;
}

/** Explicit public fields only; private or future runtime properties stay out. */
export function projectCvss(cvss: CvssAssessment): CvssAssessment {
  return { vector: cvss.vector, version: cvss.version, metricGroup: cvss.metricGroup, baseScore: cvss.baseScore, severity: cvss.severity,
    ISCBase: cvss.ISCBase, impact: cvss.impact, impactLabel: cvss.impactLabel, exploitability: cvss.exploitability,
    metrics: Object.fromEntries(metricKeys.map(key => [key, cvss.metrics[key]])) as CvssResult["metrics"],
    rationale: Object.fromEntries(metricKeys.map(key => [key, { reason: cvss.rationale[key].reason, assumption: cvss.rationale[key].assumption, factIds: [...cvss.rationale[key].factIds] }])) as CvssAssessment["rationale"],
    status: cvss.status, ...(cvss.reviewReason ? { reviewReason: cvss.reviewReason } : {}),
    basis: cvss.basis.map(ref => ({ kind: ref.kind, id: ref.id, signature: ref.signature })), findingSignature: cvss.findingSignature };
}

/** Reference preflight for the existing no-tool repair pass; never persists a score. */
export function validateCvssExecution(board: BoardSnapshot, output: Execution): void {
  if (!output.findings?.some(item => item.cvss)) return;
  const staged = structuredClone(board);
  for (const evidence of output.evidence ?? []) staged.evidence.push({ id: evidence.ref, path: evidence.path, description: evidence.description, bytes: 0, sha256: "pending-archive", runId: "", stepId: "" });
  for (const fact of output.facts ?? []) staged.facts.push({ id: fact.ref, description: fact.description, stepId: null, evidenceIds: fact.evidenceRefs, ...(fact.supersedes ? { supersedes: fact.supersedes } : {}) });
  const normalize = (key: string) => key.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  for (const proposal of output.findings ?? []) {
    let finding = staged.findings.find(item => normalize(item.key) === normalize(proposal.key));
    if (!finding) { finding = { id: `pending-${proposal.key}`, key: proposal.key, title: proposal.title, target: proposal.target ?? "", status: proposal.status, rating: "unrated", next: proposal.next, factIds: [], evidenceIds: [] }; staged.findings.push(finding); }
    finding.factIds = [...new Set([...finding.factIds, ...proposal.factRefs])];
    if (proposal.cvss) assessCvss(staged, finding, proposal.cvss, ref => ref, () => {}, "proposed");
  }
}

export function cvssContext() {
  return { version: "3.1", metricGroup: "Base", calculatorFile, nodeExecutable: process.execPath,
    authoringGuide: fileURLToPath(new URL("../../resources/cvss/authoring.md", import.meta.url)),
    notice: "Execute may attach cvss:{vector,rationale:{AV:{reason,factRefs,assumption},AC:{...},PR:{...},UI:{...},S:{...},C:{...},I:{...},A:{...}} to a Finding. All eight metric reasons are required; unsupported choices must be assumptions. Decide may submit cvssReviews:[{findingId,assessment:{vector,rationale},reason}]. Controller computes scores; never submit a score. Facts must belong to the Finding. Read the guide before first scoring. The existing powershell tool can run calculatorFile --json <vector>. Scoring/review never promotes a Finding, selects priority, or completes a Goal; scores of chain members are not added." };
}
