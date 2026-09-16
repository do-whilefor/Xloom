import { evidencePath } from "../paths.js";
import { dirname, join } from "node:path";
import type { Attempt, BoardSnapshot, Evidence, Fact, Finding, Goal, Hint, Mode, RunRequest, Step } from "../types.js";
import { projectFindingContext, type FindingContext } from "./finding-context.js";
import { projectCvss } from "../scoring/cvss.js";
import { causalFactInputs, factInputs } from "./fact-basis.js";
import { boundedFactIndex } from "./history.js";

export type ContextStep = Omit<Step, "runId" | "leaseUntil"> & {
  /** A failed run may have left files here; this is not committed or verified Evidence. */
  recovery?: { artifacts: string; evidenceStatus: "unverified" };
};
export type ContextEvidence = Omit<Evidence, "runId">;
export type StepOrigin = Pick<Step, "id" | "description" | "status" | "from" | "combination" | "methodIds">;
export interface FactIndexEntry {
  id: string;
  summary: string;
  stepId: string | null;
  evidenceIds: string[];
  supersedes?: string;
  replacedBy: string[];
  status: "available" | "superseded";
}
export interface StepReview { stepId: string; staleFactIds: string[]; replacementFactIds: string[] }
export type ContextAttempt = Omit<Attempt, "runId" | "conditionKey" | "outcomeKey">;
type Collection = "goals" | "facts" | "steps" | "findings" | "evidence" | "hints";
type ReferenceKind = "goals" | "facts" | "steps" | "evidence";

export interface BlackboardContext {
  revision: number;
  project: Pick<BoardSnapshot["config"], "title" | "goal" | "scope" | "context">;
  status: BoardSnapshot["status"];
  reason: string;
  planningMemory?: Omit<NonNullable<BoardSnapshot["planningMemory"]>, "runId"> & { evidenceStatus: "unverified"; notice: string };
  outcome: BoardSnapshot["outcome"];
  completedSteps: number;
  noProgressCount: number;
  goals: Goal[];
  facts: Fact[];
  /** Discovery summaries, not complete evidence: old isolated clues remain findable. */
  factIndex: FactIndexEntry[];
  /** Compact condition-aware trial summaries; referenced evidence may be omitted. */
  attempts: ContextAttempt[];
  steps: ContextStep[];
  findings: Finding[];
  evidence: ContextEvidence[];
  hints: Hint[];
  /** Causal provenance and conditions, without the old executable plans. */
  stepOrigins: StepOrigin[];
  /** Derived evidence navigation; never changes Finding support or review status. */
  findingContext?: FindingContext;
  projection: {
    mode: Mode;
    omitted: Record<Collection, number>;
    originStepCount: number;
    truncatedExcerpts: number;
    unavailableReferences: Record<ReferenceKind, string[]>;
    stepReviews: StepReview[];
    omittedAttempts: number;
    omittedFactIndex: number;
    history: { facts: string; attempts: string };
    notice: string;
  };
}

/** Replacement seam for future context strategies; it does not change Pi's loop. */
export type ContextProjector = (request: RunRequest) => BlackboardContext;

const tailLimits = { steps: 8, facts: 12, findings: 8, evidence: 8 } as const;
const excerptLimit = 2_000;
const pending = (step: Step): boolean => step.status === "ready" || step.status === "claimed";
const notice = "Partial role-specific view. Omission is not negative evidence, an untested boundary or permission to repeat; counts give no contents. Required dependencies may exceed a fixed context budget. stepOrigins: causal inputs/conditions, not executable plans. factIndex: bounded navigation; history pages cover all Facts/attempts; available means no recorded replacement, not current validity. Summaries/excerpts may be truncated and references unexpanded; inspect full evidence, and schedule Execute from indexed Facts for missing dependencies/comparisons. Superseded Facts are historical; read replacements. stepReviews: pending plans with superseded direct/causal inputs; recheck scope/identity/state and abandon/replan. attempts apply only to recorded scope/identity/state/baseline/changedVariable. Combination requires must hold together in the same scope/state; missing conditions are unverified. recovery.artifacts files may be absent or show unverified side effects, not committed Evidence or Facts. Inspect before retrying; in old runs read only artifacts, never sibling logs/transcripts/chats. Retain verifiable recovery evidence in this run's artifacts. unavailableReferences are missing records, never verified facts.";

function projectCombination(combination: NonNullable<Step["combination"]>): NonNullable<Step["combination"]> {
  return {
    requires: [...combination.requires], missing: [...combination.missing], scope: combination.scope,
    stateVersion: combination.stateVersion, expectedCapability: combination.expectedCapability,
    ...(combination.counterEvidence === undefined ? {} : { counterEvidence: [...combination.counterEvidence] }),
  };
}

function compact(value: string, length = 240): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function projectAttempt(attempt: Attempt): ContextAttempt {
  return {
    id: attempt.id, stepId: attempt.stepId, hypothesis: compact(attempt.hypothesis), scope: attempt.scope,
    identity: attempt.identity, stateVersion: attempt.stateVersion, baseline: compact(attempt.baseline),
    changedVariable: compact(attempt.changedVariable), outcome: attempt.outcome, observation: compact(attempt.observation, 500),
    evidenceIds: [...attempt.evidenceIds],
  };
}

/** Supersession invalidates applicability of dependent plans, not their archived evidence. */
export function pendingStepReviews(board: BoardSnapshot): StepReview[] {
  const facts = new Map(board.facts.map(fact => [fact.id, fact]));
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const replacements = new Map<string, string[]>();
  for (const fact of board.facts) if (fact.supersedes) {
    const previous = replacements.get(fact.supersedes) ?? [];
    previous.push(fact.id);
    replacements.set(fact.supersedes, previous);
  }
  if (!replacements.size) return [];

  const dependencies = new Map<string, string[]>();
  function causalInputs(fact: Fact): string[] {
    const cached = dependencies.get(fact.id);
    if (cached) return cached;
    // A correction may have used the prior Fact as an input to retest it. That
    // historical input alone must not make the corrected Fact permanently stale.
    const inputs = causalFactInputs(fact, facts, steps);
    dependencies.set(fact.id, inputs);
    return inputs;
  }

  const reviews: StepReview[] = [];
  for (const step of board.steps.filter(pending)) {
    const queue = factInputs(step);
    const visited = new Set<string>();
    const stale = new Set<string>();
    const replacementIds = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (replacements.has(id)) {
        stale.add(id);
        const successors = [...replacements.get(id)!];
        const seen = new Set<string>();
        for (let cursor = 0; cursor < successors.length; cursor++) {
          const successor = successors[cursor]!;
          if (seen.has(successor)) continue;
          seen.add(successor);
          replacementIds.add(successor);
          successors.push(...(replacements.get(successor) ?? []));
        }
      }
      const fact = facts.get(id);
      if (fact) queue.push(...causalInputs(fact));
    }
    if (stale.size) reviews.push({ stepId: step.id, staleFactIds: [...stale], replacementFactIds: [...replacementIds] });
  }
  return reviews;
}

// Select fields explicitly, including nested records, so future runtime fields and
// accidentally attached messages/credentials cannot leak through object spreads.
export function projectStep(step: Step, runsDir?: string): ContextStep {
  // Match the store's identifier constraint; never turn malformed state into a
  // path outside the artifact directory or expose a private transcript entry.
  const recovery = step.status === "failed" && runsDir && step.runId && /^[a-zA-Z0-9_-]{1,100}$/.test(step.runId)
    ? { artifacts: join(runsDir, step.runId, "artifacts"), evidenceStatus: "unverified" as const }
    : undefined;
  return {
    id: step.id, goalId: step.goalId, from: [...step.from], description: step.description,
    successSignal: step.successSignal, evidencePlan: step.evidencePlan, priority: step.priority,
    status: step.status, attempts: step.attempts,
    ...(step.methodIds === undefined ? {} : { methodIds: [...step.methodIds] }),
    ...(step.revisits === undefined ? {} : { revisits: step.revisits.map(ref => ({ stepId: ref.stepId, gapId: ref.gapId })) }),
    ...(step.combination === undefined ? {} : { combination: projectCombination(step.combination) }),
    ...(step.result === undefined ? {} : { result: step.result }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

function projectGoal(goal: Goal): Goal {
  return { id: goal.id, description: goal.description, parentId: goal.parentId, status: goal.status, factIds: [...goal.factIds] };
}

function projectFact(fact: Fact): Fact {
  return {
    id: fact.id, description: fact.description, stepId: fact.stepId, evidenceIds: [...fact.evidenceIds],
    ...(fact.supersedes === undefined ? {} : { supersedes: fact.supersedes }),
  };
}

function projectFinding(finding: Finding): Finding {
  return {
    id: finding.id, key: finding.key, target: finding.target, title: finding.title,
    status: finding.status, rating: finding.rating, evidenceIds: [...finding.evidenceIds],
    factIds: [...finding.factIds], next: finding.next,
    ...(finding.review === undefined ? {} : { review: finding.review }),
    ...(finding.observationReview ? { observationReview: structuredClone(finding.observationReview) } : {}),
    ...(finding.pocEvidenceId === undefined ? {} : { pocEvidenceId: finding.pocEvidenceId }),
    ...(finding.cvss === undefined ? {} : { cvss: projectCvss(finding.cvss) }),
    ...(finding.impact === undefined ? {} : { impact: {
      capability: finding.impact.capability, object: finding.impact.object, result: finding.impact.result,
      scope: finding.impact.scope, prerequisites: finding.impact.prerequisites,
    } }),
  };
}

/**
 * Preserve dependency-complete working state and bounded irrelevant history.
 * This is not a hard token limit: a large active frontier must remain visible.
 * The full append-only state and evidence archive are never changed here.
 */
export function projectContext(request: RunRequest): BlackboardContext {
  const board = request.snapshot;
  const goals = new Map(board.goals.map(goal => [goal.id, goal]));
  const facts = new Map(board.facts.map(fact => [fact.id, fact]));
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const evidence = new Map(board.evidence.map(item => [item.id, item]));
  if (request.mode === "execute" && request.step) steps.set(request.step.id, request.step);
  const selected = {
    goals: new Set<string>(), facts: new Set<string>(), steps: new Set<string>(),
    findings: new Set<string>(), evidence: new Set<string>(),
  };
  const originIds = new Set<string>();
  const unavailable = { goals: new Set<string>(), facts: new Set<string>(), steps: new Set<string>(), evidence: new Set<string>() };
  const replacements = new Map<string, string[]>();
  for (const fact of board.facts) {
    if (fact.supersedes) {
      const ids = replacements.get(fact.supersedes) ?? [];
      ids.push(fact.id);
      replacements.set(fact.supersedes, ids);
    }
  }

  function addGoal(id: string): void {
    // Iterative traversal handles deep trees and defensively terminates cycles.
    let current: string | null = id;
    while (current !== null && !selected.goals.has(current)) {
      const goal = goals.get(current);
      if (!goal) { unavailable.goals.add(current); break; }
      selected.goals.add(current);
      for (const factId of goal.factIds) selected.facts.add(factId);
      current = goal.parentId;
    }
  }

  function addStep(step: Step): void {
    selected.steps.add(step.id);
    addGoal(step.goalId);
    for (const factId of factInputs(step)) selected.facts.add(factId);
  }

  function addFinding(finding: Finding): void {
    selected.findings.add(finding.id);
    for (const factId of finding.factIds) selected.facts.add(factId);
    for (const evidenceId of finding.evidenceIds) selected.evidence.add(evidenceId);
    for (const factId of finding.observationReview?.factIds ?? []) selected.facts.add(factId);
    for (const evidenceId of finding.observationReview?.evidenceIds ?? []) selected.evidence.add(evidenceId);
    if (finding.pocEvidenceId) selected.evidence.add(finding.pocEvidenceId);
  }

  function closeFacts(): void {
    const queue: { kind: "facts" | "steps" | "evidence"; id: string }[] = [
      ...[...selected.facts].map(id => ({ kind: "facts" as const, id })),
      ...[...selected.evidence].map(id => ({ kind: "evidence" as const, id })),
    ];
    const visited = { facts: new Set<string>(), steps: new Set<string>(), evidence: new Set<string>() };
    for (let index = 0; index < queue.length; index++) {
      const { kind, id } = queue[index]!;
      if (visited[kind].has(id)) continue;
      visited[kind].add(id);
      if (kind === "facts") {
        for (const replacement of replacements.get(id) ?? []) queue.push({ kind, id: replacement });
        const fact = facts.get(id);
        if (!fact) { unavailable.facts.add(id); continue; }
        selected.facts.add(id);
        for (const evidenceId of fact.evidenceIds) queue.push({ kind: "evidence", id: evidenceId });
        if (fact.stepId) queue.push({ kind: "steps", id: fact.stepId });
        // Both directions matter: an assigned Step may still refer to a stale Fact.
        if (fact.supersedes) queue.push({ kind, id: fact.supersedes });
      } else if (kind === "evidence") {
        const item = evidence.get(id);
        if (!item) { unavailable.evidence.add(id); continue; }
        selected.evidence.add(id);
        queue.push({ kind: "steps", id: item.stepId });
      } else {
        const origin = steps.get(id);
        if (!origin) { unavailable.steps.add(id); continue; }
        originIds.add(id);
        for (const inputId of factInputs(origin)) queue.push({ kind: "facts", id: inputId });
      }
    }
  }

  if (request.mode === "execute") {
    if (request.step) {
      addStep(request.step);
      for (const fact of board.facts) if (fact.stepId === request.step.id) selected.facts.add(fact.id);
      for (const item of board.evidence) if (item.stepId === request.step.id) selected.evidence.add(item.id);
    } else {
      // Runtime validates the assignment; retain the user's roots if called alone.
      for (const goal of board.goals) if (goal.parentId === null) addGoal(goal.id);
    }
    closeFacts();
    const relatedFacts = new Set(selected.facts);
    const relatedEvidence = new Set(selected.evidence);
    for (const finding of board.findings) {
      if (finding.factIds.some(id => relatedFacts.has(id)) || finding.evidenceIds.some(id => relatedEvidence.has(id)) ||
        (finding.pocEvidenceId && relatedEvidence.has(finding.pocEvidenceId))) addFinding(finding);
    }
  } else {
    // A completion reviewer must never lose active goals or unresolved branches.
    for (const goal of board.goals) addGoal(goal.id);
    for (const step of board.steps.filter(pending)) addStep(step);
    for (const step of board.steps.filter(step => !pending(step)).slice(-tailLimits.steps)) addStep(step);
    for (const finding of board.findings.filter(finding => finding.status !== "closed" || finding.observationReview)) addFinding(finding);
    for (const finding of board.findings.filter(finding => finding.status === "closed").slice(-tailLimits.findings)) addFinding(finding);
    for (const fact of board.facts.slice(-tailLimits.facts)) selected.facts.add(fact.id);
    for (const item of board.evidence.slice(-tailLimits.evidence)) selected.evidence.add(item.id);
  }
  closeFacts();

  const stepOrigins: StepOrigin[] = [];
  for (const origin of steps.values()) {
    if (originIds.has(origin.id) && !selected.steps.has(origin.id)) {
      stepOrigins.push({ id: origin.id, description: origin.description, status: origin.status, from: [...origin.from],
        ...(origin.methodIds === undefined ? {} : { methodIds: [...origin.methodIds] }),
        ...(origin.combination === undefined ? {} : { combination: projectCombination(origin.combination) }) });
    }
  }
  let truncatedExcerpts = 0;
  const recentAttempts = new Set((board.attempts ?? []).slice(-12).map(attempt => attempt.id));
  const findingKeys = new Set(board.findings.filter(finding => selected.findings.has(finding.id)).map(finding => finding.key.toLowerCase().replace(/\s+/g, " ").trim()));
  const attempts = (board.attempts ?? []).filter(attempt => request.mode !== "execute" && (recentAttempts.has(attempt.id) || findingKeys.has(attempt.hypothesis.toLowerCase().replace(/\s+/g, " ").trim())) ||
    selected.steps.has(attempt.stepId) || originIds.has(attempt.stepId) ||
    attempt.evidenceIds.some(id => selected.evidence.has(id)) ||
    (request.step?.combination && attempt.scope === request.step.combination.scope && attempt.stateVersion === request.step.combination.stateVersion));
  const projectedEvidence = board.evidence.filter(item => selected.evidence.has(item.id)).map(item => {
    const excerpt = item.excerpt?.slice(0, excerptLimit);
    if (item.excerpt && item.excerpt.length > excerptLimit) truncatedExcerpts++;
    return {
      id: item.id, path: item.pathBase === "task" ? evidencePath(item, dirname(dirname(request.runDir)), request.workspace) : item.path, sha256: item.sha256, bytes: item.bytes,
      description: item.description, stepId: item.stepId,
      ...(excerpt === undefined ? {} : { excerpt: `${excerpt}${item.excerpt!.length > excerptLimit ? "\n[excerpt truncated; inspect referenced artifact]" : ""}` }),
    };
  });

  const factIndex = boundedFactIndex(board, selected.facts, request.mode === "execute");
  const context: BlackboardContext = {
    revision: board.revision,
    project: { title: board.config.title, goal: board.config.goal, scope: board.config.scope, context: board.config.context },
    status: board.status, reason: board.reason, outcome: board.outcome,
    ...(board.planningMemory ? { planningMemory: {
      mode: board.planningMemory.mode, revision: board.planningMemory.revision,
      summary: board.planningMemory.summary.slice(0, 4000),
      truncated: board.planningMemory.truncated || board.planningMemory.summary.length > 4000,
      evidenceStatus: "unverified" as const,
      notice: "Latest committed planning summary; may be stale or incomplete. Recheck source conditions before relying on it or repeating work. This is working memory, not verified evidence or Goal completion.",
    } } : {}),
    completedSteps: board.completedSteps, noProgressCount: board.noProgressCount,
    goals: board.goals.filter(goal => selected.goals.has(goal.id)).map(projectGoal),
    facts: board.facts.filter(fact => selected.facts.has(fact.id)).map(projectFact),
    factIndex: factIndex.entries,
    attempts: attempts.map(projectAttempt),
    steps: [...steps.values()].filter(step => selected.steps.has(step.id)).map(step => projectStep(step, dirname(request.runDir))),
    findings: board.findings.filter(finding => selected.findings.has(finding.id)).map(projectFinding),
    evidence: projectedEvidence,
    hints: board.hints.map(hint => ({ id: hint.id, content: hint.content, createdAt: hint.createdAt })),
    stepOrigins,
    projection: {
      mode: request.mode,
      omitted: {
        goals: board.goals.filter(item => !selected.goals.has(item.id)).length,
        facts: board.facts.filter(item => !selected.facts.has(item.id)).length,
        steps: board.steps.filter(item => !selected.steps.has(item.id)).length,
        findings: board.findings.filter(item => !selected.findings.has(item.id)).length,
        evidence: board.evidence.filter(item => !selected.evidence.has(item.id)).length,
        hints: 0,
      },
      originStepCount: stepOrigins.length, truncatedExcerpts,
      unavailableReferences: { goals: [...unavailable.goals], facts: [...unavailable.facts], steps: [...unavailable.steps], evidence: [...unavailable.evidence] },
      stepReviews: pendingStepReviews({ ...board, steps: [...steps.values()] }).filter(review => selected.steps.has(review.stepId)),
      omittedAttempts: (board.attempts ?? []).length - attempts.length,
      omittedFactIndex: factIndex.omitted,
      history: { facts: "xloom://history?kind=fact", attempts: "xloom://history?kind=attempt" },
      notice,
    },
  };
  const findingContext = projectFindingContext({ ...board, steps: [...steps.values()] }, context, dirname(dirname(request.runDir)), request.workspace);
  if (findingContext) context.findingContext = findingContext;
  return context;
}
