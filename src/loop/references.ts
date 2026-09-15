import type { BoardSnapshot, Decision, Mode } from "../types.js";
import { assertRootGoalUpdate, assertSatisfiedRoot, inspectGoalDeclarations } from "./goals.js";
import { findingReviewErrors } from "./reviews.js";
import { applyGapDecision } from "../knowledge/gaps.js";
import { assessCvss } from "../scoring/cvss.js";

/** Check all explicit references against the complete board before the one repair
 * request. Report every bad reference together; never guess replacement IDs. */
export function validateDecisionReferences(board: BoardSnapshot, decision: Decision, mode?: Exclude<Mode, "execute">): void {
  if (decision.gapReviews?.length || decision.steps?.some(step => step.revisits?.length)) {
    const staged = structuredClone(board);
    const steps = (decision.steps ?? []).map((step, index) => ({ ...step, id: `pending-${index}`, status: "ready" as const, attempts: 0, runId: null, leaseUntil: null }));
    staged.steps.push(...steps);
    applyGapDecision(staged, decision, steps, () => {});
  }
  const facts = new Set(board.facts.map(fact => fact.id));
  const { goals, errors } = inspectGoalDeclarations(board.goals, decision.goals);
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const findings = new Map(board.findings.map(finding => [finding.id, { ...finding }]));
  const evidence = new Set(board.evidence.map(item => item.id));
  const evidenceLinks = new Map<string, string[]>();
  for (const review of decision.cvssReviews ?? []) {
    const finding = board.findings.find(item => item.id === review.findingId);
    if (!finding) errors.push("Unknown Finding in CVSS review.");
    else assessCvss(board, finding, review.assessment, ref => ref, () => {}, "reviewed", review.reason);
  }
  const check = (known: { has(ref: string): boolean }, kind: string, ref: string, field: string) => {
    if (!known.has(ref)) errors.push(`Unknown ${kind} reference: ${field}=${JSON.stringify(ref)}`);
  };
  const checkFacts = (refs: string[], field: string) => refs.forEach((ref, index) => check(facts, "fact", ref, `${field}[${index}]`));
  decision.steps?.forEach((step, index) => {
    check(goals, "Goal", step.goalId, `steps[${index}].goalId`);
    checkFacts(step.from, `steps[${index}].from`);
    if (step.combination) {
      checkFacts(step.combination.requires, `steps[${index}].combination.requires`);
      checkFacts(step.combination.counterEvidence ?? [], `steps[${index}].combination.counterEvidence`);
    }
  });
  decision.updateSteps?.forEach((update, index) => {
    check(steps, "Step", update.id, `updateSteps[${index}].id`);
    if (steps.get(update.id)?.status === "claimed") errors.push(`updateSteps[${index}].id=${JSON.stringify(update.id)} is claimed; only ready Steps may be changed`);
    // Settled updates are intentionally left for the controller's history filter.
  });
  decision.updateGoals?.forEach((goal, index) => {
    check(goals, "Goal", goal.id, `updateGoals[${index}].id`);
    checkFacts(goal.factIds, `updateGoals[${index}].factIds`);
  });
  decision.reviews?.forEach((review, index) => {
    check(findings, "Finding", review.findingId, `reviews[${index}].findingId`);
    const finding = findings.get(review.findingId);
    if (finding) errors.push(...findingReviewErrors(finding, review, `reviews[${index}]`));
    if (review.pocEvidenceId) {
      check(evidence, "Evidence", review.pocEvidenceId, `reviews[${index}].pocEvidenceId`);
      if (finding && (!evidence.has(review.pocEvidenceId) || !finding.evidenceIds.includes(review.pocEvidenceId))) {
        evidenceLinks.set(finding.id, finding.evidenceIds);
      }
      if (finding && evidence.has(review.pocEvidenceId) && !finding.evidenceIds.includes(review.pocEvidenceId)) {
        errors.push(`reviews[${index}].pocEvidenceId=${JSON.stringify(review.pocEvidenceId)} must belong to Finding ${JSON.stringify(finding.id)}`);
      }
    }
    // Match Store's ordered reviews without changing the committed snapshot.
    if (finding) finding.status = review.status;
  });
  const pocGuidance = evidenceLinks.size ? ` Attached evidenceIds by Finding: ${JSON.stringify(Object.fromEntries(evidenceLinks))}. Use an attached ID only if it supports the review; otherwise defer that review and plan Execute to report/link the required evidence via the existing Finding key. Do not substitute IDs merely to pass validation.` : "";
  if (errors.length) throw new Error(`${errors.join("; ")}.${pocGuidance} Copy exact IDs from the committed blackboard (Fact IDs also appear in factIndex); never change ID prefixes, truncate IDs or guess replacements. Evidence IDs and batch-local refs are not Fact IDs. New Goals may reference an existing or earlier new parent Goal.`);
  // Ordinary Decide may propose completion for the controller's fresh metacog
  // handoff. Only the final reviewing role must satisfy the commit contract now.
  if (mode === "metacog") {
    const updates = decision.updateGoals?.filter(update => update.id === "G0") ?? [];
    for (const update of updates) assertRootGoalUpdate(update, decision.conclusion, mode);
    if (decision.conclusion && decision.conclusion.outcome !== "NEED_INPUT") {
      const root = board.goals.find(goal => goal.id === "G0" && goal.parentId === null), update = updates.at(-1);
      assertSatisfiedRoot(root && update ? { ...root, status: update.status, factIds: update.factIds } : root);
    }
  }
}
