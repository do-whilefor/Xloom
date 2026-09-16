import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesBrowserToolContract } from "../scripts/lib/browser-tool-contract.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { PiRunner, RuntimeRunError, executeTools, parseFinalJson } from "../src/runtime/index.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { ChatSession, type ChatRequest } from "../src/runtime/chat.js";
import type { BoardSnapshot, Decision, ModelConfig, RunRequest, RuntimeEvent } from "../src/types.js";
import { validateDecisionReferences } from "../src/loop/references.js";
import { stagePath, stageWriter } from "../src/runtime/stage.js";
import { createChromeSession } from "../src/runtime/chrome.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { controlChrome } from "../src/runtime/chrome-daemon.js";

const model: Model<"openai-completions"> = {
  id: "mock", name: "mock", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
};
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function request(mode: RunRequest["mode"] = "decide"): Promise<RunRequest> {
  const directory = await mkdtemp(join(tmpdir(), "xloom-runtime-test-"));
  dirs.push(directory);
  const snapshot: BoardSnapshot = {
    revision: 1, config: {
      version: 1, title: "Test", goal: "Inspect fixture", scope: "fixture", context: "Known context",
      models: { decide: { provider: "test", model: "decide", apiKeyEnv: "DO_NOT_EXPOSE_ENV_NAME" }, execute: { provider: "test", model: "execute" } },
      limits: { maxNoProgress: 2, maxMinutes: 5, maxTokens: 10000, maxCost: 10, maxTurnsPerRun: 3, stepTimeoutSeconds: 60, metacogEvery: 3 },
    }, status: "running", outcome: null, reason: "", goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [],
    usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
  };
  return { id: `test-${directory}`, mode, snapshot, workspace: directory, runDir: join(directory, "run"), signal: new AbortController().signal, onEvent() {},
    step: mode === "execute" ? { id: "s1", goalId: "g1", from: [], description: "read fixture", successSignal: "read", evidencePlan: "save", priority: 1, status: "claimed", attempts: 1, runId: null, leaseUntil: null } : undefined };
}

describe("checkpoint write validation boundaries", () => {
  it("keeps a checkpoint receipt bounded by its batch instead of the task's history", async () => {
    const input = await request("execute");
    input.snapshot.facts = Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, description: "Long unrelated historical observation ".repeat(20), stepId: null, evidenceIds: [] }));
    input.onCheckpoint = async (_id, _output, _usage, refs) => {
      Object.assign(refs!, { facts: { local: "F-new" }, evidence: {} });
      return { ...input.snapshot, facts: [...input.snapshot.facts, { id: "F-new", description: "New observation", stepId: null, evidenceIds: [] }] };
    };
    const writer = stageWriter(createWriteTool(input.workspace), input, { input: 0, output: 0, cost: 0 });
    const result = await writer.tool.execute("batch", { path: stagePath(input), content: { id: "batch", execution: { summary: "New", result: "no_progress" } } });
    const text = result.content.filter(p => p.type === "text").map(p => p.text).join("");
    const receipt = JSON.parse(text);
    expect(text.length).toBeLessThan(1000);
    expect(receipt).toMatchObject({ incremental: true, refs: { facts: { local: "F-new" }, evidence: {} }, facts: [{ id: "F-new" }] });
    expect(receipt.facts).toHaveLength(1); expect(text).not.toContain("old-199");
    expect(writer.snapshot.facts).toHaveLength(201);
  });

  it("preserves BOM and correctly escaped string bytes when submitting valid JSON", async () => {
    const input = await request("execute");
    input.onCheckpoint = vi.fn(async () => input.snapshot);
    const execution = { summary: "Literal newline:\nAn apostrophe ' and double quote \" remain data.", result: "no_progress" };
    const source = `\uFEFF${JSON.stringify({ id: "valid", execution })}`;
    const usage = { input: 17, output: 5, cost: 0 };
    const writer = stageWriter(createWriteTool(input.workspace), input, usage);
    await writer.tool.execute("valid", { path: "run/artifacts/checkpoint.json", content: source });
    expect(await readFile(stagePath(input), "utf8")).toBe(source);
    expect(input.onCheckpoint).toHaveBeenCalledExactlyOnceWith("valid", execution, usage, {});
  });

  it("leaves non-checkpoint writes as arbitrary file content", async () => {
    const input = await request("execute");
    input.onCheckpoint = vi.fn(async () => input.snapshot);
    const writer = stageWriter(createWriteTool(input.workspace), input, { input: 0, output: 0, cost: 0 });
    const source = '{"unfinished":"ordinary file\n';
    await writer.tool.execute("ordinary", { path: "ordinary.json", content: source });
    expect(await readFile(join(input.workspace, "ordinary.json"), "utf8")).toBe(source);
    expect(input.onCheckpoint).not.toHaveBeenCalled();
  });

  it.each(["request", "tool"])("does not write or commit after %s cancellation", async kind => {
    const input = await request("execute");
    input.onCheckpoint = vi.fn(async () => input.snapshot);
    const controller = new AbortController();
    controller.abort();
    if (kind === "request") input.signal = controller.signal;
    const writer = stageWriter(createWriteTool(input.workspace), input, { input: 0, output: 0, cost: 0 });
    await expect(writer.tool.execute("cancelled", { path: stagePath(input), content: "{}" }, kind === "tool" ? controller.signal : undefined)).rejects.toThrow(/abort/i);
    expect(input.onCheckpoint).not.toHaveBeenCalled();
    await expect(readFile(stagePath(input))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to submit a file changed during the write", async () => {
    const input = await request("execute");
    input.onCheckpoint = vi.fn(async () => input.snapshot);
    const native = createWriteTool(input.workspace);
    const execute = native.execute;
    native.execute = async (...args) => {
      const result = await execute(...args);
      await writeFile(stagePath(input), "changed externally");
      return result;
    };
    const writer = stageWriter(native, input, { input: 0, output: 0, cost: 0 });
    await expect(writer.tool.execute("changed", { path: stagePath(input), content: JSON.stringify({ id: "valid", execution: { summary: "fixture", result: "no_progress" } }) })).rejects.toThrow("changed after write");
    expect(input.onCheckpoint).not.toHaveBeenCalled();
    expect(await readFile(stagePath(input), "utf8")).toBe("changed externally");
  });
});

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } } };
}

function stream(response: string | ((context: Context) => AssistantMessage), seen: Context[] = []): StreamFn {
  return (_model, context) => {
    seen.push(JSON.parse(JSON.stringify(context)) as Context);
    const events = new AssistantMessageEventStream();
    const result = typeof response === "string" ? message([{ type: "text", text: response }]) : response(context);
    queueMicrotask(() => {
      events.push({ type: "start", partial: result });
      if (result.stopReason === "error" || result.stopReason === "aborted") events.push({ type: "error", reason: result.stopReason, error: result });
      else events.push({ type: "done", reason: result.stopReason as "stop" | "length" | "toolUse", message: result });
      events.end();
    });
    return events;
  };
}

describe("Pi runtime isolation", () => {
  it.each(["submit", "text"])("repairs evidence-only completion through %s without replaying file tools", async route => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.config.chrome = { enabled: false };
    const artifact = join(input.runDir, "artifacts", "observation.txt");
    const output = { summary: "Observed fixture response", result: "done", evidence: [{ ref: "e1", path: artifact, description: "Original local fixture" }] };
    const facts = [{ ref: "f1", description: "Actual fixture value is 314", evidenceRefs: ["e1"] }];
    const events: RuntimeEvent[] = []; input.onEvent = event => events.push(event);
    let calls = 0;
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      calls++;
      if (calls === 1) return message([{ type: "toolCall", id: "original", name: "write", arguments: { path: artifact, content: "value=314" } }], "toolUse");
      if (calls === 2) return route === "submit"
        ? message([{ type: "toolCall", id: "incomplete", name: "submit", arguments: { output } }], "toolUse")
        : message([{ type: "text", text: JSON.stringify(output) }]);
      expect(calls).toBe(3);
      expect(JSON.stringify(context.messages.at(-1))).toContain("Evidence files alone do not establish completion");
      if (route === "submit") return message([{ type: "toolCall", id: "repair", name: "submit", arguments: { repair: [{ path: "/facts", value: facts }] } }], "toolUse");
      expect(context.tools).toEqual([]);
      return message([{ type: "text", text: JSON.stringify({ ...output, facts }) }]);
    }) }) }).run(input);
    expect(calls).toBe(3);
    expect(result.output).toEqual({ ...output, facts });
    expect(await readFile(artifact, "utf8")).toBe("value=314");
    expect(events.filter(event => event.type === "tool_start" && event.toolName === "write")).toHaveLength(1);
  });

  it("allows evidence-only partial results without forcing the model to invent facts", async () => {
    const input = await request("execute");
    const output = { summary: "Raw observation requires interpretation", result: "no_progress", evidence: [{ ref: "e1", path: join(input.runDir, "artifacts", "raw.txt"), description: "Pending interpretation" }] };
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(JSON.stringify(output)) }) }).run(input);
    expect(result.output).toEqual(output);
  });

  it("accepts sourced Wiki work without requiring new facts", async () => {
    const input = await request("execute");
    const output = { summary: "Maintain sourced Wiki", result: "done",
      evidence: [{ ref: "e1", path: join(input.runDir, "artifacts", "raw.txt"), description: "Local fixture" }],
      wikiPages: [{ id: "WK-fixture", title: "Fixture", blocks: [{ id: "B-source", title: "Source",
        text: "Uninterpreted fixture observation", sources: [{ kind: "evidence", id: "e1" }] }] }] };
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(JSON.stringify(output)) }) }).run(input);
    expect(result.output).toEqual(output);
  });

  it("accepts extra evidence after a committed checkpoint without requiring duplicate facts", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.config.chrome = { enabled: false };
    const checkpoint = { id: "first", execution: { summary: "Observation committed", result: "done",
      facts: [{ ref: "f1", description: "Fixture observed", evidenceRefs: ["E-previous"] }] } };
    input.onCheckpoint = vi.fn(async () => ({ ...input.snapshot, revision: 2,
      facts: [{ id: "F-committed", description: "Fixture observed", evidenceIds: ["E-previous"], stepId: input.step!.id }] }));
    const output = { summary: "Additional raw attachment; facts already committed", result: "done",
      evidence: [{ ref: "e2", path: join(input.runDir, "artifacts", "extra.txt"), description: "Additional fixture" }] };
    let calls = 0;
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1
      ? message([{ type: "toolCall", id: "checkpoint", name: "write", arguments: { path: stagePath(input), content: checkpoint } }], "toolUse")
      : message([{ type: "text", text: JSON.stringify(output) }])) }) }).run(input);
    expect(input.onCheckpoint).toHaveBeenCalledOnce();
    expect(calls).toBe(2); expect(result.output).toEqual(output);
  });

  it.each(["decide", "metacog", "execute"] as const)("accepts a structured %s proposal in one response and logs actual event times", async mode => {
    const input = await request(mode);
    let calls = 0;
    const output = { summary: 'Preserve quotes " and newlines\nwithout a JSON envelope repair.', ...(mode === "execute" ? { result: "no_progress" } : {}) };
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      expect(++calls).toBe(1);
      return message([{ type: "toolCall", id: "final", name: "submit", arguments: { output } }], "toolUse");
    }) }) }).run(input);
    expect(result.output).toEqual(output); expect(calls).toBe(1);
    const logs = (await readFile(join(input.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(logs.every(event => Number.isFinite(event.at))).toBe(true);
    expect(logs.some(event => event.type === "message_start" && event.role === "assistant")).toBe(true);
    expect(logs.filter(event => event.type.startsWith("tool_execution_")).map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
  });

  it("rejects invalid structured references before accepting a corrected proposal", async () => {
    const input = await request(); let calls = 0;
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      calls++;
      if (calls === 2) expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "submit", isError: true });
      return message([{ type: "toolCall", id: `final-${calls}`, name: "submit", arguments: { output: calls === 1
        ? { summary: "Bad reference", updateGoals: [{ id: "unknown", status: "satisfied", factIds: ["invented"], reason: "invalid" }] }
        : { summary: "Corrected without inventing facts" } } }], "toolUse");
    }) }) }).run(input);
    expect(calls).toBe(2); expect(result.output).toEqual({ summary: "Corrected without inventing facts" });
  });

  it("repairs the newest rejected proposal through Pi without committing an older summary", async () => {
    const input = await request("execute"); let calls = 0;
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.config.chrome = { enabled: false };
    const proposals = [
      { output: { summary: "OUTDATED", result: "no_progress", extra: true } },
      { output: { summary: "LATEST actual observations", result: "invalid", extra: true } },
      { repair: [{ path: "/result", value: "blocked" }, { path: "/extra", remove: true }] },
    ];
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (calls) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "submit", isError: true });
        expect(JSON.stringify(context.messages.at(-1))).toContain("Rejected proposal retained");
      }
      expect(calls).toBeLessThan(proposals.length);
      return message([{ type: "toolCall", id: `proposal-${calls}`, name: "submit", arguments: proposals[calls++] }], "toolUse");
    }) }) }).run(input);
    expect(calls).toBe(3);
    expect(result.output).toEqual({ summary: "LATEST actual observations", result: "blocked" });
    expect(JSON.parse(await readFile(join(input.runDir, "output.json"), "utf8")).output).toEqual(result.output);
  });

  it("stops remaining mutation tools after submission while retaining prior completed tools", async () => {
    const input = await request("execute"); let calls = 0;
    await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      expect(++calls).toBe(1);
      return message([
        { type: "toolCall", id: "before", name: "write", arguments: { path: "before.txt", content: "completed" } },
        { type: "toolCall", id: "final", name: "submit", arguments: { output: { summary: "Retain partial work", result: "no_progress" } } },
        { type: "toolCall", id: "after", name: "write", arguments: { path: "after.txt", content: "must not run" } },
      ], "toolUse");
    }) }) }).run(input);
    expect(await readFile(join(input.workspace, "before.txt"), "utf8")).toBe("completed");
    await expect(readFile(join(input.workspace, "after.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a completed structured result at a token boundary without requesting another turn", async () => {
    const input = await request(); input.snapshot.config.limits.maxTokens = 1;
    const result = await new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => message([
      { type: "toolCall", id: "final", name: "submit", arguments: { output: { summary: "Complete proposal" } } },
    ], "toolUse")) }) }).run(input);
    expect(result.output).toEqual({ summary: "Complete proposal" });
  });

  it("accepts misplaced combination fields and unused Step IDs in one request while preserving conditions", async () => {
    const input = await request();
    input.snapshot.goals = [{ id: "G0", description: "Fixture", parentId: null, status: "active", factIds: [] }];
    input.snapshot.facts = [{ id: "F-fixture", description: "Fixture", stepId: null, evidenceIds: [] }, { id: "F-counter", description: "Counter fixture", stepId: null, evidenceIds: [] }];
    const combination = { requires: ["F-fixture"], missing: ["Fixture prerequisite"], scope: "local fixture", stateVersion: "v1", expectedCapability: "Fixture result", counterEvidence: ["F-counter"] };
    const output = { summary: "Plan new fixture work", steps: [{ id: "S-model-label", goalId: "G0", from: ["F-fixture"], description: "Inspect fixture", successSignal: "Fixture result", evidencePlan: "Fixture evidence", priority: 50, ...combination }] };
    const seen: Context[] = [], events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(JSON.stringify(output), seen) }) });
    const result = await runner.run(input);
    expect((result.output as Decision).steps![0]!.combination).toEqual(combination);
    expect((result.output as Decision).steps![0]).not.toHaveProperty("id");
    expect(seen).toHaveLength(1);
    expect(events.filter(event => event.type === "notice" && event.text.includes("tool-free repair"))).toEqual([]);
    expect(events.some(event => event.text.startsWith("Decision format normalized"))).toBe(true);
    expect(JSON.parse(await readFile(join(input.runDir, "output.json"), "utf8")).output).toEqual(result.output);
  });

  it("gives a single tool-free repair precise Step guidance and retains conflicting values for the model", async () => {
    const input = await request(); let calls = 0;
    const invalid = { summary: "Fixture", steps: [{ goalId: "G0", from: [], description: "Fixture", successSignal: "Fixture", evidencePlan: "Fixture", priority: 1, missing: ["RETAIN_TOP_LEVEL"], combination: { missing: ["RETAIN_NESTED"] } }] };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "text", text: JSON.stringify(invalid) }]);
      expect(context.tools).toEqual([]);
      const repair = JSON.stringify(context.messages.at(-1));
      expect(repair).toContain("Omit id"); expect(repair).toContain("inside combination"); expect(repair).toContain("Preserve all prerequisite");
      expect(JSON.stringify(context.messages)).toContain("RETAIN_TOP_LEVEL"); expect(JSON.stringify(context.messages)).toContain("RETAIN_NESTED");
      return message([{ type: "text", text: JSON.stringify(invalid) }]);
    }) }) });
    await expect(runner.run(input)).rejects.toThrow(/Final response protocol validation failed after one repair.*Conflicting/);
    expect(calls).toBe(2); await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs first-observation conditions without inventing causal Fact IDs", async () => {
    const input = await request(); let calls = 0;
    input.snapshot.goals = [{ id: "G0", description: "Fixture", parentId: null, status: "active", factIds: [] }];
    const conditions = { requires: [], missing: ["Unverified local input"], scope: "local fixture", stateVersion: "v1", expectedCapability: "Observe bytes", counterEvidence: [] };
    const step = { goalId: "G0", from: [], description: "Read the fixture", successSignal: "Read back bytes", evidencePlan: "Archive source bytes", priority: 1 };
    const invalid = { summary: "First observation", steps: [{ ...step, combination: conditions }] };
    const repaired = { summary: "First observation", steps: [{ ...step, description: `${step.description}. Unverified conditions: ${JSON.stringify(conditions)}` }] };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "text", text: JSON.stringify(invalid) }]);
      expect(context.tools).toEqual([]);
      expect(JSON.stringify(context.messages.at(-1))).toContain("omit combination and retain every unverified condition");
      expect(JSON.stringify(context.messages.at(-1))).toContain("Never invent a Fact ID");
      expect(JSON.stringify(context.messages)).toContain("Unverified local input");
      return message([{ type: "text", text: JSON.stringify(repaired) }]);
    }) }) });
    expect((await runner.run(input)).output).toEqual(repaired);
    expect(calls).toBe(2); expect(input.snapshot.facts).toEqual([]);
  });
  it("creates fresh independent Agents with exact tool capabilities and uses Decide for metacog", async () => {
    const seen: Context[] = [];
    const options: AgentOptions[] = [];
    const selected: ModelConfig[] = [];
    const runner = new PiRunner({
      resolveModel: async (config) => { selected.push(config); return { model, streamFn: stream(JSON.stringify({ summary: "only this run", ...(config.model === "execute" ? { result: "no_progress" } : {}) }), seen) }; },
      createAgent: (entry) => { options.push(entry); return new Agent(entry); },
    });
    for (const mode of ["decide", "execute", "metacog"] as const) await runner.run(await request(mode));
    expect(selected.map((config) => config.model)).toEqual(["decide", "execute", "decide"]);
    expect(options.map((entry) => entry.initialState?.messages)).toEqual([[], [], []]);
    expect(options.map((entry) => entry.initialState?.tools?.map((tool) => tool.name))).toEqual([["read", "submit"], ["read", "write", "edit", "powershell", "chrome", "submit"], ["read", "submit"]]);
    expect(matchesBrowserToolContract("execute", options[1].initialState?.tools)).toBe(true);
    expect(options.map(entry => entry.initialState?.tools?.find(tool => tool.name === "read")?.description.includes("artifact://"))).toEqual([false, true, false]);
    expect(options.every((entry) => entry.toolExecution === "parallel" && entry.beforeToolCall && !entry.afterToolCall)).toBe(true);
    expect(options.flatMap(entry => entry.initialState?.tools ?? []).every(tool => tool.executionMode === (tool.name === "read" ? "parallel" : "sequential"))).toBe(true);
    expect(seen.every((context) => context.messages.length === 1 && context.messages[0].role === "user")).toBe(true);
    expect(seen.every((context) => !JSON.stringify(context).includes("only this run") && !JSON.stringify(context).includes("DO_NOT_EXPOSE_ENV_NAME"))).toBe(true);
  });
  it("lets Execute discover and call Chrome through the actual Pi tool loop and closes its stdio client", async () => {
    const input = await request("execute"); input.snapshot.config.limits.maxTurnsPerRun = 5;
    const events: RuntimeEvent[] = []; input.onEvent = event => events.push(event);
    let calls = 0, pid: number;
    const close = vi.fn();
    const runner = new PiRunner({
      createChrome: options => {
        const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/chrome-server.mjs", import.meta.url))], stderr: "ignore" });
        const session = createChromeSession(options, () => transport);
        return { ...session, close: async () => { pid = transport.pid!; await session.close(); close(); } };
      },
      resolveModel: async () => ({ model, streamFn: stream(context => {
        calls++;
        const args = [{ action: "list" }, { action: "describe", tool: "echo" }, { action: "call", tool: "echo", args: { value: "existing cookie session" } }][calls - 1];
        if (args) return message([{ type: "toolCall", id: `chrome-${calls}`, name: "chrome", arguments: args }], "toolUse");
        expect(JSON.stringify(context.messages)).toContain("existing cookie session");
        return message([{ type: "text", text: JSON.stringify({ summary: "Browser fixture verified", result: "done" }) }]);
      }) }),
    });
    expect((await runner.run(input)).output).toMatchObject({ result: "done" });
    expect(events.filter(event => event.type === "tool_end" && event.toolName === "chrome")).toHaveLength(3);
    expect(events.some(event => event.isError)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => process.kill(pid!, 0)).toThrow();
  });
  it.each(["success", "failure", "cancel"])("releases Execute's turn-local Chrome handle on run %s", async outcome => {
    const input = await request("execute"), controller = new AbortController(); input.signal = controller.signal;
    const close = vi.fn(async () => {});
    const runner = new PiRunner({ createChrome: options => ({ ...createChromeSession(options), close }),
      resolveModel: async () => ({ model, streamFn: stream(() => {
        if (outcome === "cancel") controller.abort();
        return outcome === "failure" ? { ...message([], "error"), errorMessage: "fixture fatal failure" }
          : message([{ type: "text", text: '{"summary":"fixture","result":"no_progress"}' }]);
      }) }) });
    if (outcome === "success") await runner.run(input); else await expect(runner.run(input)).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("omits Chrome when the project disables it", async () => {
    const input = await request("execute"); input.snapshot.config.chrome = { enabled: false };
    const createChrome = vi.fn(createChromeSession);
    const runner = new PiRunner({ createChrome, resolveModel: async () => ({ model, streamFn: stream(context => {
      expect(context.tools?.map(tool => tool.name)).not.toContain("chrome");
      return message([{ type: "text", text: '{"summary":"fixture","result":"no_progress"}' }]);
    }) }) });
    await runner.run(input); expect(createChrome).not.toHaveBeenCalled();
  });

  it("only projects blackboard fields and keeps evidence excerpts", async () => {
    const input = await request();
    input.blackboardPath = join(input.workspace, "task-state", "blackboard.md");
    Object.assign(input.snapshot, { messages: [{ text: "SECRET_PRIOR_CHAT" }] });
    input.snapshot.evidence.push({ id: "e1", path: "artifact", sha256: "hash", bytes: 1, description: "brief", runId: "r0", stepId: "s0", excerpt: "original result" });
    const prompt = buildRunPrompt(input);
    expect(prompt.userPrompt).not.toContain("SECRET_PRIOR_CHAT");
    expect(prompt.userPrompt).not.toContain("DO_NOT_EXPOSE_ENV_NAME");
    expect(prompt.userPrompt).toContain("original result");
    expect(prompt.userPrompt).toContain("Resolve pending Steps");
    expect(prompt.userPrompt).toContain("Narratives, files or hashes alone prove nothing");
    expect(prompt.userPrompt).toContain("Priority is an integer 0–1000");
    expect(prompt.userPrompt).toContain("Never abandon the root Goal");
    expect(prompt.userPrompt).toContain("covering the whole Goal, results, evidence and remaining work");
    expect(JSON.parse(prompt.userPrompt.split("\n").at(-1)!)).toMatchObject({ blackboardFile: input.blackboardPath });
  });

  it.each(["decide", "metacog"] as const)("lets %s use Pi's native read without changing its JSON output contract", async mode => {
    const input = await request(mode);
    await writeFile(join(input.workspace, "public-evidence.txt"), "existing public evidence");
    let calls = 0;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "decide-read", name: "read", arguments: { path: "public-evidence.txt" } }], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      expect(JSON.stringify(context.messages.at(-1))).toContain("existing public evidence");
      return message([{ type: "text", text: '{"summary":"Inspected existing evidence; no new fact IDs invented"}' }]);
    }) }) });
    expect((await runner.run(input)).output).toEqual({ summary: "Inspected existing evidence; no new fact IDs invented" });
    expect(calls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", mode, toolName: "read", isError: false }));
  });

  it("also redacts the other channel's explicitly configured model key", async () => {
    vi.stubEnv("XLOOM_OTHER_CHANNEL_KEY", "other-channel-credential");
    const input = await request("decide");
    input.snapshot.config.models.execute.apiKeyEnv = "XLOOM_OTHER_CHANNEL_KEY";
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream('{"summary":"other-channel-credential"}') }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain("other-channel-credential");
  });

  it("saves local transcript and output, counts cached tokens, and redacts known model credentials", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream('{"summary":"credential-secret"}'), secrets: ["credential-secret"] }) });
    const result = await runner.run(input);
    expect(result.usage).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain("credential-secret");
    expect(await readFile(join(input.runDir, "output.json"), "utf8")).toContain("MODEL_CREDENTIAL_REDACTED");
  });

  it("preserves consumed usage for invalid output errors", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream("not json") }) });
    const error = await runner.run(input).catch((failure) => failure);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.usage.input).toBe(26);
    expect(error.message).toContain("single JSON object");
  });

  it("repairs the final schema once with no tools and preserves earlier side effects", async () => {
    const input = await request("execute");
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "saved", name: "write", arguments: { path: "observed.txt", content: "observed once" } }], "toolUse");
      if (calls === 2) return message([{ type: "text", text: '{"summary":"Artifact saved"}' }]);
      expect(context.tools).toEqual([]);
      expect(JSON.stringify(context.messages)).toContain("saved");
      expect(JSON.stringify(context.messages)).toContain("result: Required");
      return message([{ type: "text", text: '{"summary":"Artifact saved; success unverified","result":"no_progress"}' }]);
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toMatchObject({ result: "no_progress" });
    expect(result.usage).toEqual({ input: 39, output: 12, cost: 0.06, cacheRead: 6, cacheInput: 39 });
    expect(await readFile(join(input.workspace, "observed.txt"), "utf8")).toBe("observed once");
    expect(calls).toBe(3);
  });

  it("does not execute hallucinated repair tools or start further repair turns", async () => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "text", text: "bad JSON" }]);
      expect(context.tools).toEqual([]);
      return message([{ type: "toolCall", id: "bad-repair", name: "write", arguments: { path: "forbidden.txt", content: "must not exist" } }], "toolUse");
    }) }) });
    await expect(runner.run(input)).rejects.toThrow("Protocol repair did not finish");
    expect(calls).toBe(2);
    await expect(readFile(join(input.workspace, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["decide", "metacog"] as const)("repairs a %s wrong Fact and truncated Step ID together without replaying tools", async mode => {
    const input = await request(mode);
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.goals.push({ id: "G0", parentId: null, status: "active", description: "Inspect synthetic fixture", factIds: [] });
    input.snapshot.facts.push({ id: "F-observation", stepId: null, description: "The fixture contains an allow/deny comparison", evidenceIds: ["E-artifact"] });
    input.snapshot.steps.push({ id: "S-3b514130-6a6", goalId: "G0", from: [], description: "Prior synthetic fixture check", successSignal: "Label", evidencePlan: "Save", priority: 1,
      status: "ready", attempts: 0, runId: null, leaseUntil: null });
    await writeFile(join(input.workspace, "public-evidence.txt"), "SYNTHETIC allow/deny comparison");
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    let calls = 0;
    const plan = (ref: string, stepId: string) => ({ summary: "Inspect the remaining fixture condition", steps: [{
      goalId: "G0", from: [ref], description: "Check another fixture label", successSignal: "Expected label observed", evidencePlan: "Save fixture", priority: 1,
    }], updateSteps: [{ id: stepId, action: "abandon", reason: "Replace prior plan using the observed fixture" }] });
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "read-once", name: "read", arguments: { path: "public-evidence.txt" } }], "toolUse");
      if (calls === 2) return message([{ type: "text", text: JSON.stringify(plan("F-artifact", "S-3b514130-6a")) }]);
      expect(context.tools).toEqual([]);
      expect(JSON.stringify(context.messages.at(-1))).toContain("steps[0].from[0]");
      expect(JSON.stringify(context.messages.at(-1))).toContain("updateSteps[0].id");
      expect(JSON.stringify(context.messages.at(-1))).toContain("S-3b514130-6a");
      expect(JSON.stringify(context.messages.at(-1))).toContain("never change ID prefixes");
      expect(JSON.stringify(context.messages)).toContain("F-observation");
      return message([{ type: "text", text: JSON.stringify(plan("F-observation", "S-3b514130-6a6")) }]);
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual(plan("F-observation", "S-3b514130-6a6"));
    expect(result.usage).toEqual({ input: 39, output: 12, cost: 0.06, cacheRead: 6, cacheInput: 39 });
    expect(calls).toBe(3);
    expect(events.filter(event => event.type === "tool_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "notice" && event.text.includes("tool-free repair"))).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(input.runDir, "output.json"), "utf8"));
    expect(saved.output).toEqual(plan("F-observation", "S-3b514130-6a6"));
  });

  it.each([1, null])("never invents a replacement Fact when correction fails (explicit request limit %s)", async maxTurns => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = maxTurns;
    const seen: Context[] = [];
    const invalid: Decision = { summary: "Unsupported completion", updateGoals: [{ id: "G0", status: "satisfied", factIds: ["F-invented"], reason: "Missing observation" }] };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(JSON.stringify(invalid), seen) }) });
    const failure = await runner.run(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain('updateGoals[0].factIds[0]="F-invented"');
    expect(seen).toHaveLength(maxTurns === 1 ? 1 : 2);
    expect(failure.usage.input).toBe(seen.length * 13);
    await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(input.snapshot.facts).toEqual([]);
  });

  it.each([true, false])("diagnoses prose plus a sixth review's wrong PoC in the same bounded repair (corrected=%s)", async corrected => {
    const input = await request("metacog");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.evidence = ["E-attached", "E-other"].map(id => ({ id, path: "fixture.txt", sha256: "fixture", bytes: 1,
      description: "Synthetic local evidence", runId: "prior", stepId: "S-fixture" }));
    input.snapshot.findings = Array.from({ length: 6 }, (_, i) => ({ id: `V-fixture-${i}`, key: `fixture-${i}`, target: "local fixture",
      title: "Synthetic hypothesis", status: "technical_hit", rating: "unrated", factIds: ["F-fixture"], evidenceIds: ["E-attached"], next: "Review" }));
    input.snapshot.facts = [{ id: "F-fixture", stepId: null, description: "Synthetic fixture", evidenceIds: ["E-attached"] }];
    const original = structuredClone(input.snapshot);
    const review = (fixed: boolean): Decision => ({ summary: "Synthetic review only", reviews: input.snapshot.findings.map((finding, i) => ({
      findingId: finding.id, status: "closed", rating: "unrated", reason: "Synthetic result; reopen if fixture changes",
      pocEvidenceId: i === 5 && !fixed ? "E-other" : "E-attached",
    })) });
    const seen: Context[] = [];
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (seen.length === 1) return message([{ type: "text", text: `Review follows.\n\`\`\`json\n${JSON.stringify(review(false))}\n\`\`\`` }]);
      expect(context.tools).toEqual([]);
      const repair = JSON.stringify(context.messages.at(-1));
      expect(repair).toContain("single JSON object");
      expect(repair).toContain("reviews[5].pocEvidenceId");
      expect(repair).toContain("E-attached");
      expect(repair).toContain("defer that review");
      return message([{ type: "text", text: JSON.stringify(review(corrected)) }]);
    }, seen) }) });
    if (corrected) expect((await runner.run(input)).output).toEqual(review(true));
    else {
      const failure = await runner.run(input).catch(error => error);
      expect(failure).toBeInstanceOf(RuntimeRunError);
      expect(failure.message).toContain("reviews[5].pocEvidenceId");
      expect(failure.usage).toEqual({ input: 26, output: 8, cost: 0.04, cacheRead: 4, cacheInput: 26 });
      await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(seen).toHaveLength(2);
    expect(input.snapshot).toEqual(original);
  });

  it("checks every Fact reference field against the full board without changing the proposal", async () => {
    const { snapshot } = await request();
    snapshot.goals.push(...["G0", "G1"].map(id => ({ id, parentId: null, status: "active" as const, description: "Synthetic fixture goal", factIds: [] })));
    snapshot.facts.push({ id: "F-old", description: "Indexed historical observation", stepId: null, evidenceIds: ["E-old"] });
    const valid: Decision = { summary: "Recheck compatible observations", steps: [{ goalId: "G0", from: ["F-old"], description: "Fixture recheck", successSignal: "Comparison", evidencePlan: "Save", priority: 1,
      combination: { requires: ["F-old"], counterEvidence: ["F-old"], missing: ["condition"], scope: "fixture", stateVersion: "v1", expectedCapability: "label comparison" } }],
      updateGoals: [{ id: "G1", status: "satisfied", factIds: ["F-old"], reason: "Already observed" }] };
    expect(() => validateDecisionReferences(snapshot, valid)).not.toThrow();
    const invalid = structuredClone(valid);
    invalid.steps![0]!.from = ["E-old"];
    invalid.steps![0]!.combination!.requires = ["f1"];
    invalid.steps![0]!.combination!.counterEvidence = ["F-invented"];
    invalid.updateGoals![0]!.factIds = ["F-missing"];
    const original = structuredClone(invalid);
    for (const field of ["steps[0].from[0]", "steps[0].combination.requires[0]", "steps[0].combination.counterEvidence[0]", "updateGoals[0].factIds[0]"]) {
      expect(() => validateDecisionReferences(snapshot, invalid)).toThrow(field);
    }
    expect(invalid).toEqual(original);
  });

  it.each(["decide", "metacog"] as const)("enforces read-only %s even if the model requests a write", async mode => {
    const input = await request(mode);
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "forbidden", name: "write", arguments: { path: "forbidden.txt", content: "do not mutate" } }], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
      return message([{ type: "text", text: '{"summary":"Delegate mutation to Execute"}' }]);
    }) }) });
    await runner.run(input);
    await expect(readFile(join(input.workspace, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["503 upstream temporarily unavailable", "Anthropic stream ended before message_stop", "Request timed out."])("continues %s from durable complete tool results without replay", async errorMessage => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "thinking", thinking: "PRIVATE REASONING" }, { type: "toolCall", id: "once", name: "write", arguments: { path: "once.txt", content: "one write" } }], "toolUse");
      if (calls === 2) return { ...message([], "error"), errorMessage };
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "once", isError: false });
      expect(JSON.stringify(context.messages)).not.toContain("PRIVATE REASONING");
      expect(JSON.stringify(context.messages)).not.toContain(errorMessage);
      return message([{ type: "text", text: '{"summary":"Retained prior observation","result":"no_progress"}' }]);
    }) }) });
    const result = await runner.run(input);
    expect(result.usage).toEqual({ input: 39, output: 12, cost: 0.06, cacheRead: 6, cacheInput: 39 });
    expect(events.filter(event => event.type === "tool_start")).toHaveLength(1);
    expect(await readFile(join(input.workspace, "once.txt"), "utf8")).toBe("one write");
    const checkpoint = JSON.parse(await readFile(join(input.runDir, "continuation.json"), "utf8"));
    expect(checkpoint).toMatchObject({ pendingToolCalls: [], usage: result.usage, identity: { role: "execute", stepId: "s1" } });
    expect(JSON.stringify(checkpoint)).not.toContain("PRIVATE REASONING");
  });

  it.each(["Anthropic stream ended before message_stop", "Request timed out."])("rejects a second %s even when the interrupted JSON looks complete", async errorMessage => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return { ...message([{ type: "text", text: '{"summary":"Unverified interrupted response"}' }], "error"), errorMessage };
    }) }) });
    const failure = await runner.run(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain(errorMessage);
    expect(failure.usage).toEqual({ input: 26, output: 8, cost: 0.04, cacheRead: 4, cacheInput: 26 });
    expect(calls).toBe(2);
    await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replay uncertain tool calls from an incomplete Anthropic stream", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return { ...message([{ type: "toolCall", id: "uncertain", name: "write", arguments: { path: "must-not-exist.txt", content: "incomplete response" } }], "error"),
        errorMessage: "Anthropic stream ended before message_stop" };
    }) }) });
    await expect(runner.run(input)).rejects.toThrow("unfinished tools");
    expect(calls).toBe(1);
    expect(events.filter(event => event.type === "tool_start")).toHaveLength(0);
    await expect(readFile(join(input.workspace, "must-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["authentication", "turn-budget", "token-budget", "cancellation"])("does not retry after %s", async reason => {
    const input = await request();
    const abort = new AbortController();
    input.signal = abort.signal;
    if (reason === "turn-budget") input.snapshot.config.limits.maxTurnsPerRun = 1;
    if (reason === "token-budget") input.snapshot.config.limits.maxTokens = 1;
    let calls = 0;
    input.onEvent = event => { if (reason === "cancellation" && event.type === "usage") abort.abort(); };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return { ...message([], "error"), errorMessage: reason === "authentication" ? "401 invalid API key" : "503 service unavailable" };
    }) }) });
    const error = await runner.run(input).catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.usage.input).toBe(13);
    expect(calls).toBe(1);
  });

  it("persists all pending tool IDs before the first tool executes", async () => {
    const input = await request("execute");
    let calls = 0;
    let checked = false;
    const runner = new PiRunner({
      resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1 ? message([
        { type: "toolCall", id: "a", name: "write", arguments: { path: "a.txt", content: "a" } },
        { type: "toolCall", id: "b", name: "write", arguments: { path: "b.txt", content: "b" } },
      ], "toolUse") : message([{ type: "text", text: '{"summary":"two observed writes","result":"no_progress"}' }])) }),
      createAgent: options => new Agent({ ...options, beforeToolCall: async (context, signal) => {
        if (!checked) {
          const saved = JSON.parse(await readFile(join(input.runDir, "continuation.json"), "utf8"));
          expect(saved.pendingToolCalls).toEqual(["a", "b"]);
          await expect(readFile(join(input.workspace, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
          checked = true;
        }
        return options.beforeToolCall?.(context, signal);
      } }),
    });
    await runner.run(input);
    expect(checked).toBe(true);
  });

  it("reserves the final actual request for reporting after a transient failure", async () => {
    const input = await request("execute");
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "first", name: "write", arguments: { path: "first.txt", content: "one" } }], "toolUse");
      if (calls === 2) return { ...message([], "error"), errorMessage: "503 unavailable" };
      expect(context.tools).toEqual([]);
      expect(context.systemPrompt).toContain("final allowed model request");
      return message([{ type: "text", text: '{"summary":"One observed write; task unfinished","result":"no_progress"}' }]);
    }) }) });
    const result = await runner.run(input);
    expect(calls).toBe(3);
    expect(result.usage.input).toBe(39);
    expect(await readFile(join(input.workspace, "first.txt"), "utf8")).toBe("one");
  });

  it.each([0, 4000])("compacts complete tool batches with %i extra context characters and accounts for summary tokens", async extraContext => {
    const input = await request("execute");
    input.snapshot.config.context += "x".repeat(extraContext);
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.config.limits.maxTokens = null;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    await writeFile(join(input.workspace, "long.txt"), "Synthetic observation. ".repeat(500));
    let calls = 0;
    let summaries = 0;
    let sawSummary = false;
    const runner = new PiRunner({ resolveModel: async () => ({ model: { ...model, contextWindow: 16000 }, streamFn: stream(context => {
      if (context.systemPrompt?.startsWith("Summarize the older conversation")) {
        summaries++;
        expect(context.tools).toEqual([]);
        return message([{ type: "text", text: "Repeatedly inspected long.txt. No verified conclusion; preserve the current Step and inspect original evidence." }]);
      }
      sawSummary ||= JSON.stringify(context.messages).includes("[XLOOM CONTEXT SUMMARY]");
      // Every retained call must still have its corresponding result.
      for (const item of context.messages) if (item.role === "assistant") for (const part of item.content) if (part.type === "toolCall") {
        expect(context.messages.some(result => result.role === "toolResult" && result.toolCallId === part.id)).toBe(true);
      }
      return ++calls <= 12 ? message([{ type: "toolCall", id: `read-${calls}`, name: "read", arguments: { path: "long.txt" } }], "toolUse")
        : message([{ type: "text", text: '{"summary":"Observations retained; no verified conclusion","result":"no_progress"}' }]);
    }) }) });
    const result = await runner.run(input);
    expect(summaries).toBeGreaterThan(0);
    expect(sawSummary).toBe(true);
    expect(events.filter(event => event.type === "tool_start")).toHaveLength(12);
    expect(result.usage.input).toBe((calls + summaries) * 13);
    expect(result.usage.cacheRead).toBe((calls + summaries) * 2);
    expect(result.usage.cacheInput).toBe(result.usage.input);
    expect(events.filter(event => event.type === "usage")).toHaveLength(calls + summaries);
  });

  it("forwards message/tool order before awaiting transcript writes, even for a non-awaited event source", async () => {
    const input = await request();
    const observed: RuntimeEvent[] = [];
    input.onEvent = event => observed.push(event);
    let listener!: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
    const first = message([{ type: "thinking", thinking: "First message returned thought." },
      { type: "toolCall", id: "ordered-write", name: "write", arguments: { path: "fixture.txt", content: "fixture" } }], "toolUse");
    const second = message([{ type: "thinking", thinking: "Second message returned thought." }, { type: "text", text: '{"summary":"ordered result"}' }]);
    const source: AgentEvent[] = [
      { type: "message_start", message: first }, { type: "message_end", message: first },
      { type: "tool_execution_start", toolCallId: "ordered-write", toolName: "write", args: { path: "fixture.txt", content: "fixture" } },
      { type: "tool_execution_end", toolCallId: "ordered-write", toolName: "write", result: { content: [{ type: "text", text: "Synthetic tool result" }] }, isError: false },
      { type: "message_start", message: second }, { type: "message_end", message: second },
    ];
    const runner = new PiRunner({
      resolveModel: async () => ({ model, streamFn: stream('{"summary":"unused"}') }),
      createAgent: () => ({
        subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
        prompt: async () => {
          const pending = source.map(event => Promise.resolve(listener(event, input.signal)));
          // This assertion runs before any appendFile promise can complete.
          try { expect(observed.map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end", "usage", "tool_start", "tool_end", "thinking_start", "thinking", "thinking_end", "usage"]); }
          finally { await Promise.all(pending); }
        },
        abort() {}, waitForIdle: async () => {},
      }) as unknown as Agent,
    });
    const result = await runner.run(input);
    const starts = observed.filter(event => event.type === "thinking_start");
    expect(starts.map(event => event.blockId?.split(":").slice(-2))).toEqual([["1", "0"], ["2", "0"]]);
    expect(observed.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["First message returned thought.", "Second message returned thought."]);
    expect(observed.filter(event => event.type === "thinking_end").map(event => event.blockId)).toEqual(starts.map(event => event.blockId));
    expect(result).toEqual({ output: { summary: "ordered result" }, usage: { input: 26, output: 8, cost: 0.04, cacheRead: 4, cacheInput: 26 } });
  });

  it("redacts credentials split across text streaming chunks", async () => {
    const input = await request();
    let rendered = "";
    input.onEvent = (event) => { if (event.type === "text") rendered += event.text; };
    const runner = new PiRunner({ resolveModel: async () => ({ model, secrets: ["credential-secret"], streamFn: () => {
      const events = new AssistantMessageEventStream();
      const result = message([{ type: "text", text: '{"summary":"credential-secret"}' }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial: result });
        for (const delta of ['{"summary":"cred', 'ential-', 'secret"}']) events.push({ type: "text_delta", contentIndex: 0, delta, partial: result });
        events.push({ type: "done", reason: "stop", message: result });
        events.end();
      });
      return events;
    } }) });
    await runner.run(input);
    expect(rendered).not.toContain("credential-secret");
    expect(rendered).toContain("MODEL_CREDENTIAL_REDACTED");
  });

  it("does not treat a truncated response as a valid result", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => message([{ type: "text", text: '{"summary":"truncated"}' }], "length")) }) });
    await expect(runner.run(input)).rejects.toThrow("length");
  });

  it.each(["decide", "execute", "metacog"] as const)("stops empty %s length output with no request cap", async mode => {
    const input = await request(mode);
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => { calls++; return message([], "length"); }) }) });
    await expect(runner.run(input)).rejects.toThrow("empty length response");
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(join(input.runDir, "continuation.json"), "utf8")).usage.input).toBe(13);
    await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a Run whose system/tools leave no model response capacity before calling the provider", async () => {
    const input = await request("execute"); let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model: { ...model, contextWindow: 4096 },
      streamFn: stream(() => { calls++; return message([{ type: "text", text: "unused" }]); }) }) });
    await expect(runner.run(input)).rejects.toThrow("context capacity exhausted");
    expect(calls).toBe(0);
  });

  it.each(["decide", "metacog", "execute"] as const)("continues multiple thinking-only %s length responses without adding a retry or output cap", async mode => {
    const input = await request(mode);
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const output = { summary: "Continued fixture reasoning finished", ...(mode === "execute" ? { result: "no_progress" } : {}) };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      calls++;
      expect(context.tools?.map(tool => tool.name)).toEqual(mode === "execute" ? ["read", "write", "edit", "powershell", "chrome", "submit"] : ["read", "submit"]);
      if (calls > 1) expect(context.messages.at(-1)?.role).toBe("user");
      return message(calls <= 5 ? [{ type: "thinking", thinking: `Unfinished fixture consideration ${calls}` }]
        : [{ type: "text", text: JSON.stringify(output) }], calls <= 5 ? "length" : "stop");
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual(output);
    expect(calls).toBe(6);
    expect(result.usage.input).toBe(6 * 13);
    expect(result.usage.output).toBe(6 * 4);
  });

  it("joins multiple JSON suffixes exactly across quoted text and validates only the finished object", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    const output = { summary: 'Synthetic "quoted" fixture with a \\ separator and 中文文字', result: "no_progress" };
    const body = JSON.stringify(output);
    const cuts = [0, 11, 23, 25, 31, body.length];
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (calls) expect(context.tools).toEqual([]);
      const text = body.slice(cuts[calls], cuts[calls + 1]);
      calls++;
      return message([{ type: "text", text }], calls < cuts.length - 1 ? "length" : "stop");
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual(output);
    expect(calls).toBe(5);
    expect(result.usage).toEqual({ input: 65, output: 20, cost: 0.1, cacheRead: 10, cacheInput: 65 });
    expect(JSON.parse(await readFile(join(input.runDir, "output.json"), "utf8")).output).toEqual(output);
  });

  it("does not insert separators between text blocks inside a continued JSON string", async () => {
    const input = await request();
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1
      ? message([{ type: "text", text: '{"summary":"hel' }], "length")
      : message([{ type: "text", text: "lo" }, { type: "text", text: ' world"}' }])) }) });
    expect((await runner.run(input)).output).toEqual({ summary: "hello world" });
    expect(calls).toBe(2);
  });

  it("keeps the exact accumulating JSON prefix when older work history is compacted", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTurnsPerRun = null;
    input.snapshot.config.limits.maxTokens = null;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const fragments = ['{"summary":"' + "a".repeat(2_000), "b".repeat(2_000), "c".repeat(2_000), '","result":"no_progress"}'];
    let mainCalls = 0;
    let summaryCalls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model: { ...model, contextWindow: 36_000 }, streamFn: stream(context => {
      if (context.systemPrompt?.startsWith("Summarize the older conversation")) {
        summaryCalls++;
        return message([{ type: "text", text: "Synthetic fixture was written once; use its completed read. No additional observations." }]);
      }
      mainCalls++;
      if (mainCalls === 1) return message([{ type: "toolCall", id: "fixture-write", name: "write",
        arguments: { path: "large-fixture.txt", content: "synthetic fixture ".repeat(2800) } }], "toolUse");
      if (mainCalls === 2) return message([{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "large-fixture.txt" } }], "toolUse");
      if (mainCalls > 3) {
        expect(context.tools).toEqual([]);
        const prefix = context.messages.findLast(item => item.role === "assistant");
        expect(prefix?.content).toEqual([{ type: "text", text: fragments.slice(0, mainCalls - 3).join("") }]);
      }
      return message([{ type: "text", text: fragments[mainCalls - 3] }], mainCalls < 6 ? "length" : "stop");
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "a".repeat(2_000) + "b".repeat(2_000) + "c".repeat(2_000), result: "no_progress" });
    expect(summaryCalls).toBeGreaterThan(0);
    expect(events.some(event => event.type === "notice" && event.text.includes("Private context compacted"))).toBe(true);
    expect(events.filter(event => event.type === "tool_start")).toHaveLength(2);
    expect(mainCalls).toBe(6);
    expect(result.usage.input).toBe((mainCalls + summaryCalls) * 13);
    expect(result.usage.output).toBe((mainCalls + summaryCalls) * 4);
  });

  it.each(["restart", "whitespace"] as const)("requires a completed provider response even for an already complete JSON prefix (%s)", async style => {
    const input = await request();
    const output = { summary: "Complete fixture observation" };
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (calls) expect(context.tools).toEqual([]);
      const text = ++calls === 1 || style === "restart" ? JSON.stringify(output) : " \n";
      return message([{ type: "text", text }], calls === 1 ? "length" : "stop");
    }) }) });
    expect((await runner.run(input)).output).toEqual(output);
    expect(calls).toBe(2);
  });

  it("continues a truncated protocol repair without accepting invalid assembled fields", async () => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    const chunks = ['{"summary":', "true}", '{"summary":"Corrected fixture', '"}'];
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (calls) expect(context.tools).toEqual([]);
      if (calls === 2) expect(JSON.stringify(context.messages.at(-1))).toContain("summary: Expected string");
      const text = chunks[calls++];
      return message([{ type: "text", text }], calls % 2 ? "length" : "stop");
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "Corrected fixture" });
    expect(result.usage).toEqual({ input: 52, output: 16, cost: 0.08, cacheRead: 8, cacheInput: 52 });
    expect(calls).toBe(4);
  });

  it("preserves Pi's refusal to execute tool calls from length-truncated responses", async () => {
    const input = await request("execute");
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "truncated-write", name: "write",
        arguments: { path: "must-not-exist.txt", content: "truncated fixture arguments" } }], "length");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "truncated-write", isError: true });
      return message([{ type: "text", text: '{"summary":"Truncated write was not executed","result":"no_progress"}' }]);
    }) }) });
    await runner.run(input);
    expect(calls).toBe(2);
    await expect(readFile(join(input.workspace, "must-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["maxTurnsPerRun", "maxTokens", "maxCost"] as const)("respects explicit %s when a length response needs continuation", async field => {
    const input = await request();
    input.snapshot.config.limits[field] = field === "maxCost" ? 0.001 : 1;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return message([{ type: "thinking", thinking: "Unfinished fixture consideration" }], "length");
    }) }) });
    await expect(runner.run(input)).rejects.toThrow("explicitly configured invocation budget");
    expect(calls).toBe(1);
    await expect(readFile(join(input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops length continuation when the user cancels and preserves consumed usage", async () => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    const control = new AbortController();
    input.signal = control.signal;
    let calls = 0;
    input.onEvent = event => { if (event.type === "usage" && calls === 2) control.abort(new Error("User cancelled continuation")); };
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return message([{ type: "thinking", thinking: "Unfinished fixture consideration" }], "length");
    }) }) });
    const failure = await runner.run(input).catch(error => error);
    expect(failure.message).toBe("User cancelled continuation");
    expect(failure.usage).toEqual({ input: 26, output: 8, cost: 0.04, cacheRead: 4, cacheInput: 26 });
    expect(calls).toBe(2);
  });

  it("can recover one transient connection error between length continuations", async () => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => {
      if (++calls === 2) return { ...message([], "error"), errorMessage: "503 temporary provider failure" };
      return message(calls < 4 ? [{ type: "thinking", thinking: "Unfinished fixture consideration" }]
        : [{ type: "text", text: '{"summary":"Resumed fixture review"}' }], calls < 4 ? "length" : "stop");
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "Resumed fixture review" });
    expect(result.usage).toEqual({ input: 52, output: 16, cost: 0.08, cacheRead: 8, cacheInput: 52 });
    expect(calls).toBe(4);
  });

  it.each(["Anthropic stream ended before message_stop", "Request timed out."])("discards the failed JSON suffix on %s while retaining a length prefix", async errorMessage => {
    const input = await request();
    input.snapshot.config.limits.maxTurnsPerRun = null;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "text", text: '{"summary":"Retained ' }], "length");
      expect(context.tools).toEqual([]);
      if (calls === 2) return { ...message([{ type: "text", text: 'FAILED_SUFFIX"}' }], "error"), errorMessage };
      expect(JSON.stringify(context.messages)).not.toContain("FAILED_SUFFIX");
      expect(context.messages.some(entry => entry.role === "assistant" && entry.content.some(part => part.type === "text" && part.text === '{"summary":"Retained '))).toBe(true);
      return message([{ type: "text", text: 'validated suffix"}' }]);
    }) }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "Retained validated suffix" });
    expect(result.usage).toEqual({ input: 39, output: 12, cost: 0.06, cacheRead: 6, cacheInput: 39 });
    expect(calls).toBe(3);
  });

  it("redacts JSON-encoded credentials across single-character streaming chunks", async () => {
    const input = await request();
    const secret = 'key-with-"quotes\\and-newline\n';
    let rendered = "";
    input.onEvent = event => { if (event.type === "text") rendered += event.text; };
    const runner = new PiRunner({ resolveModel: async () => ({ model, secrets: [secret], streamFn: () => {
      const output = new AssistantMessageEventStream();
      const text = JSON.stringify({ summary: secret });
      const result = message([{ type: "text", text }]);
      queueMicrotask(() => {
        output.push({ type: "start", partial: result });
        for (const delta of text) output.push({ type: "text_delta", contentIndex: 0, delta, partial: result });
        output.push({ type: "done", reason: "stop", message: result });
        output.end();
      });
      return output;
    } }) });
    expect((await runner.run(input)).output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    expect(JSON.parse(rendered)).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    const persisted = await readFile(join(input.runDir, "events.jsonl"), "utf8");
    expect(persisted).not.toContain("key-with-");
    for (const line of persisted.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("includes credentials refreshed by Pi after initial resolution in streaming and saved output redaction", async () => {
    const input = await request();
    const secrets = ["old-model-credential"];
    let rendered = "";
    input.onEvent = event => { if (event.type === "text") rendered += event.text; };
    const runner = new PiRunner({ resolveModel: async () => ({ model, secrets, streamFn: () => {
      secrets.push("new-refreshed-model-credential");
      const events = new AssistantMessageEventStream();
      const response = message([{ type: "text", text: '{"summary":"new-refreshed-model-credential old-model-credential"}' }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial: response });
        for (const delta of ['{"summary":"new-refreshed-', 'model-credential old-model-', 'credential"}']) {
          events.push({ type: "text_delta", contentIndex: 0, delta, partial: response });
        }
        events.push({ type: "done", reason: "stop", message: response });
        events.end();
      });
      return events;
    } }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED] [MODEL_CREDENTIAL_REDACTED]" });
    expect(rendered).toContain("MODEL_CREDENTIAL_REDACTED");
    for (const secret of secrets) {
      expect(rendered).not.toContain(secret);
      expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain(secret);
      expect(await readFile(join(input.runDir, "output.json"), "utf8")).not.toContain(secret);
    }
  });

  it("does not stop a Pi tool turn at disabled cumulative resource budgets", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTokens = null;
    input.snapshot.config.limits.maxCost = null;
    input.snapshot.usage = { input: 1_000_000, output: 100_000, cost: 100 };
    await writeFile(join(input.workspace, "fixture.txt"), "synthetic fixture");
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1
      ? message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "fixture.txt" } }], "toolUse")
      : message([{ type: "text", text: '{"summary":"tool result received","result":"done"}' }])) }) });
    expect((await runner.run(input)).output).toEqual({ summary: "tool result received", result: "done" });
    expect(calls).toBe(2);
  });

  it("rejects an already cancelled invocation before resolving the model", async () => {
    const input = await request();
    input.signal = AbortSignal.abort();
    let called = false;
    const runner = new PiRunner({ resolveModel: async () => { called = true; return { model, streamFn: stream("{}") }; } });
    await expect(runner.run(input)).rejects.toBeInstanceOf(RuntimeRunError);
    expect(called).toBe(false);
  });

  it("propagates live cancellation to Pi and waits for settlement", async () => {
    const input = await request();
    const abort = new AbortController();
    input.signal = abort.signal;
    let aborted = false;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: (_model, _context, options) => {
      const events = new AssistantMessageEventStream();
      const finish = () => { aborted = true; const failure = message([], "aborted"); events.push({ type: "error", reason: "aborted", error: failure }); events.end(); };
      options?.signal?.addEventListener("abort", finish, { once: true });
      queueMicrotask(() => abort.abort());
      return events;
    } }) });
    await expect(runner.run(input)).rejects.toBeInstanceOf(RuntimeRunError);
    expect(aborted).toBe(true);
  });

  it.each(["turns", "tokens", "cost"])("stops tool loops at the %s budget with partial usage retained", async (budget) => {
    const input = await request("execute");
    await writeFile(join(input.workspace, "fixture.txt"), "read me");
    if (budget === "turns") input.snapshot.config.limits.maxTurnsPerRun = 1;
    if (budget === "tokens") input.snapshot.config.limits.maxTokens = 15;
    if (budget === "cost") input.snapshot.config.limits.maxCost = 0.01;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => { calls++; return message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "fixture.txt" } }], "toolUse"); }) }) });
    const error = await runner.run(input).catch((failure) => failure);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("budget reached");
    expect(error.usage.input).toBe(13);
    expect(calls).toBe(1);
  });
});

describe("runtime protocol", () => {
  it("uses Pi's unmodified factory tool names", () => { expect(executeTools(process.cwd()).map((tool) => tool.name)).toEqual(["read", "write", "edit", "powershell"]); });
  it("accepts strict JSON or one JSON fence and rejects ambiguous output", () => {
    expect(parseFinalJson('{"summary":"ok"}')).toEqual({ summary: "ok" });
    expect(parseFinalJson('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" });
    for (const invalid of ["null", "[]", "1", "here: {}", "{} {}", '```json\n{}\n```\nextra']) expect(() => parseFinalJson(invalid)).toThrow();
  });
});

async function chatRequest(text = "first private chat message"): Promise<ChatRequest> {
  const input = await request();
  return { text, workspace: input.workspace, model: { provider: "test", model: "chat" }, limits: input.snapshot.config.limits, signal: input.signal, onEvent() {} };
}

async function thinkingHarness(kind: "chat" | "decide", streamFn: StreamFn, secrets: string[] = [], control?: AbortController, observe?: (event: RuntimeEvent) => void) {
  const input = await request();
  await writeFile(join(input.workspace, "public-evidence.txt"), "LOCAL FIXTURE ONLY");
  const events: RuntimeEvent[] = [];
  const agents: AgentOptions[] = [];
  input.onEvent = event => { events.push(event); observe?.(event); };
  if (control) input.signal = control.signal;
  const options = { resolveModel: async () => ({ model, streamFn, secrets }), createAgent: (entry: AgentOptions) => { agents.push(entry); return new Agent(entry); } };
  const completed = kind === "chat" ? new ChatSession(options).send({ text: "fixture", workspace: input.workspace, model: { provider: "test", model: "chat" }, limits: input.snapshot.config.limits, signal: input.signal, onEvent: input.onEvent })
    : new PiRunner(options).run(input);
  return { input, events, agents, completed };
}

function fixtureTool(kind: "chat" | "decide", id: string, path: string): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name: kind === "decide" ? "read" : "write",
    arguments: kind === "decide" ? { path: "public-evidence.txt" } : { path, content: "LOCAL FIXTURE ONLY" } };
}

function thinkingStream(response: AssistantMessage, chunks?: string[], noDeltas = false): StreamFn {
  return () => {
    const events = new AssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: response });
      response.content.forEach((content, contentIndex) => {
        if (content.type === "thinking") {
          events.push({ type: "thinking_start", contentIndex, partial: response });
          if (!noDeltas) for (const delta of chunks ?? [content.thinking]) events.push({ type: "thinking_delta", contentIndex, delta, partial: response });
          events.push({ type: "thinking_end", contentIndex, content: content.thinking, partial: response });
        } else if (content.type === "text") events.push({ type: "text_delta", contentIndex, delta: content.text, partial: response });
      });
      events.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
      events.end();
    });
    return events;
  };
}

describe.each(["chat", "decide"] as const)("completed-message narration and reported usage in %s", kind => {
  const answer = kind === "chat" ? "The local fixture is verified." : '{"summary":"The local fixture is verified."}';
  const sumUsage = (events: RuntimeEvent[]) => events.filter(event => event.type === "usage").reduce((total, event) => ({
    input: total.input + event.usage!.input, output: total.output + event.usage!.output, cost: total.cost + event.usage!.cost,
    cacheRead: total.cacheRead + event.usage!.cacheRead!, cacheInput: total.cacheInput + event.usage!.cacheInput!,
  }), { input: 0, output: 0, cost: 0, cacheRead: 0, cacheInput: 0 });

  it("identifies one message across interleaved text, thoughts and narration without reusing IDs across rounds", async () => {
    let calls = 0;
    const test = await thinkingHarness(kind, (selected, context, options) => {
      const response = ++calls === 1 ? message([
        { type: "text", text: "I will inspect a local fixture." },
        { type: "thinking", thinking: "Provider-returned thought." },
        { type: "text", text: "I will keep the observed result." },
        fixtureTool(kind, "id-write", "id-fixture.txt"),
      ], "toolUse") : message([
        { type: "thinking", thinking: "Next provider-returned thought." },
        { type: "text", text: answer },
      ]);
      return thinkingStream(response)(selected, context, options);
    });
    await test.completed;
    const boundary = test.events.findIndex(event => event.type === "tool_start");
    const belongsToMessage = (event: RuntimeEvent) => ["text", "narration", "thinking_start", "thinking", "thinking_end"].includes(event.type);
    const first = test.events.slice(0, boundary).filter(belongsToMessage);
    const second = test.events.slice(boundary).filter(belongsToMessage);
    expect(first.map(event => event.type)).toEqual(["text", "thinking_start", "thinking", "thinking_end", "text", "narration"]);
    expect(new Set(first.map(event => event.messageId)).size).toBe(1);
    expect(new Set(second.map(event => event.messageId)).size).toBe(1);
    expect(first[0]!.messageId).toEqual(expect.any(String));
    expect(second[0]!.messageId).toEqual(expect.any(String));
    expect(first[0]!.messageId).not.toBe(second[0]!.messageId);
  });

  it("emits actual pre-tool prose once and reports one usage event per assistant message, not per tool", async () => {
    let calls = 0;
    const narration = "I will inspect the local fixture and verify it again.";
    const test = await thinkingHarness(kind, stream(context => {
      if (++calls === 1) return message([
        { type: "text", text: narration },
        fixtureTool(kind, "narration-write", "narration-fixture.txt"),
        { type: "toolCall", id: "narration-read", name: "read", arguments: { path: kind === "decide" ? "public-evidence.txt" : "narration-fixture.txt" } },
      ], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      const response = message([{ type: "text", text: answer }]);
      response.usage = { input: 20, output: 6, cacheRead: 3, cacheWrite: 4, totalTokens: 33,
        cost: { input: 0.03, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 } };
      return response;
    }));
    const completed = await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([{ type: "narration", mode: kind, messageId: expect.any(String), text: narration }]);
    expect(test.events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", mode: kind, text: "", usage: { input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 } },
      { type: "usage", mode: kind, text: "", usage: { input: 27, output: 6, cost: 0.05, cacheRead: 3, cacheInput: 27 } },
    ]);
    expect(sumUsage(test.events)).toEqual("usage" in completed ? completed.usage : completed);
    expect(test.events.filter(event => event.type === "tool_start")).toHaveLength(2);
    expect(test.events.findIndex(event => event.type === "narration")).toBeLessThan(test.events.findIndex(event => event.type === "tool_start"));
    expect(test.events.findIndex(event => event.type === "usage")).toBeLessThan(test.events.findIndex(event => event.type === "tool_start"));
    expect(await readFile(join(test.input.workspace, kind === "decide" ? "public-evidence.txt" : "narration-fixture.txt"), "utf8")).toBe("LOCAL FIXTURE ONLY");
  });

  it.each([
    ["raw object", '{"summary":"machine protocol"}'],
    ["raw array", '[{"action":"read"}]'],
    ["JSON fence", '```json\n{"summary":"machine protocol"}\n```'],
    ["plain JSON fence", '```\n{"summary":"machine protocol"}\n```'],
    ["array JSON fence", '```json\n["machine protocol"]\n```'],
    ["raw JSON scalar", "42"],
    ["scalar JSON fence", '```json\n42\n```'],
  ])("does not turn %s into natural-language narration", async (_label, protocol) => {
    let calls = 0;
    const test = await thinkingHarness(kind, stream(() => ++calls === 1 ? message([
      { type: "text", text: protocol! },
      fixtureTool(kind, "protocol-write", "protocol-fixture.txt"),
    ], "toolUse") : message([{ type: "text", text: answer }])));
    await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(2);
  });

  it("never invents pre-tool narration for a pure tool call or final JSON", async () => {
    let calls = 0;
    const finalJson = '{"summary":"Only structured final output"}';
    const test = await thinkingHarness(kind, stream(() => ++calls === 1 ? message([
      fixtureTool(kind, "silent-write", "silent-fixture.txt"),
    ], "toolUse") : message([{ type: "text", text: finalJson }])));
    const completed = await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(2);
    expect(sumUsage(test.events)).toEqual("usage" in completed ? completed.usage : completed);
  });

  it("redacts known model credentials in actual streamed narration", async () => {
    let calls = 0;
    const test = await thinkingHarness(kind, (selected, context, options) => {
      const response = ++calls === 1 ? message([
        { type: "text", text: "I will inspect the fixture using credential-secret." },
        fixtureTool(kind, "redacted-narration-write", "redacted-fixture.txt"),
      ], "toolUse") : message([{ type: "text", text: answer }]);
      return thinkingStream(response)(selected, context, options);
    }, ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([
      { type: "narration", mode: kind, messageId: expect.any(String), text: "I will inspect the fixture using [MODEL_CREDENTIAL_REDACTED]." },
    ]);
    expect(JSON.stringify(test.events)).not.toContain("credential-secret");
  });

  it.each(["error", "aborted"] as const)("reports known usage for an assistant %s instead of inventing missing consumption", async stopReason => {
    const abort = new AbortController();
    let calls = 0;
    const test = await thinkingHarness(kind, (_model, _context, options) => {
      if (++calls === 1) return stream(() => message([
        fixtureTool(kind, "usage-write", "usage-fixture.txt"),
      ], "toolUse"))(_model, _context, options);
      const output = new AssistantMessageEventStream();
      const failure = { ...message([], stopReason), errorMessage: "Synthetic provider interruption" };
      failure.usage = { input: 7, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: 13,
        cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
      const finish = () => { output.push({ type: "error", reason: stopReason, error: failure }); output.end(); };
      if (stopReason === "aborted") {
        options?.signal?.addEventListener("abort", finish, { once: true });
        queueMicrotask(() => abort.abort());
      } else queueMicrotask(finish);
      return output;
    }, [], abort);
    const failure = await test.completed.catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(test.events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", mode: kind, text: "", usage: { input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 } },
      { type: "usage", mode: kind, text: "", usage: { input: 12, output: 1, cost: 0.03, cacheRead: 2, cacheInput: 12 } },
    ]);
    expect(sumUsage(test.events)).toEqual(failure.usage);
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
  });
});

describe.each(["chat", "decide"] as const)("Pi-returned thinking in %s", kind => {
  const answer = kind === "chat" ? "Ordinary answer." : '{"summary":"Ordinary answer."}';

  it("forwards distinct thinking start/delta/end events without changing thinking settings or mixing answer text", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "Actual provider-returned thought.", thinkingSignature: "OPAQUE_SIGNATURE_NOT_TEXT" },
      { type: "text", text: answer },
    ])));
    await test.completed;
    const thoughts = test.events.filter(event => event.type.startsWith("thinking"));
    expect(thoughts.map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(thoughts.map(event => event.text)).toEqual(["", "Actual provider-returned thought.", ""]);
    expect(thoughts.every(event => event.mode === kind && typeof event.blockId === "string")).toBe(true);
    expect(thoughts.every(event => !Object.hasOwn(event, "replayed"))).toBe(true);
    expect(new Set(thoughts.map(event => event.blockId)).size).toBe(1);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe(answer);
    expect(JSON.stringify(test.events)).not.toContain("OPAQUE_SIGNATURE_NOT_TEXT");
    expect(test.agents[0]?.initialState?.thinkingLevel).toBe("off");
  });

  it("redacts model credentials split across thought chunks and does not duplicate the message-end fallback", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "Analyze credential-secret privately." }, { type: "text", text: answer },
    ]), ["Analyze cred", "ential-", "secret privately."]), ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text).join("")).toBe("Analyze [MODEL_CREDENTIAL_REDACTED] privately.");
    expect(test.events.filter(event => event.type === "thinking_start")).toHaveLength(1);
    expect(test.events.filter(event => event.type === "thinking_end")).toHaveLength(1);
    expect(JSON.stringify(test.events)).not.toContain("credential-secret");
    if (kind === "decide") expect(await readFile(join(test.input.runDir, "events.jsonl"), "utf8")).not.toContain("credential-secret");
  });

  it("falls back only to actual non-redacted thinking returned in message_end", async () => {
    const test = await thinkingHarness(kind, stream(() => message([
      { type: "thinking", thinking: "MUST_NOT_EXPOSE_REDACTED_PAYLOAD", redacted: true, thinkingSignature: "OPAQUE_REDACTED_SIGNATURE" },
      { type: "thinking", thinking: "Actually returned credential-secret thought.", thinkingSignature: "OPAQUE_SIGNATURE" },
      { type: "thinking", thinking: "", thinkingSignature: "OPAQUE_ONLY" },
      { type: "text", text: answer },
    ])), ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => [event.type, event.text])).toEqual([
      ["thinking_start", ""], ["thinking", "Actually returned [MODEL_CREDENTIAL_REDACTED] thought."], ["thinking_end", ""],
    ]);
    expect(test.events.filter(event => event.type.startsWith("thinking")).every(event => event.replayed === true)).toBe(true);
    expect(JSON.stringify(test.events)).not.toMatch(/OPAQUE|MUST_NOT_EXPOSE|credential-secret/);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).not.toContain("Actually returned");
  });

  it("handles providers that return thought content at thinking_end without delta events", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([{ type: "thinking", thinking: "Provider end-only thought." }, { type: "text", text: answer }]), undefined, true));
    await test.completed;
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text).join("")).toBe("Provider end-only thought.");
    expect(test.events.filter(event => event.type === "thinking_end")).toHaveLength(1);
  });

  it("suppresses streaming redacted thinking and never decodes signatures as text", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "OPAQUE_REDACTED_DATA", redacted: true, thinkingSignature: "DO_NOT_DECODE" },
      { type: "text", text: answer },
    ])));
    await test.completed;
    expect(test.events.some(event => event.type.startsWith("thinking"))).toBe(false);
    expect(JSON.stringify(test.events)).not.toMatch(/OPAQUE_REDACTED_DATA|DO_NOT_DECODE/);
  });

  it("uses unique message/content-index block IDs across a native tool turn", async () => {
    let calls = 0;
    const fn: StreamFn = (selected, context, options) => thinkingStream(++calls === 1 ? message([
      { type: "thinking", thinking: "First block." }, { type: "thinking", thinking: "Second block." },
      fixtureTool(kind, "thinking-write", "thought-fixture.txt"),
    ], "toolUse") : message([{ type: "thinking", thinking: "Next message block." }, { type: "text", text: answer }]))(selected, context, options);
    const test = await thinkingHarness(kind, fn);
    await test.completed;
    const starts = test.events.filter(event => event.type === "thinking_start");
    const ends = test.events.filter(event => event.type === "thinking_end");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map(event => event.blockId)).size).toBe(3);
    expect(starts.map(event => event.blockId?.split(":").slice(-2))).toEqual([["1", "0"], ["1", "1"], ["2", "0"]]);
    expect(ends.map(event => event.blockId)).toEqual(starts.map(event => event.blockId));
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["First block.", "Second block.", "Next message block."]);
    const toolStart = test.events.findIndex(event => event.type === "tool_start");
    const toolEnd = test.events.findIndex(event => event.type === "tool_end");
    expect(test.events.indexOf(ends[1]!)).toBeLessThan(toolStart);
    expect(test.events.indexOf(starts[2]!)).toBeGreaterThan(toolEnd);
  });

  it("ends a streamed thought on provider error while retaining only returned content", async () => {
    const test = await thinkingHarness(kind, () => {
      const events = new AssistantMessageEventStream();
      const partial = message([{ type: "thinking", thinking: "Returned partial thought." }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial });
        events.push({ type: "thinking_start", contentIndex: 0, partial });
        events.push({ type: "thinking_delta", contentIndex: 0, delta: "Returned partial thought.", partial });
        events.push({ type: "error", reason: "error", error: { ...message([], "error"), errorMessage: "Synthetic provider error" } });
        events.end();
      });
      return events;
    });
    const error = await test.completed.catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("Synthetic provider error");
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["Returned partial thought."]);
    expect(test.events.filter(event => event.type === "text")).toEqual([]);
  });

  it("settles an open thought when cancelled and does not invent answer text or a completion", async () => {
    const abort = new AbortController();
    const test = await thinkingHarness(kind, (_model, _context, options) => {
      const events = new AssistantMessageEventStream();
      const partial = message([{ type: "thinking", thinking: "Thought before cancellation." }]);
      options?.signal?.addEventListener("abort", () => {
        events.push({ type: "error", reason: "aborted", error: message([], "aborted") }); events.end();
      }, { once: true });
      queueMicrotask(() => {
        events.push({ type: "start", partial });
        events.push({ type: "thinking_start", contentIndex: 0, partial });
        events.push({ type: "thinking_delta", contentIndex: 0, delta: "Thought before cancellation.", partial });
      });
      return events;
    }, [], abort, event => { if (event.type === "thinking") abort.abort(); });
    await expect(test.completed).rejects.toBeInstanceOf(RuntimeRunError);
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(test.events.filter(event => event.type === "text")).toEqual([]);
    expect(test.events.filter(event => event.type === "thinking_end")[0]?.blockId).toBe(test.events[0]?.blockId);
  });
});

describe("private Pi chat session", () => {
  it("uses Chrome through the actual Pi loop on consecutive replies, with private artifacts and a configurable fifth tool", async () => {
    const input = await chatRequest(); input.limits.maxTurnsPerRun = 5;
    const events: RuntimeEvent[] = []; input.onEvent = event => events.push(event);
    const closed = vi.fn(), storageDirectory = join(input.workspace, "chat-storage");
    let requests = 0;
    const factory = vi.fn((options: Parameters<typeof createChromeSession>[0]) => {
      const session = createChromeSession(options, () => new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/chrome-server.mjs", import.meta.url))], stderr: "ignore" }));
      return { ...session, close: async () => { await session.close(); closed(); } };
    });
    const session = new ChatSession({ storageDirectory, createChrome: factory, resolveModel: async () => ({ model, streamFn: stream(context => {
      if (input.chrome?.enabled === false) { expect(context.tools?.map(tool => tool.name)).not.toContain("chrome"); return message([{ type: "text", text: "Disabled" }]); }
      const args = [{ action: "list" }, { action: "describe", tool: "echo" }, { action: "call", tool: "echo", args: { value: "private browser result" } }][requests++ % 4];
      if (args) return message([{ type: "toolCall", id: `chat-chrome-${requests}`, name: "chrome", arguments: args }], "toolUse");
      expect(JSON.stringify(context.messages)).toContain("private browser result");
      expect(JSON.stringify(context.messages)).toContain("chat-storage");
      return message([{ type: "text", text: "Verified private fixture" }]);
    }) }) });
    try {
      await session.send(input); await session.send({ ...input, text: "continue" });
      expect(factory).toHaveBeenCalledTimes(2); expect(closed).toHaveBeenCalledTimes(2);
      expect(events.filter(event => event.type === "tool_end" && event.toolName === "chrome")).toHaveLength(6);
      expect(events.some(event => event.isError)).toBe(false);
      input.chrome = { enabled: false }; await session.send(input); expect(factory).toHaveBeenCalledTimes(2);
      await expect(readFile(join(input.workspace, "blackboard.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { session.close(); }
  });

  it("shares the actual persistent daemon between Chat and Execute through replies, resets, errors and cancellation", async () => {
    const run = await request("execute"), input = await chatRequest(); input.workspace = run.workspace;
    const options = { workspace: run.workspace, artifactsDirectory: run.runDir };
    let calls = 0, outcome = "success";
    const control = new AbortController();
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      if (++calls % 2 === 1) return message([{ type: "toolCall", id: `offline-${calls}`, name: "chrome", arguments: { action: "call", tool: "take_snapshot", args: { pageId: "offline-invalid" } } }], "toolUse");
      if (outcome === "cancel") control.abort();
      return outcome === "failure" ? { ...message([], "error"), errorMessage: "Synthetic fatal model failure" } : message([{ type: "text", text: "PRIVATE_CHAT_RESULT" }]);
    }) }) });
    try {
      await session.send(input);
      const original = await controlChrome(options, "status"); expect(original.bridgeRunning).toBe(true);
      await session.send(input); session.reset();
      outcome = "failure"; await expect(session.send(input)).rejects.toThrow("Synthetic fatal"); session.reset();
      outcome = "cancel"; await expect(session.send({ ...input, signal: control.signal })).rejects.toThrow(); session.close();
      expect(await controlChrome(options, "status")).toEqual(original);
      let turns = 0;
      const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
        expect(JSON.stringify(context)).not.toContain("PRIVATE_CHAT_RESULT");
        return ++turns === 1 ? message([{ type: "toolCall", id: "execute-browser", name: "chrome", arguments: { action: "call", tool: "take_snapshot", args: { pageId: "offline-invalid" } } }], "toolUse")
          : message([{ type: "text", text: '{"summary":"Offline schema fixture","result":"done"}' }]);
      }) }) });
      await runner.run(run);
      expect(await controlChrome(options, "status")).toEqual(original);
    } finally { session.close(); await controlChrome(options, "disconnect"); }
  }, 30_000);

  it("retains ordinary chat history, streams natural text and counts each response's usage", async () => {
    const input = await chatRequest();
    const seen: Context[] = [];
    const events: RuntimeEvent[] = [];
    const agents: AgentOptions[] = [];
    input.onEvent = event => events.push(event);
    let resolves = 0;
    const session = new ChatSession({
      resolveModel: async () => { resolves++; return { model, streamFn: stream("A natural language reply, not JSON.", seen) }; },
      createAgent: options => { agents.push(options); return new Agent(options); },
    });
    expect(await session.send(input)).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
    expect(await session.send({ ...input, text: "second message" })).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
    expect(resolves).toBe(2);
    expect(agents).toHaveLength(1);
    expect(agents[0].initialState?.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome"]);
    expect(agents[0].beforeToolCall).toBeUndefined();
    expect(agents[0].afterToolCall).toBeUndefined();
    expect(seen.map(context => context.messages.length)).toEqual([1, 3]);
    expect(JSON.stringify(seen[1])).toContain("first private chat message");
    expect(JSON.stringify(seen[1])).toContain("A natural language reply, not JSON.");
    expect(seen[0].systemPrompt).not.toContain("Return one JSON object");
    expect(events.filter(event => event.type === "text")).toEqual([
      { type: "text", mode: "chat", messageId: expect.any(String), text: "A natural language reply, not JSON." },
      { type: "text", mode: "chat", messageId: expect.any(String), text: "A natural language reply, not JSON." },
    ]);
  });

  it("executes native tools in a continuing chat without creating a red-team blackboard", async () => {
    const input = await chatRequest("Write and inspect a synthetic fixture");
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    let calls = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "chat-write", name: "write", arguments: { path: "chat-fixture.txt", content: "chat-only fixture" } }], "toolUse");
      if (calls === 2) return message([{ type: "toolCall", id: "chat-read", name: "read", arguments: { path: "chat-fixture.txt" } }], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      expect(JSON.stringify(context.messages.at(-1))).toContain("chat-only fixture");
      return message([{ type: "text", text: "The fixture is written and verified." }]);
    }) }) });
    expect(await session.send(input)).toEqual({ input: 39, output: 12, cost: 0.06, cacheRead: 6, cacheInput: 39 });
    expect(await readFile(join(input.workspace, "chat-fixture.txt"), "utf8")).toBe("chat-only fixture");
    expect(events.filter(event => event.type === "tool_end").map(event => [event.mode, event.toolName])).toEqual([["chat", "write"], ["chat", "read"]]);
    await expect(readFile(join(input.workspace, "state", "blackboard.md"))).rejects.toThrow();
  });

  it("never hands private chat history to the two-agent runner", async () => {
    const input = await chatRequest();
    const contexts: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream("PRIVATE_CHAT_REPLY", contexts) }) });
    await session.send(input);
    const redteam: Context[] = [];
    const runner = new PiRunner({ resolveModel: async config => ({ model, streamFn: stream(JSON.stringify({ summary: "public board only", ...(config.model === "execute" ? { result: "no_progress" } : {}) }), redteam) }) });
    for (const mode of ["decide", "execute", "metacog"] as const) await runner.run(await request(mode));
    expect(redteam.every(context => context.messages.length === 1)).toBe(true);
    for (const privateText of [input.text, "PRIVATE_CHAT_REPLY"]) expect(JSON.stringify(redteam)).not.toContain(privateText);
  });

  it.each(["reset", "model", "workspace"])("starts a fresh transcript after %s changes", async kind => {
    const input = await chatRequest();
    const seen: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream("old private answer", seen) }) });
    await session.send(input);
    const next = { ...input, text: "new task" };
    if (kind === "reset") session.reset();
    if (kind === "model") next.model = { ...input.model, model: "different-model" };
    if (kind === "workspace") next.workspace = (await chatRequest()).workspace;
    await session.send(next);
    expect(seen.map(context => context.messages.length)).toEqual([1, 1]);
    expect(JSON.stringify(seen[1])).not.toContain(input.text);
    expect(JSON.stringify(seen[1])).not.toContain("old private answer");
  });

  it("rejects pre-cancelled messages before model resolution", async () => {
    const resolver = vi.fn();
    const session = new ChatSession({ resolveModel: resolver });
    await expect(session.send({ ...await chatRequest(), signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RuntimeRunError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["abort", "reset", "timeout"])("propagates %s to the active Pi reply and permits a later fresh request", async kind => {
    const input = await chatRequest();
    const control = new AbortController();
    input.signal = control.signal;
    if (kind === "timeout") input.limits.stepTimeoutSeconds = 0.005;
    let didAbort = false;
    let calls = 0;
    let session: ChatSession;
    session = new ChatSession({ resolveModel: async () => ({ model, streamFn: (_model, _context, options) => {
      if (++calls > 1) return stream("After cancellation")(_model, _context, options);
      const events = new AssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        didAbort = true;
        events.push({ type: "error", reason: "aborted", error: message([], "aborted") });
        events.end();
      }, { once: true });
      queueMicrotask(() => {
        if (kind === "abort") control.abort();
        if (kind === "reset") session.reset();
      });
      return events;
    } }) });
    const failure = await session.send(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    if (kind === "timeout") expect(failure.message).toContain("timed out");
    expect(didAbort).toBe(true);
    session.reset();
    expect(await session.send({ ...input, signal: new AbortController().signal, limits: { ...input.limits, stepTimeoutSeconds: 60 } })).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
  });

  it("keeps an unlimited chat reply active beyond three minutes without a timeout and still accepts cancellation", async () => {
    const input = await chatRequest();
    input.limits.stepTimeoutSeconds = null;
    const control = new AbortController();
    input.signal = control.signal;
    let begin!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    let providerSignal: AbortSignal | undefined;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: (_model, _context, options) => {
      providerSignal = options?.signal;
      const events = new AssistantMessageEventStream();
      providerSignal?.addEventListener("abort", () => {
        events.push({ type: "error", reason: "aborted", error: message([], "aborted") });
        events.end();
      }, { once: true });
      begin();
      return events;
    } }) });
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const active = session.send(input).catch(error => error);
    try {
      await begun;
      expect(timer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(providerSignal?.aborted).toBe(false);
      control.abort(new Error("User paused the long reply"));
      const failure = await active;
      expect(failure).toBeInstanceOf(RuntimeRunError);
      expect(failure.message).toContain("User paused the long reply");
      expect(failure.usage).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      control.abort();
      await active;
      session.reset();
      timer.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects simultaneous chat sends without injecting them into the active history", async () => {
    const input = await chatRequest();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const seen: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => { await waiting; return { model, streamFn: stream("done", seen) }; } });
    const active = session.send(input);
    await expect(session.send({ ...input, text: "MUST_NOT_ENTER_HISTORY" })).rejects.toThrow("already running");
    release();
    await active;
    expect(JSON.stringify(seen)).not.toContain("MUST_NOT_ENTER_HISTORY");
  });

  it.each(["turns", "tokens", "cost"])("settles chat tool loops at the %s reply budget and keeps partial usage", async budget => {
    const input = await chatRequest();
    if (budget === "turns") input.limits.maxTurnsPerRun = 1;
    if (budget === "tokens") input.limits.maxTokens = 15;
    if (budget === "cost") input.limits.maxCost = 0.01;
    await writeFile(join(input.workspace, "fixture.txt"), "fixture");
    let calls = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return message([{ type: "toolCall", id: "chat-bounded-read", name: "read", arguments: { path: "fixture.txt" } }], "toolUse");
    }) }) });
    const error = await session.send(input).catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("budget reached");
    expect(error.usage).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
    expect(calls).toBe(1);
  });

  it("redacts refreshed credentials across streaming chunks and user input", async () => {
    const input = await chatRequest("Check credential-secret");
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const secrets = ["credential-secret"];
    const session = new ChatSession({ resolveModel: async () => ({ model, secrets, streamFn: (_model, context) => {
      expect(JSON.stringify(context)).not.toContain("credential-secret");
      secrets.push("refreshed-credential-secret");
      const result = message([{ type: "text", text: "credential-secret refreshed-credential-secret" }]);
      const output = new AssistantMessageEventStream();
      queueMicrotask(() => {
        output.push({ type: "start", partial: result });
        for (const delta of ["credential-", "secret refreshed-cred", "ential-secret"]) output.push({ type: "text_delta", contentIndex: 0, delta, partial: result });
        output.push({ type: "done", reason: "stop", message: result });
        output.end();
      });
      return output;
    } }) });
    await session.send(input);
    const rendered = events.filter(event => event.type === "text").map(event => event.text).join("");
    expect(rendered).toBe("[MODEL_CREDENTIAL_REDACTED] [MODEL_CREDENTIAL_REDACTED]");
  });

  it("redacts explicit credential resolver failures and keeps provider-failure usage", async () => {
    vi.stubEnv("CHAT_TEST_TOKEN", "chat-explicit-test-key");
    const input = await chatRequest();
    input.model.apiKeyEnv = "CHAT_TEST_TOKEN";
    const broken = new ChatSession({ resolveModel: async () => { throw new Error("invalid chat-explicit-test-key"); } });
    const resolutionError = await broken.send(input).catch(error => error);
    expect(resolutionError.message).toBe("invalid [MODEL_CREDENTIAL_REDACTED]");
    expect(resolutionError.usage).toEqual({ input: 0, output: 0, cost: 0 });
    const failed = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => ({ ...message([], "error"), errorMessage: "Provider rejected chat-explicit-test-key" })) }) });
    const providerError = await failed.send(input).catch(error => error);
    expect(providerError.message).toBe("Provider rejected [MODEL_CREDENTIAL_REDACTED]");
    expect(providerError.usage).toEqual({ input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 });
  });
});
