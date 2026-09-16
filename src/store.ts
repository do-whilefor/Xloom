import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureProject, evidencePath } from "./paths.js";
import { taskDirectory } from "./workspace.js";
import { decisionSchema, executionSchema, projectConfigSchema, usageSchema } from "./schema.js";
import { normalizeExecutionInput } from "./loop/execution-input.js";
import { attemptKeys, legacyProgressMarkers } from "./loop/attempts.js";
import { assertGoalSatisfactionFacts, assertRootGoalUpdate, assertSatisfiedRoot, inspectGoalDeclarations } from "./loop/goals.js";
import { findingReviewErrors } from "./loop/reviews.js";
import { invalidateObservationReviews } from "./observations/changes.js";
import { evidenceNavigationRecords } from "./loop/finding-context.js";
import { applyWikiPages, type WikiPageProposal } from "./wiki/model.js";
import { writeWiki } from "./wiki/projection.js";
import { isWikiDerived } from "./wiki/format.js";
import type { MaterialDelivery } from "./wiki/materials.js";
import { applyKnowledge } from "./knowledge/model.js";
import { applyGapDecision, applyGapRecords, gapQueue } from "./knowledge/gaps.js";
import { assessCvss, cvssIssues } from "./scoring/cvss.js";
import type { BoardSnapshot, Decision, Evidence, Execution, Mode, OuterLoopTrigger, Outcome, ProjectConfig, RunStatus, Step, Usage } from "./types.js";
import type { ExecutionRefs } from "./types.js";
import { addUsage, cacheInput } from "./usage.js";

export const marker = "<!-- xloom generated blackboard; SQLite is authoritative -->";
const zeroUsage = (): Usage => ({ input: 0, output: 0, cost: 0 });
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
const union = <T>(...lists: T[][]): T[] => [...new Set(lists.flat())];
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const assert: (test: unknown, message: string) => asserts test = (test, message) => { if (!test) throw new Error(message); };
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export interface StoredRun { id: string; mode: Mode; stepId: string | null; status: string; startedAt: number; finishedAt: number | null }

/** Single local writer. Events and the current graph are committed in one SQLite transaction. */
export class BlackboardStore {
  readonly workspace: string;
  readonly dataDir: string;
  readonly projectionPath: string;
  projectionError: string | null = null;
  wikiProjectionError: string | null = null;
  private db!: DatabaseSync;
  private lockPath: string;
  private lockToken = randomUUID();
  private closed = false;

  constructor(workspace: string, config: ProjectConfig, options: { taskId?: string } = {}) {
    this.workspace = realpathSync(workspace);
    assert(options.taskId === undefined || /^[a-zA-Z0-9_-]{1,100}$/.test(options.taskId), "Invalid task ID.");
    ensureProject(this.workspace);
    this.dataDir = taskDirectory(this.workspace, options.taskId);
    this.projectionPath = path.join(this.dataDir, "blackboard.md");
    this.lockPath = path.join(this.dataDir, "controller.lock");
    config = projectConfigSchema.parse(config);
    mkdirSync(this.dataDir, { recursive: true });
    this.acquireLock();
    try {
      this.db = new DatabaseSync(path.join(this.dataDir, "blackboard.sqlite"));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, stepId TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER);
        CREATE TABLE IF NOT EXISTS run_progress (runId TEXT PRIMARY KEY, usage TEXT NOT NULL, progressed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS execution_checkpoints (runId TEXT NOT NULL, checkpointId TEXT NOT NULL, payloadHash TEXT NOT NULL, PRIMARY KEY(runId, checkpointId));
        CREATE TABLE IF NOT EXISTS material_receipts (key TEXT PRIMARY KEY, signature TEXT NOT NULL, runId TEXT NOT NULL);`);
      const old = this.db.prepare("SELECT value FROM board WHERE id=1").get();
      if (!old) {
        const board: BoardSnapshot = { revision: 0, config, status: "idle", outcome: null, reason: "Ready",
          goals: [{ id: "G0", description: config.goal, parentId: null, status: "active", factIds: [] }],
          facts: [], steps: [], evidence: [], findings: [], hints: [], usage: zeroUsage(),
          completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1, elapsedMs: 0 };
        this.db.prepare("INSERT INTO board VALUES (1, ?)").run(JSON.stringify(board));
        this.event("initialized", { version: 1 });
      } else {
        const previous = this.snapshot();
        assert(previous.config.goal === config.goal && previous.config.scope === config.scope,
          "Existing blackboard belongs to a different goal/scope. Use a new workspace for a new task.");
        this.recover();
        this.recoverLegacyGoal();
        if (JSON.stringify(this.snapshot().config) !== JSON.stringify(config)) this.mutate("config_updated", {}, board => { board.config = config; });
      }
      this.project();
    } catch (error) {
      this.db?.close();
      this.releaseLock();
      throw error;
    }
  }

  private acquireLock(): void {
    try {
      const fd = openSync(this.lockPath, "wx");
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken })); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: { pid: number };
      try { previous = JSON.parse(readFileSync(this.lockPath, "utf8")); } catch {
        throw new Error(`Unreadable controller lock: ${this.lockPath}. Check for an active process before manually removing it.`);
      }
      assert(Number.isInteger(previous.pid) && previous.pid > 0, "Invalid controller lock; manual inspection required.");
      try { process.kill(previous.pid, 0); } catch (checkError) {
        if ((checkError as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(this.lockPath); this.acquireLock(); return; }
      }
      throw new Error(`Another controller owns this workspace (PID ${previous.pid}).`);
    }
  }

  private releaseLock(): void {
    if (!existsSync(this.lockPath)) return;
    try { if (JSON.parse(readFileSync(this.lockPath, "utf8")).token === this.lockToken) unlinkSync(this.lockPath); } catch { /* Preserve an unknown lock. */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.releaseLock();
  }

  snapshot(): BoardSnapshot { return JSON.parse(String(this.db.prepare("SELECT value FROM board WHERE id=1").get()!.value)); }
  materialReceipts(): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT key,signature FROM material_receipts").all() as { key: string; signature: string }[]).map(row => [row.key, row.signature]));
  }
  events(): { seq: number; at: string; kind: string; payload: string }[] { return this.db.prepare("SELECT * FROM events ORDER BY seq").all() as never; }
  runs(): StoredRun[] { return this.db.prepare("SELECT * FROM runs ORDER BY startedAt").all() as never; }
  private event(kind: string, payload: unknown): void { this.db.prepare("INSERT INTO events (at,kind,payload) VALUES (?,?,?)").run(new Date().toISOString(), kind, JSON.stringify(payload)); }

  private mutate(kind: string, payload: unknown, change: (board: BoardSnapshot) => void): BoardSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const board = this.snapshot();
      change(board);
      board.revision++;
      this.db.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board));
      this.event(kind, payload);
      this.db.exec("COMMIT");
      this.project();
      return board;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private recover(): void {
    const active = this.runs().filter(run => run.status === "running");
    if (!active.length && this.snapshot().status !== "running") return;
    this.mutate("recovered", { interrupted: active.map(run => run.id) }, board => {
      for (const step of board.steps.filter(step => step.status === "claimed")) {
        step.status = "failed";
        step.leaseUntil = null;
        step.result = "Interrupted; side effects may have occurred. Inspect evidence and current target state before proposing any retry.";
      }
      for (const run of active) {
        const timeoutMs = board.config.limits.stepTimeoutSeconds === null ? Infinity : board.config.limits.stepTimeoutSeconds * 1000;
        board.elapsedMs = (board.elapsedMs ?? 0) + Math.max(0, Math.min(Date.now() - run.startedAt, timeoutMs));
        this.db.prepare("UPDATE runs SET status='interrupted',finishedAt=? WHERE id=?").run(Date.now(), run.id);
      }
      board.status = "paused";
      board.reason = "Recovered interrupted run. No step was replayed; token usage for an abruptly killed call may be incomplete.";
    });
  }

  private recoverLegacyGoal(): void {
    const previous = this.snapshot();
    const root = previous.goals.find(goal => goal.id === "G0" && goal.parentId === null);
    if (!root || (previous.status === "completed" ? root.status === "satisfied" : root.status === "active")) return;
    this.mutate("legacy_goal_recovered", { prior: { status: previous.status, outcome: previous.outcome, rootStatus: root.status, reason: previous.reason } }, board => {
      board.goals.find(goal => goal.id === "G0" && goal.parentId === null)!.status = "active";
      if (board.status === "completed") {
        board.status = "paused";
        board.outcome = null;
        board.reason = "Legacy completion requires a fresh Goal review. State and evidence retained; no Step was replayed. Use /start to review the whole Goal.";
      } else {
        board.reason = "Legacy inactive root Goal reopened for fresh planning. State and evidence retained; no Step was replayed. Use /start to continue.";
      }
    });
  }

  setStatus(status: RunStatus, reason: string): BoardSnapshot {
    return this.mutate("status", { status, reason }, board => {
      board.status = status; board.reason = reason;
      if (status === "running" && board.outcome === "NEED_INPUT") board.outcome = null;
    });
  }

  updateModels(models: ProjectConfig["models"]): BoardSnapshot {
    const board = this.snapshot();
    assert(board.status !== "running" && !this.runs().some(run => run.status === "running"), "Pause the task before changing models.");
    const config = projectConfigSchema.parse({ ...board.config, models });
    return this.mutate("models_updated", { models: config.models }, current => { current.config = config; });
  }

  hint(content: string): BoardSnapshot {
    assert(content.trim().length > 0 && content.length <= 12000, "Hint must contain 1–12000 characters.");
    return this.mutate("hint", { content }, board => { board.hints.push({ id: id("H"), content: content.trim(), createdAt: new Date().toISOString() }); });
  }

  beginRun(runId: string, mode: Mode, stepId?: string, trigger?: OuterLoopTrigger): BoardSnapshot {
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(runId), "Invalid run ID.");
    return this.mutate("run_started", { runId, mode, stepId, trigger }, board => {
      assert(board.status === "running", "Controller is not running.");
      assert(!this.runs().some(run => run.status === "running"), "A run is already active.");
      if (mode === "execute") {
        const step = board.steps.find(item => item.id === stepId);
        assert(step && step.status === "ready", "Step is not ready.");
        step.status = "claimed"; step.attempts++; step.runId = runId;
        step.leaseUntil = board.config.limits.stepTimeoutSeconds === null ? null : Date.now() + board.config.limits.stepTimeoutSeconds * 1000;
      } else assert(!stepId, "Only Execute may claim a step.");
      this.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,NULL)").run(runId, mode, stepId ?? null, "running", Date.now());
      this.db.prepare("INSERT INTO run_progress (runId,usage,progressed) VALUES (?,?,0)").run(runId, JSON.stringify(zeroUsage()));
    });
  }

  private accountedRun(runId: string): { usage: Usage; progressed: boolean } {
    const value = this.db.prepare("SELECT usage,progressed FROM run_progress WHERE runId=?").get(runId);
    return value ? { usage: JSON.parse(String(value.usage)), progressed: Boolean(value.progressed) } : { usage: zeroUsage(), progressed: false };
  }

  private accountUsage(board: BoardSnapshot, runId: string, cumulativeUsage: Usage, strict = false): void {
    const current = this.accountedRun(runId);
    if (strict) assert(cumulativeUsage.input >= current.usage.input && cumulativeUsage.output >= current.usage.output && cumulativeUsage.cost + Number.EPSILON >= current.usage.cost,
      "Checkpoint usage must be cumulative and nondecreasing.");
    const accounted: Usage = { input: 0, output: 0, cost: 0 };
    const delta: Usage = { input: 0, output: 0, cost: 0 };
    for (const field of ["input", "output", "cost"] as const) {
      accounted[field] = Math.max(current.usage[field], cumulativeUsage[field]);
      delta[field] = accounted[field] - current.usage[field];
    }
    if (current.usage.cacheRead !== undefined || cumulativeUsage.cacheRead !== undefined) {
      if (strict) assert((cumulativeUsage.cacheRead ?? 0) >= (current.usage.cacheRead ?? 0)
        && cacheInput(cumulativeUsage) >= cacheInput(current.usage), "Checkpoint cache usage must be cumulative and nondecreasing.");
      accounted.cacheRead = Math.max(current.usage.cacheRead ?? 0, cumulativeUsage.cacheRead ?? 0);
      accounted.cacheInput = Math.max(cacheInput(current.usage), cacheInput(cumulativeUsage));
      delta.cacheRead = accounted.cacheRead - (current.usage.cacheRead ?? 0);
      delta.cacheInput = accounted.cacheInput - cacheInput(current.usage);
    }
    addUsage(board.usage, delta);
    this.db.prepare("INSERT INTO run_progress (runId,usage,progressed) VALUES (?,?,?) ON CONFLICT(runId) DO UPDATE SET usage=excluded.usage")
      .run(runId, JSON.stringify(accounted), Number(current.progressed));
  }

  private finishRun(board: BoardSnapshot, runId: string, usage: Usage, status: string): StoredRun {
    usage = usageSchema.parse(usage);
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as unknown as StoredRun | undefined;
    assert(run?.status === "running", "Run is not active or was already committed.");
    this.accountUsage(board, runId, usage);
    board.elapsedMs = (board.elapsedMs ?? 0) + Math.max(0, Date.now() - run.startedAt);
    this.db.prepare("UPDATE runs SET status=?,finishedAt=? WHERE id=?").run(status, Date.now(), runId);
    return run;
  }

  failRun(runId: string, reason: string, usage = zeroUsage(), cancelled = false): BoardSnapshot {
    return this.mutate("run_failed", { runId, reason, cancelled }, board => {
      const run = this.finishRun(board, runId, usage, cancelled ? "cancelled" : "failed");
      if (run.stepId) {
        const step = board.steps.find(item => item.id === run.stepId)!;
        step.status = "failed"; step.leaseUntil = null; step.result = `${reason} Side effects may have occurred; do not replay blindly.`;
      }
      if (board.status === "running") { board.status = cancelled ? "paused" : "error"; board.reason = reason; }
    });
  }

  applyDecision(runId: string, input: unknown, usage: Usage, delivery?: Pick<MaterialDelivery, "boardRevision" | "deferredCount"> & { items: { key: string; signature: string }[] }): BoardSnapshot {
    const decision: Decision = decisionSchema.parse(input);
    return this.mutate("decision", { runId, decision }, board => {
      const run = this.finishRun(board, runId, usage, "completed");
      assert(run.mode === "decide" || run.mode === "metacog", "Wrong run channel.");
      const factsExist = (ids: string[]) => assert(ids.every(ref => board.facts.some(fact => fact.id === ref)), "Unknown fact reference.");
      const declarations = inspectGoalDeclarations(board.goals, decision.goals);
      assert(declarations.errors.length === 0, declarations.errors.join("; "));
      board.goals.push(...declarations.additions);
      const priorSteps = new Set(board.steps.map(step => step.id));
      for (const update of decision.updateSteps ?? []) {
        const step = board.steps.find(item => item.id === update.id);
        assert(step, `Unknown Step reference: ${update.id}. Copy an exact committed Step ID.`);
        assert(step.status === "ready", `Only ready steps may be changed. Step ${step.id} has status ${step.status}.`);
        if (update.action === "abandon") { step.status = "abandoned"; step.result = update.reason; }
        else { assert(update.priority !== undefined, "Prioritize requires priority."); step.priority = update.priority; }
      }
      for (const update of decision.updateGoals ?? []) {
        const goal = board.goals.find(item => item.id === update.id);
        assert(goal?.status === "active", "Unknown or inactive goal.");
        if (goal.id === "G0") {
          assertRootGoalUpdate(update, decision.conclusion, run.mode);
        }
        factsExist(update.factIds);
        assertGoalSatisfactionFacts(update);
        assert(!board.steps.some(step => step.goalId === goal.id && ["ready", "claimed"].includes(step.status)), "Resolve a goal's pending steps first.");
        assert(!board.goals.some(child => child.parentId === goal.id && child.status === "active"), "Resolve active child goals first.");
        goal.status = update.status; goal.factIds = update.factIds;
      }
      for (const proposal of decision.steps ?? []) {
        assert(board.goals.some(goal => goal.id === proposal.goalId && goal.status === "active"), "Step requires an active goal.");
        factsExist(proposal.from);
        if (proposal.combination) {
          factsExist(proposal.combination.requires);
          factsExist(proposal.combination.counterEvidence ?? []);
          // Requirements already declare causal inputs. Persist their complete, validated
          // union in both the Step and decision audit, without inventing or dropping facts.
          proposal.from = union(proposal.from, proposal.combination.requires);
        }
        const conditions = (step: Pick<Step, "combination">) => step.combination ? JSON.stringify([step.combination.scope, step.combination.stateVersion, [...step.combination.requires].sort(), [...step.combination.missing].sort(), step.combination.expectedCapability, [...(step.combination.counterEvidence ?? [])].sort()]) : "";
        // Selecting different guidance alone does not create a new experiment.
        const equivalent = board.steps.some(step => step.goalId === proposal.goalId && normalize(step.description) === normalize(proposal.description) && JSON.stringify([...step.from].sort()) === JSON.stringify([...proposal.from].sort()) && conditions(step) === conditions(proposal));
        assert(!equivalent || !proposal.revisits?.length, "A gap revisit must change the experiment or its Fact inputs; do not replay an old Step.");
        if (!equivalent) board.steps.push({ ...proposal, id: id("S"), status: "ready", attempts: 0, runId: null, leaseUntil: null });
      }
      applyGapDecision(board, decision, board.steps.filter(step => !priorSteps.has(step.id)), ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!));
      for (const [index, review] of (decision.reviews ?? []).entries()) {
        const finding = board.findings.find(item => item.id === review.findingId);
        assert(finding, "Unknown finding in review.");
        const errors = findingReviewErrors(finding, review, `reviews[${index}]`);
        assert(errors.length === 0, errors.join("; "));
        if (review.status === "impact_verified") {
          assert(review.pocEvidenceId && finding.evidenceIds.includes(review.pocEvidenceId), "PoC and facts must belong to the finding.");
          for (const evidenceId of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === evidenceId)!);
          finding.impact = review.impact; finding.pocEvidenceId = review.pocEvidenceId;
        } else {
          for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
        }
        finding.status = review.status; finding.rating = review.rating; finding.review = review.reason;
        // A fresh explicit Finding review is the acknowledgement, never a read receipt.
        for (const ref of finding.observationReview?.evidenceIds ?? []) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
        delete finding.observationReview;
        if (review.status === "closed") finding.next = review.reason;
      }
      for (const review of decision.cvssReviews ?? []) {
        const finding = board.findings.find(item => item.id === review.findingId);
        assert(finding, "Unknown Finding in CVSS review.");
        finding.cvss = assessCvss(board, finding, review.assessment, ref => ref, ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!), "reviewed", review.reason);
      }
      if (run.mode === "metacog") { board.lastMetaStep = board.completedSteps; board.lastMetaRevision = board.revision + 1; }
      if (delivery) {
        for (const item of delivery.items) this.db.prepare("INSERT INTO material_receipts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET signature=excluded.signature,runId=excluded.runId").run(item.key, item.signature, runId);
        if (delivery.items.length) this.event("materials_announced", { runId, boardRevision: delivery.boardRevision, stamps: delivery.items.map(({ key, signature }) => ({ key, signature })), deferredCount: delivery.deferredCount });
      }
      board.reason = decision.summary;
      board.planningMemory = { runId, mode: run.mode as "decide" | "metacog", revision: board.revision + 1,
        summary: decision.summary.slice(0, 4000), truncated: decision.summary.length > 4000 };
      if (decision.conclusion) {
        assert(run.mode === "metacog", "Completion requires a fresh metacognitive review.");
        this.validateConclusion(board, decision.conclusion.outcome);
        board.outcome = decision.conclusion.outcome;
        board.status = board.outcome === "NEED_INPUT" ? "paused" : "completed";
        board.reason = decision.conclusion.reason;
      }
    });
  }

  applyExecution(runId: string, input: unknown, usage: Usage): BoardSnapshot {
    const output: Execution = executionSchema.parse(normalizeExecutionInput(input, this.snapshot()));
    return this.mutate("execution", { runId, output }, board => {
      const run = this.finishRun(board, runId, usage, "completed");
      assert(run.mode === "execute", "Wrong run channel.");
      const step = board.steps.find(item => item.id === run.stepId);
      assert(step?.status === "claimed" && step.runId === runId, "Step claim does not match run.");
      const records = this.applyExecutionRecords(board, runId, step, output);
      const progress = records.progress || this.accountedRun(runId).progressed;
      step.status = output.result === "blocked" ? "blocked" : progress ? "done" : "no_progress";
      step.result = output.summary; step.leaseUntil = null;
      board.completedSteps++; board.noProgressCount = progress ? 0 : board.noProgressCount + 1;
      board.reason = output.summary;
      applyWikiPages(board, records.wikiPages, ref => ref, ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!));
    });
  }

  /** Commit durable observations without releasing the current Step or replaying its tools. */
  applyExecutionCheckpoint(runId: string, checkpointId: string, input: unknown, cumulativeUsage: Usage, refs?: Partial<ExecutionRefs>): BoardSnapshot {
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(checkpointId), "Invalid checkpoint ID.");
    const output: Execution = executionSchema.parse(normalizeExecutionInput(input, this.snapshot()));
    cumulativeUsage = usageSchema.parse(cumulativeUsage);
    const payloadHash = hash(Buffer.from(JSON.stringify(output)));
    const previous = this.db.prepare("SELECT payloadHash FROM execution_checkpoints WHERE runId=? AND checkpointId=?").get(runId, checkpointId);
    if (previous) {
      assert(previous.payloadHash === payloadHash, "Checkpoint ID already committed with different content.");
      const event = this.db.prepare("SELECT payload FROM events WHERE kind='execution_checkpoint' AND json_extract(payload, '$.runId')=? AND json_extract(payload, '$.checkpointId')=? ORDER BY seq DESC LIMIT 1").get(runId, checkpointId);
      if (refs && event) Object.assign(refs, JSON.parse(String(event.payload)).refs);
      return this.snapshot();
    }
    const payload = { runId, checkpointId, output, refs: undefined as ExecutionRefs | undefined };
    const committed = this.mutate("execution_checkpoint", payload, board => {
      const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as unknown as StoredRun | undefined;
      assert(run?.status === "running", "Run is not active or was already committed.");
      assert(run.mode === "execute", "Wrong run channel.");
      const step = board.steps.find(item => item.id === run.stepId);
      assert(step?.status === "claimed" && step.runId === runId, "Step claim does not match run.");
      this.accountUsage(board, runId, cumulativeUsage, true);
      const records = this.applyExecutionRecords(board, runId, step, output);
      payload.refs = records.refs;
      if (records.progress) {
        this.db.prepare("UPDATE run_progress SET progressed=1 WHERE runId=?").run(runId);
        board.noProgressCount = 0;
      }
      board.reason = output.summary;
      applyWikiPages(board, records.wikiPages, ref => ref, ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!));
      this.db.prepare("INSERT INTO execution_checkpoints VALUES (?,?,?)").run(runId, checkpointId, payloadHash);
    });
    if (refs) Object.assign(refs, payload.refs);
    return committed;
  }

  private applyExecutionRecords(board: BoardSnapshot, runId: string, step: Step, output: Execution): { progress: boolean; wikiPages: WikiPageProposal[]; refs: ExecutionRefs } {
      const previous = { ...board, facts: [...board.facts], evidence: [...board.evidence], attempts: board.attempts?.map(item => ({ ...item, evidenceIds: [...item.evidenceIds] })) };
      const before = legacyProgressMarkers(board);
      const evidenceMap = new Map<string, string>();
      const factMap = new Map<string, string>();
      let artifactBytes = 0;
      for (const proposal of output.evidence ?? []) {
        assert(!evidenceMap.has(proposal.ref) && !board.evidence.some(item => item.id === proposal.ref), "Duplicate or ambiguous evidence ref.");
        const evidence = this.ingestEvidence(runId, step.id, proposal.path, proposal.description);
        artifactBytes += evidence.bytes;
        assert(artifactBytes <= 50 * 1024 * 1024, "A result may attach at most 50 MiB of evidence.");
        const existing = board.evidence.find(item => item.sha256 === evidence.sha256);
        if (!existing) board.evidence.push(evidence);
        evidenceMap.set(proposal.ref, existing?.id ?? evidence.id);
      }
      const resolveEvidence = (refs: string[]) => union(refs.map(ref => {
        const resolved = evidenceMap.get(ref) ?? ref;
        const evidence = board.evidence.find(item => item.id === resolved);
        assert(evidence, `Unknown evidence reference: ${ref}`);
        this.verifyEvidence(evidence);
        return resolved;
      }));
      for (const proposal of output.facts ?? []) {
        assert(!factMap.has(proposal.ref) && !board.facts.some(item => item.id === proposal.ref), "Duplicate or ambiguous fact ref.");
        const evidenceIds = resolveEvidence(proposal.evidenceRefs);
        assert(evidenceIds.length > 0, "Facts require original evidence references; unsupported claims belong in leads.");
        if (proposal.supersedes) assert(board.facts.some(item => item.id === proposal.supersedes), "Unknown superseded fact.");
        // Facts inherit prerequisites and conditions from their producing Step.
        // Identical wording/bytes in another Step must not discard that origin.
        const existing = board.facts.find(item => item.stepId === step.id && normalize(item.description) === normalize(proposal.description)
          && JSON.stringify([...item.evidenceIds].sort()) === JSON.stringify([...evidenceIds].sort()) && item.supersedes === proposal.supersedes);
        const factId = existing?.id ?? id("F");
        if (!existing) board.facts.push({ id: factId, description: proposal.description, stepId: step.id, evidenceIds, ...(proposal.supersedes ? { supersedes: proposal.supersedes } : {}) });
        factMap.set(proposal.ref, factId);
      }
      for (const proposal of output.findings ?? []) {
        const key = normalize(proposal.key);
        const explicitEvidenceIds = resolveEvidence(proposal.evidenceRefs);
        const factIds = union(proposal.factRefs.map(ref => {
          const resolved = factMap.get(ref) ?? ref;
          assert(board.facts.some(item => item.id === resolved), `Unknown fact reference: ${ref}`); return resolved;
        }));
        // Referencing a fact also attaches its original evidence. Verify inherited
        // archives just like explicit references, including facts from earlier runs.
        const evidenceIds = union(explicitEvidenceIds, resolveEvidence(factIds.flatMap(ref => board.facts.find(item => item.id === ref)!.evidenceIds)));
        if (proposal.status === "technical_hit") assert(evidenceIds.length > 0 && factIds.length > 0, "A technical hit requires evidence-backed facts.");
        const pocEvidenceId = proposal.pocEvidenceRef ? resolveEvidence([proposal.pocEvidenceRef])[0] : undefined;
        if (pocEvidenceId) assert(evidenceIds.includes(pocEvidenceId), "PoC evidence must be attached to this finding.");
        let finding = board.findings.find(item => item.key === key);
        if (finding) {
          assert(proposal.target === undefined || normalize(finding.target) === normalize(proposal.target),
            `A finding key cannot be reused for a different target: key=${JSON.stringify(key)}, committed target=${JSON.stringify(finding.target)}. To update this finding, omit target or copy its committed value; describe new observations in facts/next. Use a new key only for a distinct hypothesis or target.`);
          finding.evidenceIds = union(finding.evidenceIds, evidenceIds); finding.factIds = union(finding.factIds, factIds);
          finding.status = finding.status === "technical_hit" && proposal.status === "lead" ? "technical_hit" : proposal.status;
          finding.rating = "unrated"; finding.next = proposal.next; delete finding.review;
          if (proposal.impact) finding.impact = proposal.impact;
          if (pocEvidenceId) finding.pocEvidenceId = pocEvidenceId;
        } else {
          assert(proposal.target !== undefined, `New finding key ${JSON.stringify(key)} requires target. To update an existing finding, copy its exact key.`);
          finding = { id: id("V"), key, target: proposal.target, title: proposal.title, status: proposal.status, rating: "unrated", evidenceIds, factIds, next: proposal.next,
            ...(proposal.impact ? { impact: proposal.impact } : {}), ...(pocEvidenceId ? { pocEvidenceId } : {}) };
          board.findings.push(finding);
        }
        if (finding.cvss) { finding.cvss.status = "proposed"; delete finding.cvss.reviewReason; }
      }
      let attemptProgress = false;
      for (const proposal of output.attempts ?? []) {
        const evidenceIds = resolveEvidence(proposal.evidenceRefs);
        assert(evidenceIds.length > 0, "Attempts require original evidence references.");
        const keys = attemptKeys(proposal);
        const attempts = board.attempts ??= [];
        const knownOutcome = attempts.some(item => item.outcomeKey === keys.outcomeKey);
        const existing = attempts.find(item => item.outcomeKey === keys.outcomeKey && item.observation === proposal.observation);
        if (existing) existing.evidenceIds = union(existing.evidenceIds, evidenceIds);
        else {
          const { evidenceRefs: _localRefs, ...attempt } = proposal;
          attempts.push({ ...attempt, ...keys, id: id("A"), runId, stepId: step.id, evidenceIds });
          if (!knownOutcome && (proposal.outcome === "supports" || proposal.outcome === "refutes")) attemptProgress = true;
        }
      }
      invalidateObservationReviews(previous, board);
      for (const proposal of output.findings ?? []) if (proposal.cvss) {
        const finding = board.findings.find(item => item.key === normalize(proposal.key))!;
        finding.cvss = assessCvss(board, finding, proposal.cvss, ref => factMap.get(ref) ?? ref, ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!), "proposed");
      }
      applyKnowledge(board, output, ref => factMap.get(ref) ?? ref, ref => this.verifyEvidence(board.evidence.find(item => item.id === ref)!));
      applyGapRecords(board, step, output, ref => ({ kind: ref.kind, id: ref.kind === "fact" ? factMap.get(ref.id) ?? ref.id : ref.kind === "evidence" ? evidenceMap.get(ref.id) ?? ref.id : ref.id }));
      const wikiPages = (output.wikiPages ?? []).map(page => ({ ...page, blocks: page.blocks?.map(block => ({ ...block,
        sources: block.sources.map(ref => ({ kind: ref.kind, id: ref.kind === "fact" ? factMap.get(ref.id) ?? ref.id : ref.kind === "evidence" ? evidenceMap.get(ref.id) ?? ref.id : ref.id })),
      })) }));
      return { progress: output.attempts?.length ? attemptProgress : [...legacyProgressMarkers(board)].some(marker => !before.has(marker)), wikiPages,
        refs: { facts: Object.fromEntries(factMap), evidence: Object.fromEntries(evidenceMap) } };
  }

  private ingestEvidence(runId: string, stepId: string, source: string, description: string): Evidence {
    const artifactDir = realpathSync(path.join(this.dataDir, "runs", runId, "artifacts"));
    const candidate = path.isAbsolute(source) ? source : path.resolve(artifactDir, source);
    const canonical = realpathSync(candidate);
    assert(inside(artifactDir, canonical), "Evidence must be a regular file inside this run's artifacts directory.");
    assert(statSync(canonical).isFile() && statSync(canonical).size <= 10 * 1024 * 1024, "Evidence must be a regular file at most 10 MiB.");
    const data = readFileSync(canonical);
    assert(!isWikiDerived(data.toString("utf8")), "Generated Wiki/RAG/audit materials are derived explanations, not original evidence. Reference their underlying Facts/Evidence instead.");
    // Empty stdout/stderr and response bodies are valid originals; archive their exact bytes.
    assert(data.length <= 10 * 1024 * 1024, "Evidence must contain at most 10 MiB.");
    const sha256 = hash(data);
    const targetDir = path.join(this.dataDir, "evidence");
    mkdirSync(targetDir, { recursive: true });
    const destination = path.join(targetDir, `${sha256}.bin`);
    if (!existsSync(destination)) writeFileSync(destination, data, { flag: "wx" });
    else assert(hash(readFileSync(destination)) === sha256, "Evidence archive integrity failure.");
    const text = data.subarray(0, 4096).toString("utf8");
    const excerpt = text.includes("\u0000") ? "[binary artifact; inspect the referenced file]" : text + (data.length > 4096 ? "\n[truncated: inspect the referenced artifact]" : "");
    return { id: id("E"), path: path.relative(this.dataDir, destination).replaceAll("\\", "/"), pathBase: "task", sha256, bytes: data.length, description, runId, stepId, excerpt };
  }

  verifyEvidence(evidence: Evidence): void {
    assert(evidence, "Evidence not found.");
    const file = realpathSync(evidencePath(evidence, this.dataDir, this.workspace));
    assert(inside(realpathSync(path.join(this.dataDir, "evidence")), file), "Evidence escaped archive.");
    const data = readFileSync(file);
    assert(data.length === evidence.bytes && hash(data) === evidence.sha256, `Evidence changed: ${evidence.id}`);
  }

  private validateConclusion(board: BoardSnapshot, outcome: Outcome): void {
    const open = board.findings.filter(item => ["lead", "technical_hit"].includes(item.status));
    if (outcome === "NEED_INPUT") {
      assert(open.length > 0 && open.every(item => item.next.trim()), "NEED_INPUT requires an unresolved lead/hit and a specific missing input recorded in next.");
      return;
    }
    assert(!board.steps.some(step => ["ready", "claimed"].includes(step.status)), "Pending steps must be completed or explicitly abandoned before conclusion.");
    assert(!board.findings.some(finding => finding.observationReview), "Changed observations require a fresh Finding review before conclusion.");
    assert(board.completedSteps > 0, "Cannot conclude before execution.");
    const root = board.goals.find(goal => goal.id === "G0" && goal.parentId === null);
    assertSatisfiedRoot(root);
    assert(!board.goals.some(goal => goal.id !== "G0" && goal.status === "active"), "Resolve all active child goals before final completion.");
    assert(root.factIds.length > 0, "Root goal completion requires evidence-backed facts.");
    for (const factId of root.factIds) {
      const fact = board.facts.find(item => item.id === factId);
      assert(fact && fact.evidenceIds.length > 0, "Root goal completion requires valid evidence-backed facts.");
      for (const evidenceId of fact.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === evidenceId)!);
    }
    if (outcome === "VULN_FOUND") {
      const reportable = board.findings.filter(item => item.status === "impact_verified" && ["P1", "P2", "P3"].includes(item.rating));
      assert(reportable.length > 0, "VULN_FOUND requires verified impact and a reproducible PoC.");
      for (const finding of reportable) { assert(finding.pocEvidenceId && finding.review && finding.impact, "Finding review is incomplete."); for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!); }
    } else if (outcome === "NOT_REPRODUCED") {
      assert(board.findings.length > 0 && board.findings.every(item => item.status === "closed" && item.rating === "unrated"), "NOT_REPRODUCED requires reasonably validated, closed hypotheses.");
      for (const finding of board.findings) for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
    } else {
      assert(open.length === 0 && board.findings.some(item => item.status === "impact_verified" && item.rating === "info") && board.findings.every(item => item.status === "closed" || item.rating === "info"), "LOW_ROI requires validated info-only impact, with no unresolved findings.");
      for (const finding of board.findings) for (const ref of finding.evidenceIds) this.verifyEvidence(board.evidence.find(item => item.id === ref)!);
    }
  }

  private project(): void {
    try {
      const stateDir = path.dirname(this.projectionPath);
      mkdirSync(stateDir, { recursive: true });
      const file = this.projectionPath;
      assert(!existsSync(file) || readFileSync(file, "utf8").startsWith(marker), "Preserving existing state/blackboard.md; not an xloom-generated view.");
      const board = this.snapshot();
      const temporary = `${file}.${this.lockToken}.tmp`;
      writeFileSync(temporary, renderBlackboard(board, this.dataDir, this.workspace), "utf8");
      renameSync(temporary, file);
      this.projectionError = null;
    } catch (error) { this.projectionError = (error as Error).message; }
    try { writeWiki(this.snapshot(), this.dataDir, this.workspace); this.wikiProjectionError = null; }
    catch (error) { this.wikiProjectionError = (error as Error).message; }
  }
}

export function renderBlackboard(board: BoardSnapshot, dataDir: string, workspace: string): string {
  const rows = [marker, "# xloom blackboard", "", `Revision: ${board.revision} · ${board.status} · ${board.outcome ?? "unrated / in progress"}`, "", board.reason, "", "## Goals", "", ...board.goals.map(item => `- ${item.id} [${item.status}] ${item.description}`), "", "## Steps", "", ...board.steps.map(item => `- ${item.id} → ${item.goalId} [${item.status}] ${item.description}${item.methodIds?.length ? ` (methods: ${item.methodIds.join(", ")})` : ""}${item.result ? ` — ${item.result}` : ""}`), "", "## Facts", "", ...board.facts.map(item => `- ${item.id}: ${item.description} (evidence: ${item.evidenceIds.join(", ")})`), "", "## Tested hypotheses", "", "```yaml", "tested:"];
  for (const finding of board.findings) rows.push(`  - target: ${JSON.stringify(finding.target)}`, `    finding_status: ${finding.status}`, `    rating: ${finding.rating}`, `    evidence: ${JSON.stringify(finding.evidenceIds)}`, `    next: ${JSON.stringify(finding.next)}`);
  for (const finding of board.findings.filter(item => item.observationReview)) rows.push(`  - observation_finding: ${JSON.stringify(finding.id)}`, `    review_required: ${JSON.stringify(finding.observationReview)}`);
  for (const finding of board.findings.filter(item => item.cvss)) rows.push(`  - cvss_finding: ${JSON.stringify(finding.id)}`, `    assessment: ${JSON.stringify(finding.cvss)}`, `    review_issues: ${JSON.stringify(cvssIssues(board, finding))}`);
  rows.push("```", "", "## Conditional attempts", "", ...(board.attempts ?? []).map(item => `- ${item.id} [${item.outcome}] ${JSON.stringify(item.hypothesis)} · scope ${JSON.stringify(item.scope)} · identity ${JSON.stringify(item.identity)} · state ${JSON.stringify(item.stateVersion)} · baseline ${JSON.stringify(item.baseline)} · variable ${JSON.stringify(item.changedVariable)}: ${JSON.stringify(item.observation)} (evidence: ${item.evidenceIds.join(", ")})`), "", "## Evidence", "", ...board.evidence.map(item => `- ${item.id}: ${evidencePath(item, dataDir, workspace)} (${item.bytes} bytes, SHA-256 ${item.sha256}) — ${item.description}`), "", "## User hints", "", ...board.hints.map(item => `- ${item.id}: ${item.content}`), "");
  if (board.findings.length) rows.push("## Evidence navigation index", "", "Registered references only; not proof of support or current applicability.", "", "```jsonl",
    ...evidenceNavigationRecords(board).map(record => JSON.stringify(record)), "```", "");
  if (board.steps.some(step => step.gaps?.length)) rows.push("## Gap review queue", "", "Candidate associations only; old Steps remain historical.", "", "```jsonl", ...gapQueue(board).map(item => JSON.stringify(item)), "```", "");
  rows.push("## Research Wiki", "", `[Wiki index](<${path.join(dataDir, "wiki", "index.md").replaceAll("\\", "/")}>) — generated navigation and sourced explanations; not original evidence.`, "");
  return rows.join("\n");
}
