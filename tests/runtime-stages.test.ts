import { taskDirectory } from "../src/workspace.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import type { BlackboardContext, ContextStep } from "../src/loop/context.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import type { ModelResolver } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent } from "../src/types.js";
import type { retrievalContext } from "../src/wiki/retrieval.js";
import type { MaterialDelivery } from "../src/wiki/materials.js";

// Only the provider stream is synthetic. Pi Agent, native tools, controller,
// checkpoint submission, evidence archiving and SQLite transactions are real.
const artifactBody = "SYNTHETIC LOCAL CHECKPOINT FIXTURE\naccount=alice; state=v1; control=allowed; changed-object=denied\n";
const privateNarration = "PRIVATE_EXECUTE_TOOL_HISTORY_DO_NOT_SHARE";
const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 2_000,
};
interface PromptData { blackboard: BlackboardContext; assignedStep?: ContextStep; workspace: string; artifacts: string; checkpointFile?: string; wiki?: { indexFile: string; authoringGuide?: string }; rag?: NonNullable<ReturnType<typeof retrievalContext>>; materials?: MaterialDelivery }
interface SeenRun { channel: string; contexts: Context[] }
const opened: { root: string; store: BlackboardStore; controller: LoopController }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of opened.splice(0)) {
    await entry.controller.waitForIdle();
    entry.store.close();
    const target = resolve(entry.root);
    if (!target.startsWith(resolve(tmpdir())) || !target.includes("xloom-runtime-stage-")) throw new Error("Unexpected checkpoint fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(stopReason === "error" ? { errorMessage: "Synthetic non-transient fixture failure after checkpoint" } : {}),
  };
}
const json = (output: Decision | Execution): AssistantMessage => message([{ type: "text", text: JSON.stringify(output) }]);
const write = (id: string, path: string, content: string): AssistantMessage => message([{ type: "toolCall", id, name: "write", arguments: { path, content } }], "toolUse");

function promptData(context: Context): PromptData {
  const user = context.messages[0];
  if (user?.role !== "user") throw new Error("Each role must start with its own user prompt");
  const text = typeof user.content === "string" ? user.content : user.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  return JSON.parse(text.split("\n").at(-1)!) as PromptData;
}

function setup(respond: (run: SeenRun, context: Context, input: PromptData) => AssistantMessage, secrets: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "xloom-runtime-stage-"));
  const config = defaultConfig("Validate synthetic local checkpoint preservation and handoff; no network target");
  config.models = { decide: { provider: "test", model: "offline-decide" }, execute: { provider: "test", model: "offline-execute" } };
  config.limits.metacogEvery = 10;
  const store = new BlackboardStore(root, config);
  const seen: SeenRun[] = [];
  const resolveModel: ModelResolver = async config => {
    const run = { channel: config.model, contexts: [] as Context[] };
    seen.push(run);
    if (seen.length > 10) throw new Error("Stage integration exceeded expected run count");
    return { model: { ...model, id: config.model }, secrets, streamFn: (_model, context) => {
      run.contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      if (run.contexts.length > 10) throw new Error("Stage integration exceeded expected model turns");
      const response = respond(run, context, promptData(context)), reason = response.stopReason;
      if (reason === "pending") throw new Error("Synthetic fixture responses must finish the model turn");
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "start", partial: response });
        if (reason === "error" || reason === "aborted") events.push({ type: "error", reason, error: response });
        else events.push({ type: "done", reason, message: response });
        events.end();
      });
      return events;
    } };
  };
  const controller = new LoopController(store, new PiRunner({ resolveModel }));
  const events: LoopEvent[] = [];
  controller.subscribe(event => events.push(event));
  opened.push({ root, store, controller });
  return { root, store, controller, seen, events };
}

function planning(input: PromptData): AssistantMessage {
  if (input.blackboard.steps.length) return json({ summary: "Inspect committed synthetic observations before planning further work" });
  return json({ summary: "Assign one synthetic file comparison", steps: [{ goalId: "G0", from: [], description: "Write fixture and submit a partial observation",
    successSignal: "Finish all requested synthetic comparisons", evidencePlan: "Preserve the generated fixture", priority: 50 }] });
}

function checkpoint(input: PromptData, id = "batch-1", yieldToDecide = false): string {
  return JSON.stringify({ id, yieldToDecide, execution: {
    summary: "Partial fixture comparison committed; remaining conditions are still unverified", result: "done",
    evidence: [{ ref: "fixture-e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic checkpoint unit-test artifact" }],
    facts: [{ ref: "fixture-f", description: "Synthetic changed object was denied for alice in state v1", evidenceRefs: ["fixture-e"] }],
  } });
}

function toolText(context: Context): string {
  const last = context.messages.at(-1);
  if (last?.role !== "toolResult") throw new Error("Expected the completed native tool result");
  return last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

function assertExactUsage(test: ReturnType<typeof setup>): void {
  const calls = test.seen.reduce((sum, run) => sum + run.contexts.length, 0);
  expect(test.controller.snapshot().usage).toEqual({ input: calls * 15, output: calls * 5, cost: 0, cacheRead: calls * 2, cacheInput: calls * 15 });
}

const fixtureGoals: NonNullable<Decision["goals"]> = [
  { id: "G2", parentId: "G0", description: "Compare independent synthetic fixture conditions" },
  { id: "G3", parentId: "G2", description: "Compare the first synthetic fixture label" },
  { id: "G4", parentId: "G2", description: "Compare the second synthetic fixture label" },
];

function seedFixtureGoals(test: ReturnType<typeof setup>): void {
  test.store.setStatus("running", "Seed existing fixture goals without model requests");
  test.store.beginRun("seed-goals", "decide");
  test.store.applyDecision("seed-goals", { summary: "Seed synthetic goals", goals: fixtureGoals }, { input: 0, output: 0, cost: 0 });
}

describe("durable Execute checkpoints through the real Pi tool loop", () => {
  it.each(["final", "checkpoint"] as const)("commits a real command's empty stderr through %s without aborting or replaying the command", async route => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      const stdout = join(input.artifacts, "stdout.txt"), stderr = join(input.artifacts, "stderr.txt"), exit = join(input.artifacts, "exit.json");
      if (run.contexts.length === 1) {
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        return message([{ type: "toolCall", id: "command-once", name: "powershell", arguments: { command:
          `& ${quote(process.execPath)} --version 1> ${quote(stdout)} 2> ${quote(stderr)}\n` +
          `[System.IO.File]::WriteAllText(${quote(exit)}, (ConvertTo-Json @{ command = 'node --version'; exitCode = $LASTEXITCODE }))`,
        } }], "toolUse");
      }
      if (run.contexts.length === 2) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "command-once", isError: false });
        expect(readFileSync(stdout, "utf8").trim()).toBe(process.version);
        expect(readFileSync(stderr)).toEqual(Buffer.alloc(0));
        expect(JSON.parse(readFileSync(exit, "utf8"))).toEqual({ command: "node --version", exitCode: 0 });
        const output: Execution = { summary: "Node version command completed with empty stderr", result: "done",
          evidence: [{ ref: "out", path: stdout, description: "Original node version stdout" },
            { ref: "err", path: stderr, description: "Original empty stderr" }, { ref: "exit", path: exit, description: "Command and exit code" }],
          facts: [{ ref: "result", description: `node --version returned ${process.version}, exit code 0 and no stderr bytes`, evidenceRefs: ["out", "err", "exit"] }],
        };
        return message([{ type: "toolCall", id: "commit-command", name: route === "final" ? "submit" : "write",
          arguments: route === "final" ? { output } : { path: input.checkpointFile!, content: { id: "empty-stderr", execution: output } },
        }], "toolUse");
      }
      expect(route).toBe("checkpoint");
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true });
      return json({ summary: "Command result already checkpointed", result: "done" });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(board.steps[0].status).toBe("done");
    expect(board.evidence).toHaveLength(3);
    const empty = board.evidence.find(item => item.bytes === 0)!;
    expect(empty).toBeDefined();
    expect(readFileSync(join(test.store.dataDir, empty.path))).toEqual(Buffer.alloc(0));
    expect(() => test.store.verifyEvidence(empty)).not.toThrow();
    expect(board.facts[0].evidenceIds).toContain(empty.id);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start" && event.runtime.toolCallId === "command-once")).toHaveLength(1);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toEqual([]);
    assertExactUsage(test);
  });

  it.each(["missing-conclusion", "need-input-with-root", "missing-root", "empty-root-facts"] as const)("repairs %s in the same Pi metacog run before committing completion", async invalid => {
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
        return json({ summary: "Recorded the bounded synthetic comparison", result: "done",
          evidence: [{ ref: "fixture", path: join(input.artifacts, "fixture.txt"), description: "Synthetic comparison original" }],
          facts: [{ ref: "observed", description: "Synthetic comparison refutes the fixture hypothesis", evidenceRefs: ["fixture"] }],
          findings: [{ key: "fixture-hypothesis", target: "local fixture", title: "Synthetic hypothesis", status: "lead", factRefs: ["observed"], evidenceRefs: ["fixture"], next: "Review the fixture bytes; reopen for a changed input" }] });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      const conclusion = { outcome: "NOT_REPRODUCED" as const, reason: "Synthetic local hypothesis checked; no live target tested" };
      if (input.blackboard.projection.mode !== "metacog") return json({ summary: "Request a fresh final review", conclusion });
      const updateGoals: Decision["updateGoals"] = [{ id: "G0", status: "satisfied", factIds: input.blackboard.facts.map(fact => fact.id), reason: "Bounded fixture comparison complete" }];
      if (run.contexts.length === 1) {
        const output: Decision = { summary: "Fresh review completed with archived comparison evidence",
          reviews: input.blackboard.findings.map(finding => ({ findingId: finding.id, status: "closed", rating: "unrated", reason: "The archived comparison refutes this synthetic hypothesis; reopen with a different input" })),
          ...(invalid !== "missing-root" ? { updateGoals: invalid === "empty-root-facts" ? [{ ...updateGoals[0]!, factIds: [] }] : updateGoals } : {}),
          ...(invalid === "missing-root" || invalid === "empty-root-facts" ? { conclusion } : invalid === "need-input-with-root" ? { conclusion: { outcome: "NEED_INPUT", reason: "Contradictory completion proposal" } as const } : {}) };
        return message([{ type: "toolCall", id: "invalid-completion", name: "submit", arguments: { output } }], "toolUse");
      }
      expect(run.contexts).toHaveLength(2);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "invalid-completion", isError: true });
      expect(toolText(context)).toContain(invalid === "missing-root" ? "root goal G0 to be satisfied" : invalid === "empty-root-facts" ? "Satisfied goals require evidence-backed facts" : "final conclusion in the same review");
      expect(toolText(context)).toContain("Rejected proposal retained in this run");
      expect(test.controller.snapshot().goals[0]!.status).toBe("active");
      const repairRoot = invalid === "missing-root" || invalid === "empty-root-facts";
      return message([{ type: "toolCall", id: "repair-completion", name: "submit", arguments: { repair: [{
        path: repairRoot ? "/updateGoals" : "/conclusion", value: repairRoot ? updateGoals : conclusion,
      }] } }], "toolUse");
    });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", goals: [{ id: "G0", status: "satisfied" }] });
    expect(test.store.runs().filter(run => run.mode === "metacog")).toEqual([expect.objectContaining({ status: "completed" })]);
    const submissions = test.events.flatMap(event => event.runtime?.type === "tool_end" && event.runtime.toolName === "submit" ? [event.runtime] : []);
    expect(submissions).toEqual([expect.objectContaining({ toolCallId: "invalid-completion", isError: true }), expect.objectContaining({ toolCallId: "repair-completion", isError: false })]);
    expect(test.events.some(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toBe(false);
    assertExactUsage(test);
  });

  it("expands deferred material cards with native read and commits their receipts with Decide", async () => {
    let expanded = false, extraPath = "";
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (run.contexts.length === 1) return write("raw", join(input.artifacts, "fixture.txt"), artifactBody);
        return json({ summary: "Many distinct sourced navigation blocks", result: "done",
          evidence: [{ ref: "e", path: join(input.artifacts, "fixture.txt"), description: "Original synthetic fixture" }],
          facts: [{ ref: "f", description: "Observed synthetic fixture", evidenceRefs: ["e"] }],
          wikiPages: [{ id: "WK-many", title: "Local material delivery", blocks: Array.from({ length: 20 }, (_, i) => ({ id: `B-${i}`, title: `Full local authored condition ${i}`,
            text: `Synthetic scoped observation ${i}; missing input remains unverified.`, sources: [{ kind: "fact" as const, id: "f" }] })) }] });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      if (expanded) { expect(input.materials!.items).toEqual([]); return json({ summary: "No new materials; keep task unresolved" }); }
      if (run.contexts.length === 1) {
        expect(input.materials!.deferredCount).toBeGreaterThan(0);
        return message([{ type: "toolCall", id: "extra-materials", name: "read", arguments: { path: input.materials!.readPath } }], "toolUse");
      }
      if (run.contexts.length === 2) {
        const extra = JSON.parse(toolText(context));
        expect(extra.deferredCount).toBe(0); expect(extra.items.length).toBe(input.materials!.deferredCount);
        expect(extra.items.every((item: any) => !input.materials!.items.some(old => old.key === item.key))).toBe(true);
        extraPath = extra.items[0].readPath;
        return message([{ type: "toolCall", id: "extra-record", name: "read", arguments: { path: extraPath } }], "toolUse");
      }
      expect(JSON.parse(toolText(context)).complete).toBe(true);
      expanded = true; return json({ summary: "Received additional source packages; still no verified completion" });
    });
    await test.controller.start();
    expect(expanded).toBe(true); expect(extraPath).toContain("xloom://record");
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(Object.keys(test.store.materialReceipts())).toHaveLength(22);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toHaveLength(0);
    assertExactUsage(test);
  });
  it("searches a committed gap's original body through native read before Decide creates a revisit", async () => {
    let replanned = false;
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (input.blackboard.completedSteps) return json({ summary: "Revisit still needs a new local fixture observation", result: "blocked" });
        if (run.contexts.length === 1) return write("original", join(input.artifacts, "fixture.txt"), artifactBody + "\ndownloadGrant LOCAL_FIXTURE; actual download remains unverified.\n");
        const submission = JSON.parse(checkpoint(input, "gap-source", true));
        submission.execution.gaps = [{ id: "gap-download", missing: "downloadGrant", why: "Download needs a grant", reopenWhen: "New grant material arrives", needs: [],
          conditions: { scope: "local fixture", identity: "alice", environment: "test", stateVersion: "v1" } }];
        return write("checkpoint-gap", input.checkpointFile!, JSON.stringify(submission));
      }
      if (!input.blackboard.completedSteps) return planning(input);
      if (replanned) {
        expect(input.materials!.items.filter(item => ["fact", "evidence"].includes(item.kind))).toEqual([]);
        return json({ summary: "New observation still required; no duplicate revisit" });
      }
      expect(input.materials!.items).toContainEqual(expect.objectContaining({ kind: "evidence", relatedGaps: [expect.objectContaining({ gapId: "gap-download", relation: "lexical" })] }));
      const question = input.rag!.questions[0]!;
      if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-question", name: "read", arguments: { path: question.readPath } }], "toolUse");
      if (run.contexts.length === 2) {
        const result = JSON.parse(toolText(context)); expect(result.answerSupport).toBe("not_assessed");
        return message([{ type: "toolCall", id: "read-original", name: "read", arguments: { path: result.originals.hits[0].readPath } }], "toolUse");
      }
      const original = JSON.parse(toolText(context)); expect(original.integrity).toBe("verified"); expect(original.text).toContain("actual download remains unverified");
      replanned = true;
      return json({ summary: "Original contains a candidate grant; schedule the remaining local check", steps: [{ goalId: "G0", from: [input.blackboard.facts[0]!.id],
        description: "Read remaining local fixture condition", successSignal: "Recorded local download result", evidencePlan: "Preserve original fixture result", priority: 80,
        revisits: [{ stepId: question.stepId, gapId: question.gapId }] }] });
    });
    await test.controller.start();
    expect(replanned).toBe(true);
    expect(test.controller.snapshot().steps).toHaveLength(2);
    expect(test.controller.snapshot().steps[1]!.revisits).toEqual([{ stepId: test.controller.snapshot().steps[0]!.id, gapId: "gap-download" }]);
    expect(test.controller.snapshot().steps[0]!.status).toBe("blocked");
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toHaveLength(0);
    expect(test.events.some(event => event.type === "materials" && event.materials?.items.some(item => item.kind === "evidence"))).toBe(true);
    expect(test.events.some(event => event.runtime?.retrievalFeedback?.includes("完整校验"))).toBe(true);
    expect(Object.keys(test.store.materialReceipts()).length).toBeGreaterThanOrEqual(3);
    assertExactUsage(test);
  });
  it("uses local organization through existing powershell and retrieves the sourced explanation in the next role", async () => {
    let reviewed = false;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome", "submit"]);
        if (run.contexts.length === 1) {
          const local = input.rag!.local!;
          return message([{ type: "toolCall", id: "local-organize", name: "powershell", arguments: {
            command: `& ${quote(local.nodeExecutable)} ${quote(local.scriptFile)} organize --task ${quote(local.taskDirectory)} --workspace ${quote(input.workspace)}`,
          } }], "toolUse");
        }
        if (run.contexts.length === 2) {
          expect(toolText(context)).toContain('"type": "organization"');
          return write("local-evidence", join(input.artifacts, "fixture.txt"), artifactBody);
        }
        return json({ summary: "Retain synthetic observation and full explanation", result: "done",
          evidence: [{ ref: "e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic local original" }],
          facts: [{ ref: "f", description: "Synthetic local checkpoint preservation fixture", evidenceRefs: ["e"] }],
          wikiPages: [{ id: "WK-retrieval", title: "Synthetic local checkpoint preservation and handoff", blocks: [{ id: "B-context", title: "Validation and remaining gap",
            text: "Synthetic local checkpoint preservation and handoff were observed in the fixture; another identity remains unverified.", sources: [{ kind: "fact", id: "f" }] }] }],
        });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      if (reviewed) return json({ summary: "No new synthetic observation" });
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "submit"]);
      expect(input.rag).not.toHaveProperty("local");
      expect(input.rag).toMatchObject({ type: "planning_navigation" });
      const card = input.materials!.items.find(item => item.kind === "block" && item.id === "B-context")!;
      expect(card).toBeDefined();
      if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-source-package", name: "read", arguments: { path: card.readPath } }], "toolUse");
      if (run.contexts.length === 2) {
        expect(toolText(context)).toContain("another identity remains unverified");
        return message([{ type: "toolCall", id: "read-rag-original", name: "read", arguments: { path: input.blackboard.evidence[0]!.path } }], "toolUse");
      }
      expect(toolText(context)).toContain(artifactBody);
      reviewed = true; return json({ summary: "Reviewed the original underlying the retrieved explanation" });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", completedSteps: 1, outcome: null });
    expect(reviewed).toBe(true); expect(board.findings).toEqual([]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolCallId)).toEqual(["local-organize", "local-evidence", "read-source-package", "read-rag-original"]);
    assertExactUsage(test);
  });

  it("recovers two reads with mixed task/run IDs through the current artifact directory without replaying writes", async () => {
    const files = ["response-25.txt", "response-26.txt"];
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome", "submit"]);
      expect(context.tools?.find(tool => tool.name === "read")?.description).toContain("prefer artifact://");
      if (run.contexts.length === 1) return message(files.map((file, index) => ({ type: "toolCall" as const, id: `write-${index}`, name: "write",
        arguments: { path: join(input.artifacts, file), content: `${artifactBody}file=${file}` } })), "toolUse");
      if (run.contexts.length === 2) {
        // Match the logged error: collapse task + runs/execute into one mixed task ID.
        const runDir = dirname(input.artifacts);
        const taskDir = dirname(dirname(runDir));
        const malformed = join(dirname(taskDir), "task-4a5e0ac9-2d88-4d32-bf1d-0735d3c3f10e", "artifacts");
        return message(files.map((file, index) => ({ type: "toolCall" as const, id: `bad-read-${index}`, name: "read",
          arguments: { path: join(malformed, file) } })), "toolUse");
      }
      if (run.contexts.length === 3) {
        const failures = context.messages.slice(-2);
        expect(failures).toHaveLength(2);
        for (const failure of failures) {
          expect(failure).toMatchObject({ role: "toolResult", toolName: "read", isError: true });
          expect(JSON.stringify(failure)).toContain("ENOENT");
          expect(JSON.stringify(failure)).toContain("artifact://");
          expect(JSON.stringify(failure)).not.toContain(artifactBody);
        }
        return message([{ type: "toolCall", id: "discover", name: "read", arguments: { path: "artifact://" } }], "toolUse");
      }
      if (run.contexts.length === 4) {
        for (const file of files) expect(toolText(context)).toContain(`[file] "${file}"`);
        return message(files.map((file, index) => ({ type: "toolCall" as const, id: `short-read-${index}`, name: "read",
          arguments: { path: `artifact://${file}` } })), "toolUse");
      }
      const results = context.messages.slice(-2);
      for (let index = 0; index < files.length; index++) {
        expect(results[index]).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
        expect(JSON.stringify(results[index])).toContain(`file=${files[index]}`);
      }
      return json({ summary: "Read exact local artifacts after correcting the path reference", result: "done",
        evidence: files.map((file, index) => ({ ref: `e${index}`, path: join(input.artifacts, file), description: "Synthetic local file" })),
        facts: [{ ref: "f", description: "Observed both synthetic file labels", evidenceRefs: ["e0", "e1"] }],
      });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(board.evidence).toHaveLength(2);
    expect(board.facts).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    const tools = test.events.flatMap(event => event.runtime?.type === "tool_end" ? [event.runtime] : []);
    // The two independent filesystem reads run in parallel; completion order
    // is not part of the artifact-recovery contract.
    expect(tools.filter(event => event.isError).map(event => event.toolCallId).sort()).toEqual(["bad-read-0", "bad-read-1"]);
    expect(tools.filter(event => event.toolName === "write")).toHaveLength(2);
    expect(tools.some(event => event.toolName === "powershell")).toBe(false);
    assertExactUsage(test);
  });

  it("authors a sourced Wiki through checkpoint and final output, then reads it in a fresh role with existing tools", async () => {
    let factId = "", reviewed = false;
    const note = (id: string, title: string) => ({ id: "WK-flow", title, blocks: [{ id: "B-context", title: "Scope and gap",
      text: "Synthetic observation only; the consumer remains unverified.", sources: [{ kind: "fact" as const, id }] }] });
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (run.contexts.length === 1) return message([{ type: "toolCall", id: "wiki-guide", name: "read", arguments: { path: input.wiki!.authoringGuide } }], "toolUse");
        if (run.contexts.length === 2) {
          expect(toolText(context)).toContain("wikiPages");
          return write("wiki-raw", join(input.artifacts, "fixture.txt"), artifactBody);
        }
        if (run.contexts.length === 3) return write("wiki-checkpoint", input.checkpointFile!, JSON.stringify({ id: "wiki-batch", execution: {
          summary: "Synthetic observation and explanation", result: "done", evidence: [{ ref: "e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic fixture" }],
          facts: [{ ref: "f", description: "Observed synthetic label", evidenceRefs: ["e"] }], wikiPages: [note("f", "Initial explanation")],
        } }));
        if (run.contexts.length === 4) {
          const checkpoint = JSON.parse(toolText(context));
          expect(checkpoint.wikiPages).toEqual([{ id: "WK-flow", revision: 1 }]);
          factId = checkpoint.facts[0].id;
          const proposal = note(factId, "Revised explanation");
          proposal.blocks.push({ ...proposal.blocks[0]!, id: "B-unsupported", sources: [{ kind: "fact", id: "F-missing" }] });
          return json({ summary: "Revision with one invalid source", result: "no_progress", wikiPages: [proposal] });
        }
        expect(context.tools).toEqual([]);
        expect(JSON.stringify(context.messages.at(-1))).toContain("wikiPages[0].blocks[1].sources[0]");
        expect(JSON.stringify(context.messages.at(-1))).not.toContain(`Unknown fact \\"${factId}`);
        return json({ summary: "Revised only the sourced explanation", result: "no_progress", wikiPages: [note(factId, "Revised explanation")] });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      if (reviewed) return json({ summary: "Retain the unverified fixture state" });
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "submit"]);
      if (run.contexts.length === 1) return message([{ type: "toolCall", id: "wiki-index", name: "read", arguments: { path: input.wiki!.indexFile } }], "toolUse");
      if (run.contexts.length === 2) {
        const file = toolText(context).match(/\(pages\/(note-[a-f0-9]+\.md)\)/)![1]!;
        return message([{ type: "toolCall", id: "wiki-note", name: "read", arguments: { path: join(dirname(input.wiki!.indexFile), "pages", file) } }], "toolUse");
      }
      expect(toolText(context)).toContain("Revised explanation");
      expect(toolText(context)).toContain("consumer remains unverified");
      reviewed = true;
      return json({ summary: "Read the sourced explanation; no impact conclusion" });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(board.wikiPages![0]).toMatchObject({ id: "WK-flow", revision: 2, history: [{ revision: 1 }] });
    expect(board.wikiPages![0]!.blocks[0]!.sources).toEqual([{ kind: "fact", id: factId }]);
    expect(board.evidence).toHaveLength(1); expect(board.facts).toHaveLength(1); expect(board.findings).toEqual([]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolCallId)).toEqual(["wiki-guide", "wiki-raw", "wiki-checkpoint", "wiki-index", "wiki-note"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    assertExactUsage(test);
  });

  it.each(["closed_rating", "lead_promotion"] as const)("repairs %s with the bad reference in one request before Store commit", async kind => {
    let corrected = false;
    const followup = "Validate the still-unverified synthetic lead";
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (input.assignedStep?.description === followup) return json({ summary: "Synthetic prerequisite remains unavailable", result: "blocked" });
        if (run.contexts.length === 1) return write("seed-review-file", join(input.artifacts, "fixture.txt"), artifactBody);
        return json({ summary: "Registered an evidenced lead, not technical validation", result: "done",
          evidence: [{ ref: "e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic fixture" }],
          facts: [{ ref: "f", description: "Synthetic partial observation", evidenceRefs: ["e"] }],
          findings: [{ key: "fixture-lead", title: "Fixture", target: "local", status: "lead", factRefs: ["f"], evidenceRefs: ["e"], next: "Validate prerequisite" }],
        });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      if (corrected) return json({ summary: "Retain recorded state; no new conclusion" });
      const finding = input.blackboard.findings[0]!;
      if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-review-file", name: "read", arguments: { path: input.blackboard.evidence[0]!.path } }], "toolUse");
      if (run.contexts.length === 3) {
        expect(context.tools).toEqual([]);
        const repair = JSON.stringify(context.messages.at(-1));
        expect(repair).toContain(kind === "closed_rating" ? "Closed findings remain unrated" : "A lead cannot skip technical validation");
        expect(repair).toContain(kind === "closed_rating" ? "reviews[0].pocEvidenceId" : "updateSteps[0].id");
        corrected = true;
        return kind === "closed_rating"
          ? json({ summary: "Evidenced closure with no impact rating", reviews: [{ findingId: finding.id, status: "closed", rating: "unrated", reason: "Synthetic denial; reopen when the prerequisite changes" }] })
          : json({ summary: "Defer impact review until technical validation", steps: [{ goalId: "G0", from: finding.factIds, description: followup, successSignal: "Technical behavior validated", evidencePlan: "Existing fixture plus missing prerequisite", priority: 1 }] });
      }
      const review = { findingId: finding.id, reason: "Synthetic review", impact: { capability: "Fixture", object: "Fixture", result: "Fixture", scope: "Local", prerequisites: "Fixture" } };
      return kind === "closed_rating"
        ? json({ summary: "Reproduce closed plus info", reviews: [{ ...review, status: "closed", rating: "info", pocEvidenceId: "E-nonexistent" }] })
        : json({ summary: "Reproduce lead directly to impact", updateSteps: [{ id: "S-truncated", action: "abandon", reason: "Fixture" }], reviews: [{ ...review, status: "impact_verified", rating: "P2", pocEvidenceId: finding.evidenceIds[0] }] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", outcome: null });
    expect(board.findings[0]).toMatchObject({ status: kind === "closed_rating" ? "closed" : "lead", rating: "unrated" });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolCallId)).toEqual(["seed-review-file", "read-review-file"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    assertExactUsage(test);
  });

  it("returns directly readable archive paths after a checkpoint outside the tool workspace", async () => {
    let archive = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("write-source", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("commit-source", input.checkpointFile!, checkpoint(input));
      if (run.contexts.length === 3) {
        archive = JSON.parse(toolText(context)).evidence[0].path;
        expect(archive.startsWith(input.workspace)).toBe(false);
        expect(readFileSync(archive, "utf8")).toBe(artifactBody);
        return message([{ type: "toolCall", id: "read-archive", name: "read", arguments: { path: archive } }], "toolUse");
      }
      expect(toolText(context)).toContain(artifactBody.trim());
      return json({ summary: "Read committed archive through the native tool", result: "done" });
    });
    await test.controller.start();
    expect(test.store.snapshot().completedSteps).toBe(1);
    expect(test.store.snapshot().evidence).toHaveLength(1);
    expect(archive).toContain("evidence");
    assertExactUsage(test);
  });

  it("recovers the logged premature evidence-array close through structured write content without replaying artifacts", async () => {
    const summary = 'Observed "quoted" labels\npath C:\\fixture\\file.txt; brackets [ ] { } remain text';
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      const submission = JSON.parse(checkpoint(input, "structured-batch"));
      submission.execution.summary = summary;
      const structured = (id: string, path: string, content: unknown) => message([{ type: "toolCall", id, name: "write", arguments: { path, content } }], "toolUse");
      if (run.contexts.length === 1) return write("artifact-once", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return structured("wrong-destination", join(input.artifacts, "object.json"), submission);
      if (run.contexts.length === 3) {
        expect(toolText(context)).toContain("only supported for checkpointFile");
        expect(existsSync(join(input.artifacts, "object.json"))).toBe(false);
        // The real failure closed evidence after each object: [{...}], {...}].
        const item = JSON.stringify(submission.execution.evidence[0]);
        return write("malformed-array", input.checkpointFile!, `{"id":"bad","execution":{"summary":"fixture","result":"done","evidence":[${item}],${item}]}}`);
      }
      if (run.contexts.length === 4) {
        expect(toolText(context)).toContain("structured object");
        expect(existsSync(input.checkpointFile!)).toBe(false);
        expect(test.store.snapshot().facts).toEqual([]);
        return structured("invalid-object", input.checkpointFile!, { id: "bad-shape", execution: { summary: "Missing result" } });
      }
      if (run.contexts.length === 5) {
        expect(toolText(context)).toContain("Checkpoint content is invalid");
        expect(existsSync(input.checkpointFile!)).toBe(false);
        return structured("structured-submit", input.checkpointFile!, submission);
      }
      expect(JSON.parse(toolText(context))).toMatchObject({ checkpoint: "structured-batch", committed: true });
      expect(JSON.parse(readFileSync(input.checkpointFile!, "utf8"))).toEqual(submission);
      if (run.contexts.length === 6) return structured("idempotent-submit", input.checkpointFile!, submission);
      return json({ summary: "Structured checkpoint retained", result: "done" });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.facts).toHaveLength(1); expect(board.evidence).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.events.filter(event => event.runtime?.type === "tool_start" && event.runtime.toolCallId === "artifact-once")).toHaveLength(1);
    assertExactUsage(test);
  });

  it.each(["json", "schema"] as const)("rejects invalid checkpoint %s before writing and preserves the previous accepted proposal through a corrected retry", async invalidKind => {
    let acceptedSource = "";
    let acceptedRevision = 0;
    let evidenceId = "";
    const invalid = invalidKind === "json" ? `{"id":"rejected","execution":{"summary":"Synthetic fixture.'
}}` : JSON.stringify({ id: "rejected", execution: { summary: "Synthetic proposal missing required result" } });
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("first-invalid", input.checkpointFile!, invalid);
      if (run.contexts.length === 3) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "first-invalid", isError: true });
        expect(toolText(context)).toContain("content");
        expect(toolText(context)).toContain("write");
        expect(existsSync(input.checkpointFile!)).toBe(false);
        expect(submit).not.toHaveBeenCalled();
        expect(test.store.snapshot()).toMatchObject({ facts: [], evidence: [] });
        return write("first-accepted", input.checkpointFile!, checkpoint(input, "accepted-1"));
      }
      if (run.contexts.length === 4) {
        expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "accepted-1" });
        expect(submit).toHaveBeenCalledTimes(1);
        acceptedSource = readFileSync(input.checkpointFile!, "utf8");
        const committed = test.store.snapshot();
        acceptedRevision = committed.revision;
        evidenceId = committed.evidence[0]!.id;
        expect(committed.facts).toHaveLength(1);
        return write("second-invalid", input.checkpointFile!, invalid);
      }
      if (run.contexts.length === 5) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "second-invalid", isError: true });
        expect(toolText(context)).toContain("content");
        expect(toolText(context)).toContain("write");
        expect(readFileSync(input.checkpointFile!, "utf8")).toBe(acceptedSource);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(test.store.snapshot()).toMatchObject({ revision: acceptedRevision, facts: [expect.objectContaining({ evidenceIds: [evidenceId] })] });
        return write("second-accepted", input.checkpointFile!, JSON.stringify({ id: "accepted-2", execution: {
          summary: "Add only a new synthetic observation after correcting the submission", result: "done", facts: [
            { ref: "new-f", description: "Synthetic fixture records both control and changed-object outcomes", evidenceRefs: [evidenceId] },
          ],
        } }));
      }
      expect(run.contexts).toHaveLength(6);
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "accepted-2" });
      expect(submit).toHaveBeenCalledTimes(2);
      return json({ summary: "Both valid checkpoints retained; no further records to submit", result: "done" });
    });
    const submit = vi.spyOn(test.store, "applyExecutionCheckpoint");
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(board.facts).toHaveLength(2);
    expect(board.evidence).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(2);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toHaveLength(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it.each([false, true])("recovers an Anthropic stream EOF after a completed write without committing its failed JSON tail (complete JSON: %s)", async completeJson => {
    const interruptedMarker = "UNCOMMITTED_INTERRUPTED_FIXTURE_RECORD";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("artifact-once", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "artifact-once", isError: false });
        return { ...message([
          { type: "thinking", thinking: "Synthetic interrupted private reasoning fixture" },
          { type: "text", text: completeJson ? JSON.stringify({ summary: interruptedMarker, result: "no_progress" })
            : `{"summary":"${interruptedMarker}","result":"done","facts":[` },
        ], "error"), errorMessage: "Anthropic stream ended before message_stop" };
      }
      expect(run.contexts).toHaveLength(3);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "artifact-once", isError: false });
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome", "submit"]);
      expect(JSON.stringify(context.messages)).not.toContain(interruptedMarker);
      expect(JSON.stringify(context.messages)).not.toContain("Anthropic stream ended before message_stop");
      expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "artifact-once")).toHaveLength(1);
      return json({ summary: "Retain the completed synthetic artifact after stream recovery", result: "done",
        evidence: [{ ref: "fixture-e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic artifact written before the interrupted stream" }],
        facts: [{ ref: "fixture-f", description: "Synthetic fixture records allowed control and denied changed-object labels", evidenceRefs: ["fixture-e"] }],
      });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(readFileSync(join(taskDirectory(test.root), board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(JSON.stringify(board)).not.toContain(interruptedMarker);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual(["artifact-once"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("Transient model failure"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(0);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("continues metacog after a thinking-only length stop using its completed read, then executes the new plan", async () => {
    let factId = "";
    let recoveredPlans = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1 && context.systemPrompt?.includes("Fresh metacognitive review")) {
          factId = input.blackboard.facts[0]!.id;
          if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-before-length", name: "read",
            arguments: { path: input.blackboard.evidence[0]!.path } }], "toolUse");
          if (run.contexts.length === 2) {
            expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "read-before-length", isError: false });
            return message([{ type: "thinking", thinking: "Synthetic interrupted reasoning fixture; final plan not yet emitted" }], "length");
          }
          expect(run.contexts).toHaveLength(3);
          expect(context.tools?.map(tool => tool.name)).toEqual(["read", "submit"]);
          expect(context.messages.at(-1)?.role).toBe("user");
          expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "read-before-length")).toHaveLength(1);
          recoveredPlans++;
          return json({ summary: "Continue from the completed synthetic comparison", steps: [{ goalId: "G0", from: [factId],
            description: "Inspect the remaining synthetic state", successSignal: "Remaining label observed", evidencePlan: "Use the archived fixture", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep).toMatchObject({ from: [factId], description: "Inspect the remaining synthetic state" });
        return json({ summary: "Remaining synthetic condition still unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "before-review-length", true));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.steps[1]).toMatchObject({ from: [factId], attempts: 1, status: "no_progress" });
    expect(recoveredPlans).toBe(1);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual([
      "fixture-write", "fixture-checkpoint", "read-before-length",
    ]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("continues Execute after a committed checkpoint and length stop without repeating tools, records or usage", async () => {
    let evidenceId = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "before-execute-length"));
      if (run.contexts.length === 3) {
        const accepted = JSON.parse(toolText(context));
        expect(accepted).toMatchObject({ checkpoint: "before-execute-length", committed: true });
        evidenceId = accepted.evidence[0].id;
        return message([{ type: "thinking", thinking: "Synthetic interrupted reasoning fixture after accepted checkpoint" }], "length");
      }
      expect(run.contexts).toHaveLength(4);
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome", "submit"]);
      expect(context.messages.at(-1)?.role).toBe("user");
      expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "fixture-checkpoint")).toHaveLength(1);
      return json({ summary: "Checkpoint retained; submit only the additional synthetic observation", result: "done", facts: [
        { ref: "additional-fact", description: "Synthetic fixture retains both the control and changed-object labels", evidenceRefs: [evidenceId] },
      ] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(board.evidence).toHaveLength(1);
    expect(board.facts).toHaveLength(2);
    expect(board.facts[1]!.evidenceIds).toEqual([evidenceId]);
    expect(readFileSync(join(taskDirectory(test.root), board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual(["fixture-write", "fixture-checkpoint"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("joins a length-truncated JSON plan with a tool-free suffix before committing and executing it", async () => {
    const prefix = '{"summary":"Assign a synthetic comparison","steps":[{"goalId":"G0","from":[],"description":"Inspect';
    const suffix = ' the split synthetic condition","successSignal":"Compare labels","evidencePlan":"Save fixture","priority":1}]}';
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        expect(input.assignedStep!.description).toBe("Inspect the split synthetic condition");
        return json({ summary: "Split plan executed; comparison remains unverified", result: "no_progress" });
      }
      if (!input.blackboard.steps.length) {
        if (run.contexts.length === 1) return message([{ type: "text", text: prefix }], "length");
        expect(run.contexts).toHaveLength(2);
        expect(context.tools).toEqual([]);
        return message([{ type: "text", text: suffix }]);
      }
      return planning(input);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ description: "Inspect the split synthetic condition", attempts: 1, status: "no_progress" });
    expect(test.seen[0]!.contexts).toHaveLength(2);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.events.filter(event => event.runtime?.type === "tool_start")).toHaveLength(0);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it.each(["decide", "metacog"] as const)("accepts an identical existing Goal in %s and executes its new Steps without a repair request", async mode => {
    let planned = false;
    let planningRequests = 0;
    const executed: string[] = [];
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        executed.push(input.assignedStep!.goalId);
        return json({ summary: "Synthetic comparison remains unverified", result: "no_progress" });
      }
      const meta = context.systemPrompt?.includes("Fresh metacognitive review") ?? false;
      if (!planned && meta === (mode === "metacog")) {
        planned = true;
        planningRequests++;
        expect(input.blackboard.goals.find(goal => goal.id === "G2")).toMatchObject({ ...fixtureGoals[0], status: "active" });
        return json({ summary: "Keep the same parent goal while assigning three fixture checks", goals: [fixtureGoals[0]!],
          steps: fixtureGoals.map((goal, index) => ({ goalId: goal.id, from: [], description: `Inspect synthetic condition ${index + 1}`,
            successSignal: "Fixture comparison observed", evidencePlan: "Preserve the synthetic comparison", priority: 50 - index })) });
      }
      return json({ summary: "Review current fixture results; no further synthetic plan" });
    });
    seedFixtureGoals(test);
    const originalGoals = test.store.snapshot().goals;
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 3, goals: originalGoals });
    expect(board.steps).toHaveLength(3);
    expect(board.steps.every(step => step.attempts === 1 && step.status === "no_progress")).toBe(true);
    expect(executed).toEqual(["G2", "G3", "G4"]);
    expect(planningRequests).toBe(1);
    expect(test.seen.every(run => run.contexts.length === 1)).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(0);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("repairs a conflicting Goal and wrong Fact together after one read, then commits and executes without overwriting the old Goal", async () => {
    let factId = "";
    let repairRequests = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1) {
          factId = input.blackboard.facts[0]!.id;
          if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-before-repair", name: "read",
            arguments: { path: input.blackboard.evidence[0]!.path } }], "toolUse");
          const repaired = run.contexts.length === 3;
          if (repaired) {
            repairRequests++;
            expect(context.tools).toEqual([]);
            const diagnostic = JSON.stringify(context.messages.at(-1));
            expect(diagnostic).toContain("G2");
            expect(diagnostic).toContain("goals[0].id");
            expect(diagnostic).toContain("steps[0].from[0]");
            expect(diagnostic).toContain("committed IDs");
            expect(diagnostic).toContain("New Goal IDs must be unused");
            expect(JSON.stringify(context.messages)).toContain("account=alice; state=v1; control=allowed; changed-object=denied");
          } else {
            expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "read-before-repair", isError: false });
          }
          const goalId = repaired ? "G5" : "G2";
          return json({ summary: "Plan a distinct fixture observation without replacing its existing parent", goals: [
            { id: goalId, parentId: "G0", description: "A different synthetic observation goal" },
          ], steps: [{ goalId, from: [repaired ? factId : "F-missing"], description: "Inspect a new synthetic fixture condition",
            successSignal: "New label comparison observed", evidencePlan: "Use the archived synthetic artifact", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep).toMatchObject({ goalId: "G5", from: [factId] });
        return json({ summary: "New synthetic condition remains unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "fact-before-conflict", true));
    });
    seedFixtureGoals(test);
    const originalGoals = test.store.snapshot().goals;
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.goals.slice(0, originalGoals.length)).toEqual(originalGoals);
    expect(board.goals).toHaveLength(originalGoals.length + 1);
    expect(board.goals.at(-1)).toMatchObject({ id: "G5", description: "A different synthetic observation goal", parentId: "G0", status: "active" });
    expect(board.steps[1]).toMatchObject({ goalId: "G5", from: [factId], attempts: 1 });
    expect(repairRequests).toBe(1);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    const toolStarts = test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : []);
    expect(toolStarts).toEqual(["fixture-write", "fixture-checkpoint", "read-before-repair"]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("retains an existing finding title and recovers a conflicting target without duplicating findings", async () => {
    let findingId = "";
    let factId = "";
    const target = "local synthetic fixture";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        const submission = JSON.parse(checkpoint(input));
        submission.execution.findings = [{ key: "fixture-lead", title: "Synthetic hypothesis", target, status: "lead",
          factRefs: ["fixture-f"], evidenceRefs: [], next: "Inspect remaining fixture state" }];
        return write("first-checkpoint", input.checkpointFile!, JSON.stringify(submission));
      }
      if (run.contexts.length === 3) {
        const accepted = JSON.parse(toolText(context));
        expect(accepted.findings).toEqual([{ id: expect.any(String), key: "fixture-lead", target }]);
        findingId = accepted.findings[0].id;
        factId = accepted.facts[0].id;
      }
      const finding = { key: "fixture-lead", status: "lead" as const,
        factRefs: [factId], evidenceRefs: [], next: "Review the observed fixture state" };
      if (run.contexts.length === 4) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
        expect(toolText(context)).toContain(`committed target=${JSON.stringify(target)}`);
        expect(toolText(context)).toContain("omit target");
        expect(test.store.snapshot().findings).toHaveLength(1);
      }
      if (run.contexts.length <= 4) return write(`update-${run.contexts.length}`, input.checkpointFile!, JSON.stringify({
        id: "batch-2", execution: { summary: "Clarify the same fixture hypothesis", result: "done",
          findings: [{ ...finding, ...(run.contexts.length === 3 ? { target: `${target} with expanded observation prose` } : {}) }] },
      }));
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "batch-2",
        findings: [{ id: findingId, key: "fixture-lead", target }] });
      return message([{ type: "text", text: JSON.stringify({ summary: "Fixture updates committed; no duplicate records", result: "done",
        findings: [{ ...finding, next: "Review final fixture observations" }] }) }]);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board.status).toBe("paused");
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ id: findingId, title: "Synthetic hypothesis", target, factIds: [factId], next: "Review final fixture observations" });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(2);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it.each(["decide", "metacog"] as const)("retains a %s combination dependency omitted from from after a Fact spelling repair", async mode => {
    let expectedFacts: string[] = [];
    let planningRequests = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        const meta = context.systemPrompt?.includes("Fresh metacognitive review");
        if (input.blackboard.completedSteps === 1 && meta === (mode === "metacog")) {
          expectedFacts = input.blackboard.facts.map(fact => fact.id);
          expect(expectedFacts).toHaveLength(2);
          planningRequests++;
          if (run.contexts.length === 2) expect(context.tools).toEqual([]);
          return json({ summary: "Check two recorded fixture conditions together", steps: [{ goalId: "G0",
            from: [run.contexts.length === 1 ? "F-misspelled" : expectedFacts[0]!],
            description: "Compare the joint fixture conditions", successSignal: "Joint label comparison observed", evidencePlan: "Use archived fixture", priority: 1,
            combination: { requires: expectedFacts, missing: ["same identity compatibility"], scope: "local fixture", stateVersion: "v1", expectedCapability: "joint fixture comparison" },
          }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep!.from).toEqual(expectedFacts);
        expect(input.assignedStep!.combination!.requires).toEqual(expectedFacts);
        return json({ summary: "Joint fixture condition remains unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "two-facts", true));
      submission.execution.facts.push({ ref: "fixture-control", description: "Synthetic control label is allowed for alice in state v1", evidenceRefs: ["fixture-e"] });
      return write("two-fact-checkpoint", input.checkpointFile!, JSON.stringify(submission));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.steps[1]!.from).toEqual(expectedFacts);
    expect(planningRequests).toBe(2); // Only the ID spelling needed a model correction.
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start")).toHaveLength(2);
    assertExactUsage(test);
  });

  it("inherits a checkpoint finding's Fact evidence and repairs a later metacog reference before SQLite commit", async () => {
    let factId = "";
    let evidenceId = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1 && context.systemPrompt?.includes("Fresh metacognitive review")) {
          factId = input.blackboard.facts[0]!.id;
          evidenceId = input.blackboard.evidence[0]!.id;
          const mistakenId = evidenceId.replace(/^E-/, "F-");
          if (run.contexts.length === 2) {
            expect(context.tools).toEqual([]);
            expect(JSON.stringify(context.messages.at(-1))).toContain(mistakenId);
          }
          return json({ summary: "Review another synthetic condition", steps: [{ goalId: "G0",
            from: [run.contexts.length === 1 ? mistakenId : factId], description: "Inspect the remaining fixture condition",
            successSignal: "Remaining label observed", evidencePlan: "Use archived fixture", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) return json({ summary: "Remaining fixture condition still unverified", result: "no_progress" });
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "inherited-finding", true));
      submission.execution.findings = [{ key: "fixture-lead", title: "Synthetic fixture hypothesis", target: "local fixture",
        status: "lead", factRefs: ["fixture-f"], evidenceRefs: [], next: "Inspect the remaining fixture condition" }];
      return write("checkpoint-write", input.checkpointFile!, JSON.stringify(submission));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board.status).toBe("paused");
    expect(board.completedSteps).toBe(2);
    expect(board.findings[0]).toMatchObject({ factIds: [factId], evidenceIds: [evidenceId] });
    expect(board.steps[1]!.from).toEqual([factId]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toEqual([]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("repairs a prose-wrapped PoC ownership error before final SQLite commit without replaying tools", async () => {
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (run.contexts.length === 1) return message([
          { type: "toolCall", id: "write-a", name: "write", arguments: { path: join(input.artifacts, "a.txt"), content: `${artifactBody}branch=A` } },
          { type: "toolCall", id: "write-b", name: "write", arguments: { path: join(input.artifacts, "b.txt"), content: `${artifactBody}branch=B` } },
        ], "toolUse");
        return json({ summary: "Saved two synthetic branches", result: "done",
          evidence: ["a", "b"].map(ref => ({ ref, path: join(input.artifacts, `${ref}.txt`), description: "Synthetic fixture only" })),
          facts: ["a", "b"].map(ref => ({ ref, description: `Synthetic branch ${ref}`, evidenceRefs: [ref] })),
          findings: ["a", "b"].map(ref => ({ key: `branch-${ref}`, target: `synthetic ${ref}`, title: `Fixture ${ref}`,
            status: "technical_hit", factRefs: [ref], evidenceRefs: [ref], next: "Review local fixture" })) });
      }
      if (!input.blackboard.completedSteps) return planning(input);
      expect(input.blackboard.projection.mode).toBe("metacog");
      if (run.contexts.length === 1) return message([
        { type: "toolCall", id: "read-a", name: "read", arguments: { path: input.blackboard.evidence[0]!.path } },
      ], "toolUse");
      const repaired = run.contexts.length === 3;
      const [a, b] = input.blackboard.findings;
      if (repaired) {
        expect(context.tools).toEqual([]);
        const repair = JSON.stringify(context.messages.at(-1));
        expect(repair).toContain("single JSON object");
        expect(repair).toContain("reviews[0].pocEvidenceId");
        expect(repair).toContain(a!.evidenceIds[0]!);
      }
      const output: Decision = { summary: "Synthetic protocol review complete",
        reviews: input.blackboard.findings.map(finding => ({ findingId: finding.id, status: "impact_verified", rating: "info",
          reason: "Validated synthetic fixture branch only", pocEvidenceId: !repaired && finding.id === a!.id ? b!.evidenceIds[0] : finding.evidenceIds[0],
          impact: { capability: "Fixture read", object: finding.target, result: "Synthetic label", scope: "Local fixture", prerequisites: "Generated data" } })),
        updateGoals: [{ id: "G0", status: "satisfied", factIds: input.blackboard.facts.map(fact => fact.id), reason: "Fixture branches reviewed" }],
        conclusion: { outcome: "LOW_ROI", reason: "Synthetic protocol test complete; no live target was tested" } };
      return repaired ? json(output) : message([{ type: "text", text: `Review completed.\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`` }]);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "completed", outcome: "LOW_ROI", completedSteps: 1 });
    expect(board.facts).toHaveLength(2);
    expect(board.evidence).toHaveLength(2);
    for (const finding of board.findings) {
      expect(finding.evidenceIds).toHaveLength(1);
      expect(finding.pocEvidenceId).toBe(finding.evidenceIds[0]);
      expect(finding.status).toBe("impact_verified");
    }
    expect(test.store.runs().map(run => [run.mode, run.status])).toEqual([
      ["decide", "completed"], ["execute", "completed"], ["metacog", "completed"],
    ]);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolCallId))
      .toEqual(["write-a", "write-b", "read-a"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    assertExactUsage(test);
  });

  it("keeps accepted facts and evidence after a later model error without counting checkpoint usage twice", async () => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      expect(input.checkpointFile).toBe(join(input.artifacts, "checkpoint.json"));
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("stage-write", input.checkpointFile!, checkpoint(input));
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "stage-write", isError: false });
      expect(JSON.parse(toolText(context))).toMatchObject({ checkpoint: "batch-1", committed: true, yielded: false });
      expect(test.controller.snapshot()).toMatchObject({ completedSteps: 0, usage: { input: 45, output: 15, cost: 0 } });
      expect(test.controller.snapshot().steps[0]?.status).toBe("claimed");
      return message([], "error");
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "error", outcome: null, completedSteps: 0 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(board.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(board.goals[0]?.status).toBe("active");
    expect(readFileSync(join(taskDirectory(test.root), board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.runs().at(-1)).toMatchObject({ mode: "execute", status: "failed" });
    assertExactUsage(test);
  });

  it.each([false, true])("finishes after an accepted checkpoint with exact cumulative usage (repeat submission: %s)", async repeated => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2 || (repeated && run.contexts.length === 3)) return write(`stage-write-${run.contexts.length}`, input.checkpointFile!, checkpoint(input));
      const accepted = JSON.parse(toolText(context));
      expect(accepted).toMatchObject({ committed: true, yielded: false });
      expect(accepted.facts).toHaveLength(1);
      expect(accepted.evidence).toHaveLength(1);
      return json({ summary: "Remaining synthetic comparison inspected; use previously committed evidence", result: "done", facts: [
        { ref: "additional-fact", description: "Synthetic control and changed-object labels are both present", evidenceRefs: [accepted.evidence[0].id] },
      ] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1, noProgressCount: 0, outcome: null });
    expect(board.facts).toHaveLength(2);
    expect(board.evidence).toHaveLength(1);
    expect(board.steps[0]?.status).toBe("done");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("blocks later tools in a yielding batch and sends only committed state to fresh Decide", async () => {
    let forbiddenArtifact = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps) {
          expect(input.blackboard.facts).toHaveLength(1);
          expect(input.blackboard.evidence[0]?.excerpt).toBe(artifactBody);
          expect(input.blackboard.steps[0]?.status).toBe("blocked");
          expect(JSON.stringify(context)).not.toContain(privateNarration);
          expect(context.messages).toHaveLength(1);
        }
        return planning(input);
      }
      if (run.contexts.length === 1) return message([{ type: "text", text: privateNarration },
        { type: "toolCall", id: "fixture-write", name: "write", arguments: { path: join(input.artifacts, "fixture.txt"), content: artifactBody } }], "toolUse");
      expect(run.contexts.length).toBe(2);
      forbiddenArtifact = join(input.artifacts, "must-not-write.txt");
      return message([
        { type: "toolCall", id: "yield-checkpoint", name: "write", arguments: { path: input.checkpointFile!, content: checkpoint(input, "yield-batch", true) } },
        { type: "toolCall", id: "forbidden-after-yield", name: "write", arguments: { path: forbiddenArtifact, content: "MUST NOT EXECUTE" } },
      ], "toolUse");
    });
    await test.controller.start();
    expect(existsSync(forbiddenArtifact)).toBe(false);
    expect(test.seen.map(run => [run.channel, run.contexts.length])).toEqual([
      ["offline-decide", 1], ["offline-execute", 2], ["offline-decide", 1], ["offline-decide", 1],
    ]);
    const handoffs = test.events.flatMap(event => event.handoff ? [event.handoff] : []);
    expect(handoffs[2]).toMatchObject({ mode: "decide", trigger: { kind: "execution_result" } });
    expect(handoffs[2]?.trigger.reason).toContain("partial checkpoint");
    const results = test.events.flatMap(event => event.result ? [event.result] : []);
    const savedSummary = "Partial fixture comparison committed; remaining conditions are still unverified";
    expect(results.filter(result => result.summary.includes(savedSummary))).toHaveLength(1);
    expect(results.find(result => result.kind === "checkpoint")).toMatchObject({ summary: savedSummary, checkpointId: "yield-batch" });
    expect(results.find(result => result.kind === "transition")?.summary).toContain("尚未验证完成");
    expect(test.controller.snapshot().steps[0]?.result).toContain(savedSummary);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 1, noProgressCount: 0 });
    expect(test.controller.snapshot().steps[0]?.status).toBe("blocked");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.events.some(event => event.runtime?.toolCallId === "forbidden-after-yield" && event.runtime.type === "tool_end" && event.runtime.isError)).toBe(true);
    assertExactUsage(test);
  });

  it("returns invalid checkpoints as tool errors without committing records, then accepts a corrected submission", async () => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        const invalid = JSON.parse(checkpoint(input));
        invalid.execution.facts[0].evidenceRefs = ["missing-evidence"];
        return write("invalid-stage", input.checkpointFile!, JSON.stringify(invalid));
      }
      if (run.contexts.length === 3) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "invalid-stage", isError: true });
        expect(toolText(context)).toContain("Unknown evidence reference");
        expect(test.controller.snapshot()).toMatchObject({ completedSteps: 0, facts: [], evidence: [] });
        expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(0);
        return write("corrected-stage", input.checkpointFile!, checkpoint(input));
      }
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "corrected-stage", isError: false });
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "batch-1" });
      return json({ summary: "Corrected checkpoint accepted; remaining synthetic work complete", result: "done" });
    });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", completedSteps: 1, outcome: null, noProgressCount: 0 });
    expect(test.controller.snapshot().facts).toHaveLength(1);
    expect(test.controller.snapshot().evidence).toHaveLength(1);
    expect(test.controller.snapshot().steps[0]?.status).toBe("done");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("redacts resolver credentials in checkpoint fields and yielded output while preserving original evidence", async () => {
    const secret = 'stage-model-"credential\\value"';
    const test = setup((run, _context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "redacted-yield", true));
      submission.execution.summary = `Synthetic model accidentally echoed ${secret} in its partial summary`;
      submission.execution.facts[0].description = `Synthetic observation with accidental credential echo: ${secret}`;
      submission.execution.evidence[0].description = `Synthetic evidence metadata accidentally echoed ${secret}`;
      return write("redacted-checkpoint", input.checkpointFile!, JSON.stringify(submission));
    }, [secret]);
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(board.facts).toHaveLength(1);
    expect(board.facts[0]!.description).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(board.steps[0]?.result).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(board.evidence[0]!.description).toContain("[MODEL_CREDENTIAL_REDACTED]");
    for (const [label, publicData] of [["board", board], ["public events", test.events], ["store events", test.store.events()]] as const) {
      expect(JSON.stringify(publicData).includes("stage-model-"), `${label} must not contain an echoed model credential`).toBe(false);
    }
    const executionRun = test.store.runs().find(run => run.mode === "execute")!;
    const output = readFileSync(join(test.store.dataDir, "runs", executionRun.id, "output.json"), "utf8");
    expect(output).not.toContain("stage-model-");
    expect(output).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(readFileSync(join(taskDirectory(test.root), board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    for (const run of test.seen.slice(2)) expect(JSON.stringify(run.contexts[0])).not.toContain("stage-model-");
    assertExactUsage(test);
  });

  it("returns reusable committed IDs when a checkpoint deduplicates evidence and facts from another run", async () => {
    let firstIds: { fact: string; evidence: string } | undefined;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1) return json({ summary: "Recheck the same synthetic fixture in another Execute run", steps: [{
          goalId: "G0", from: [input.blackboard.facts[0]!.id], description: "Read the same condition and attach a new hypothesis",
          successSignal: "Reuse verified artifact identities without duplicating them", evidencePlan: "Save identical fixture bytes for deduplication", priority: 50,
        }] });
        return planning(input);
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("stage-write", input.checkpointFile!, checkpoint(input));
      const accepted = JSON.parse(toolText(context));
      expect(accepted).toMatchObject({ committed: true, checkpoint: "batch-1" });
      expect(accepted.facts).toHaveLength(1);
      expect(accepted.evidence).toHaveLength(1);
      const ids = { fact: accepted.facts[0].id, evidence: accepted.evidence[0].id };
      if (!input.blackboard.completedSteps) {
        firstIds = ids;
        return json({ summary: "First synthetic observation has been committed", result: "done" });
      }
      expect(ids).toEqual(firstIds);
      expect(test.controller.snapshot().facts).toHaveLength(1);
      expect(test.controller.snapshot().evidence).toHaveLength(1);
      return json({ summary: "Attach a new synthetic hypothesis using acknowledged IDs from the earlier run", result: "done", findings: [{
        key: "cross-run-synthetic-fixture", title: "Synthetic fixture hypothesis only", target: "generated local fixture", status: "lead",
        factRefs: [ids.fact], evidenceRefs: [ids.evidence], next: "Review fixture conditions before drawing any conclusion",
      }] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: 2 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ factIds: [firstIds!.fact], evidenceIds: [firstIds!.evidence] });
    const executionRuns = test.store.runs().filter(run => run.mode === "execute");
    expect(executionRuns).toHaveLength(2);
    expect(board.evidence[0]!.runId).toBe(executionRuns[0]!.id);
    expect(board.facts[0]!.stepId).toBe(executionRuns[0]!.stepId);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(2);
    assertExactUsage(test);
  });
});
