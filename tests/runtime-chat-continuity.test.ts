import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import { ChatSession, type ChatRequest } from "../src/runtime/chat.js";
import { RuntimeRunError } from "../src/runtime/pi-runner.js";
import { CONTEXT_SUMMARY_MARKER, isTransientModelFailure } from "../src/runtime/continuity.js";
import type { RuntimeEvent } from "../src/types.js";

const model: Model<"openai-completions"> = {
  id: "mock", name: "mock", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 24000, maxTokens: 1000,
};
const usage: Usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4,
  cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", providerUsage = usage): AssistantMessage => ({
  role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, usage: providerUsage, timestamp: Date.now(),
});
function stream(produce: (context: Context) => AssistantMessage): StreamFn {
  return (_model, context) => {
    const events = new AssistantMessageEventStream();
    const response = produce(context);
    queueMicrotask(() => {
      if (response.stopReason === "error" || response.stopReason === "aborted") events.push({ type: "error", reason: response.stopReason, error: response });
      else events.push({ type: "done", reason: response.stopReason as "stop" | "length" | "toolUse", message: response });
      events.end();
    });
    return events;
  };
}
async function request() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-chat-continuity-"));
  dirs.push(directory);
  const events: RuntimeEvent[] = [];
  const input: ChatRequest = { text: "Inspect local synthetic fixtures and retain unresolved hypothesis A + B.", workspace: directory,
    model: { provider: "test", model: "mock" }, signal: new AbortController().signal, onEvent: event => events.push(event),
    limits: { maxNoProgress: 3, maxMinutes: 30, maxTokens: null, maxCost: null, maxTurnsPerRun: null, stepTimeoutSeconds: 180, metacogEvery: 3 } };
  return { input, events, directory };
}
const isSummary = (context: Context) => context.systemPrompt?.startsWith("Summarize the older conversation") ?? false;

describe("durable private chat", () => {
  it("compacts a small-context chat including tool overhead when usage is unavailable within one session", async () => {
    const { input, directory } = await request();
    input.chrome = { enabled: false };
    const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let summaries = 0, replies = 0;
    const create = () => new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({
      model: { ...model, contextWindow: 12000 }, streamFn: stream(context => {
        if (isSummary(context)) {
          summaries++;
          return assistant([{ type: "text", text: "Earlier synthetic chat data received; no tool actions or verified research findings." }], "stop", zero);
        }
        replies++;
        expect(JSON.stringify(context.messages.at(-1))).toContain(`CURRENT_TURN_${replies}`);
        return assistant([{ type: "text", text: `Reply ${replies}` }], "stop", zero);
      }),
    }) });
    let session = create(), file: string | undefined;
    for (let turn = 1; turn <= 20; turn++) {
      await session.send({ ...input, text: `CURRENT_TURN_${turn}\n` + "Synthetic inert data. ".repeat(150) });
      file ??= session.history().file;
      expect(session.history().file).toBe(file);
    }
    expect(replies).toBe(20); expect(summaries).toBeGreaterThan(0);
    expect(session.history().messages.at(-1)?.text).toBe("Reply 20");
    expect(session.history().pendingToolCalls).toEqual([]);
    session.close();
  });

  it.each([false, true])("rejects oversized input before changing chat or making a request (existing=%s)", async existing => {
    const { input, directory } = await request();
    let calls = 0;
    const session = new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({ model,
      streamFn: stream(() => { calls++; return assistant([{ type: "text", text: "Useful prior reply" }]); }) }) });
    if (existing) await session.send(input);
    const before = session.history();
    const bytes = before.file ? await readFile(before.file, "utf8") : undefined;
    await expect(session.send({ ...input, text: "a".repeat(715000) })).rejects.toThrow("This message was not added");
    expect(calls).toBe(existing ? 1 : 0);
    expect(session.history()).toEqual(before);
    if (before.file) expect(await readFile(before.file, "utf8")).toBe(bytes);
    await session.send({ ...input, text: "A short follow-up" });
    expect(calls).toBe(existing ? 2 : 1);
  });

  it("starts normally with an old oversized archive and leaves its bytes untouched", async () => {
    const { input, directory } = await request();
    let calls = 0;
    const create = () => new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({ model,
      streamFn: stream(() => { calls++; return assistant([{ type: "text", text: "Fixture" }]); }) }) });
    const first = create(); await first.send(input);
    const file = first.history().file!; first.close();
    const checkpoint = JSON.parse(await readFile(file, "utf8"));
    checkpoint.messages[0].content = "f".repeat(715000);
    const poisoned = JSON.stringify(checkpoint); await writeFile(file, poisoned);
    const second = create();
    expect(second.history().messages).toEqual([]);
    await second.send({ ...input, text: "New small input" });
    expect(calls).toBe(2);
    expect(await readFile(file, "utf8")).toBe(poisoned);
    expect(second.history().file).not.toBe(file);
    expect(await readFile(file, "utf8")).toBe(poisoned);
  });
  it("archives sanitized tool results but starts a new session with empty context and zero usage", async () => {
    const { input, directory } = await request();
    const storageDirectory = join(directory, "chats");
    let calls = 0;
    const first = new ChatSession({ storageDirectory, resolveModel: async () => ({ model: { ...model, contextWindow: 100000 }, secrets: ["fixture-private-key"], streamFn: stream(() => ++calls === 1 ? assistant([
      { type: "thinking", thinking: "private chain of thought fixture" },
      { type: "toolCall", id: "saved-write", name: "write", arguments: { path: "saved.txt", content: "observed local result" } },
    ], "toolUse") : assistant([{ type: "text", text: "Saved fixture-private-key" }])) }) });
    await first.send(input);
    const file = first.history().file!;
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("fixture-private-key"); expect(text).not.toContain("private chain of thought fixture");
    expect(first.history().pendingToolCalls).toEqual([]);
    const previousUsage = first.getUsage();
    first.close();
    const second = new ChatSession({ storageDirectory, resolveModel: async () => ({ model: { ...model, contextWindow: 100000 }, streamFn: stream(context => {
      expect(context.messages).toHaveLength(1);
      expect(JSON.stringify(context.messages)).not.toContain(input.text);
      expect(JSON.stringify(context.messages)).not.toContain("saved-write");
      return assistant([{ type: "text", text: "New session reply" }]);
    }) }) });
    expect(second.history()).toMatchObject({ messages: [], pendingToolCalls: [], usage: { input: 0, output: 0, cost: 0 } });
    expect(second.getUsage()).toEqual({ input: 0, output: 0, cost: 0 });
    await second.send({ ...input, text: "New discussion" });
    expect(second.history().file).not.toBe(file);
    expect(second.getUsage().input).toBe(3);
    expect(previousUsage.cacheRead).toBe(2);
    expect(second.getUsage()).toMatchObject({ cacheRead: 1, cacheInput: 3 });
    expect(second.history().usage).toEqual(second.getUsage());
    expect(await readFile(join(directory, "saved.txt"), "utf8")).toBe("observed local result");
    expect(calls).toBe(2);
    expect(await readFile(file, "utf8")).toBe(text);
    second.close();
  });

  it.each(["reset", "endpoint", "close"])("starts a separate chat after %s within the same instance and retains the old archive", async change => {
    const { input, directory } = await request(); const storageDirectory = join(directory, "chats");
    let endpoint = model.baseUrl;
    let calls = 0;
    const create = () => new ChatSession({ storageDirectory, resolveModel: async () => ({ model: { ...model, baseUrl: endpoint }, streamFn: stream(context => {
      if (++calls > 1) expect(JSON.stringify(context.messages)).not.toContain("OLD_PRIVATE_CHAT");
      return assistant([{ type: "text", text: "Fixture response" }]);
    }) }) });
    const first = create(); await first.send({ ...input, text: "OLD_PRIVATE_CHAT" }); const old = first.history().file!;
    if (change === "reset") first.reset(); else if (change === "close") first.close(); else endpoint = "https://different.invalid/v1";
    await first.send({ ...input, text: "New conversation" });
    expect(first.history().file).not.toBe(old);
    expect(await readFile(old, "utf8")).toContain("OLD_PRIVATE_CHAT");
  });

  it.each(["pending", "corrupt", "identity", "pointer"])("ignores an old %s checkpoint or pointer and preserves the archive", async problem => {
    const { input, directory } = await request(); const storageDirectory = join(directory, "chats"); let calls = 0;
    const create = () => new ChatSession({ storageDirectory, resolveModel: async () => ({ model, streamFn: stream(() => { calls++; return assistant([{ type: "text", text: "Fixture" }]); }) }) });
    const first = create(); await first.send(input); const file = first.history().file!; first.close();
    const data = JSON.parse(await readFile(file, "utf8"));
    if (problem === "pending") data.pendingToolCalls = ["uncertain-side-effect"];
    if (problem === "identity") data.identity.workspace = join(directory, "different-workspace");
    const poisoned = problem === "corrupt" ? "not JSON" : JSON.stringify(data); await writeFile(file, poisoned);
    if (problem === "pointer") await writeFile(join(storageDirectory, "current.json"), "not JSON");
    const next = create();
    expect(next.history().messages).toEqual([]);
    await next.send({ ...input, text: "New session" });
    expect(next.history().file).not.toBe(file);
    expect(next.history().pendingToolCalls).toEqual([]);
    expect(calls).toBe(2); expect(await readFile(file, "utf8")).toBe(poisoned);
  });

  it("keeps each live instance bound to its own archive when the shared disk pointer changes", async () => {
    const { input, directory } = await request();
    const contexts: Context[] = [], ids: (string | undefined)[] = [];
    const create = () => new ChatSession({ storageDirectory: join(directory, "chats"), createAgent: options => {
      ids.push(options.sessionId); return new Agent(options);
    }, resolveModel: async () => ({ model, streamFn: stream(context => {
      contexts.push(JSON.parse(JSON.stringify(context)) as Context); return assistant([{ type: "text", text: "Session reply" }]);
    }) }) });
    const first = create(), second = create();
    await first.send({ ...input, text: "FIRST_SESSION_ONLY" });
    const firstFile = first.history().file;
    expect(second.history().messages).toEqual([]);
    await second.send({ ...input, text: "SECOND_SESSION_ONLY" });
    const secondFile = second.history().file!;
    const secondBytes = await readFile(secondFile, "utf8");
    expect(secondFile).not.toBe(firstFile);
    expect(ids[0]).toBeTruthy(); expect(ids[1]).not.toBe(ids[0]);
    expect(first.history().file).toBe(firstFile);
    await first.send({ ...input, text: "Continue first session" });
    expect(JSON.stringify(contexts[1].messages)).not.toContain("FIRST_SESSION_ONLY");
    expect(JSON.stringify(contexts[2].messages)).toContain("FIRST_SESSION_ONLY");
    expect(JSON.stringify(contexts[2].messages)).not.toContain("SECOND_SESSION_ONLY");
    expect(first.history().file).toBe(firstFile);
    expect(await readFile(secondFile, "utf8")).toBe(secondBytes);
    first.close(); second.close();
  });

  it("durably records the entire pending tool batch before execution", async () => {
    const { input, directory } = await request(); let calls = 0, checked = false;
    const chat = new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1 ? assistant([
      { type: "toolCall", id: "a", name: "write", arguments: { path: "a.txt", content: "a" } },
      { type: "toolCall", id: "b", name: "write", arguments: { path: "b.txt", content: "b" } },
    ], "toolUse") : assistant([{ type: "text", text: "Done" }])) }), createAgent: options => new Agent({ ...options, beforeToolCall: async (context, signal) => {
      if (!checked) {
        expect(chat.history().pendingToolCalls).toEqual(["a", "b"]);
        await expect(readFile(join(directory, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" }); checked = true;
      }
      return options.beforeToolCall?.(context, signal);
    } }) });
    await chat.send(input); expect(checked).toBe(true); expect(chat.history().pendingToolCalls).toEqual([]);
  });

  it("blocks a tool when its pending checkpoint cannot be written", async () => {
    const { input, directory } = await request(); let calls = 0;
    const chat = new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({ model, streamFn: (_model, context) => {
      const events = new AssistantMessageEventStream(); calls++;
      void (async () => {
        const file = chat.history().file!; await unlink(file); await mkdir(file);
        const message = assistant([{ type: "toolCall", id: "must-not-run", name: "write", arguments: { path: "forbidden.txt", content: "side effect" } }], "toolUse");
        events.push({ type: "done", reason: "toolUse", message }); events.end();
      })();
      return events;
    } }) });
    await expect(chat.send(input)).rejects.toThrow();
    expect(calls).toBe(1); await expect(readFile(join(directory, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("chat context maintenance integration", () => {
  it("carries the initial Chat goal and later correction through repeated summaries without pinning stale text or restoring it on restart", async () => {
    const { input, directory } = await request();
    input.chrome = { enabled: false };
    const initial = "Original Chat objective: track fixture identity; initial condition MEMORY_OLD.";
    const correction = "User correction: MEMORY_CURRENT replaces MEMORY_OLD. " + "inert data ".repeat(250);
    const memory = "Goal: track fixture identity. User corrected MEMORY_OLD to MEMORY_CURRENT; research observations remain unverified.";
    const noMeasuredUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let summaries = 0, correctionSummarized = false, previousMemory = "";
    const seen: Context[] = [];
    const create = () => new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({
      model: { ...model, contextWindow: 12000, maxTokens: 3000 }, streamFn: stream(context => {
        if (isSummary(context)) {
          const transcript = JSON.stringify(context.messages);
          if (summaries === 0) expect(transcript).toContain(initial);
          else expect(transcript).toContain(previousMemory);
          correctionSummarized ||= transcript.includes(correction);
          previousMemory = correctionSummarized ? memory : "Goal: track fixture identity; original user condition MEMORY_OLD.";
          summaries++;
          return assistant([{ type: "text", text: previousMemory }], "stop", noMeasuredUsage);
        }
        seen.push(JSON.parse(JSON.stringify(context)) as Context);
        return assistant([{ type: "text", text: "ACK" }], "stop", noMeasuredUsage);
      }),
    }) });
    const first = create();
    await first.send({ ...input, text: initial });
    await first.send({ ...input, text: correction });
    for (let turn = 0; turn < 20; turn++) await first.send({ ...input, text: `FILLER_${turn}\n` + "inert data ".repeat(250) });
    expect(summaries).toBeGreaterThanOrEqual(2);
    expect(correctionSummarized).toBe(true);
    const last = seen.at(-1)!;
    expect(last.messages.filter(message => typeof message.content === "string" && message.content.startsWith(CONTEXT_SUMMARY_MARKER))).toHaveLength(1);
    expect(JSON.stringify(last.messages)).toContain(memory);
    expect(last.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(initial))).toBe(false);
    expect(JSON.stringify(last.messages.at(-1))).toContain("FILLER_19");
    const archive = first.history().file!;
    const archivedBytes = await readFile(archive, "utf8");
    first.close();
    const second = create();
    await second.send({ ...input, text: "New launch, new conversation." });
    expect(seen.at(-1)!.messages).toHaveLength(1);
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toMatch(/MEMORY_OLD|MEMORY_CURRENT|XLOOM PRIVATE CONTEXT SUMMARY/);
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain(CONTEXT_SUMMARY_MARKER);
    expect(second.history().file).not.toBe(archive);
    expect(await readFile(archive, "utf8")).toBe(archivedBytes);
    second.close();
  });

  it("preserves corrections during compaction within a session and excludes both corrections and summaries after restart", async () => {
    const { input, directory } = await request();
    const correction = "Later user correction: bob / v3 / NOT_ATTEMPTED; previous alice / v1 withdrawn.";
    let summaries = 0; const seen: Context[] = [];
    const create = () => new ChatSession({ storageDirectory: join(directory, "chats"), resolveModel: async () => ({ model, streamFn: stream(context => {
      if (isSummary(context)) {
        expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_CONFLICT");
        expect(JSON.stringify(context.messages)).not.toContain("[Assistant thinking]");
        summaries++; return assistant([{ type: "text", text: "Older observations summarized; original conditions not restated here." }]);
      }
      seen.push(JSON.parse(JSON.stringify(context)) as Context);
      return assistant([{ type: "thinking", thinking: "PRIVATE_CONFLICT: alice/v1 is current despite the later user correction." },
        { type: "text", text: "retained observation ".repeat(700) }]);
    }) }) });
    const first = create();
    await first.send({ ...input, text: "Initial user condition: alice / v1 / DENIED" });
    await first.send({ ...input, text: correction });
    for (let i = 0; i < 6; i++) await first.send({ ...input, text: "Continue the same discussion " + i });
    expect(summaries).toBeGreaterThan(0);
    const containsCorrection = (context: Context) => context.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(correction));
    expect(containsCorrection(seen.at(-1)!)).toBe(true);
    first.close();
    const second = create(); await second.send({ ...input, text: "Recall the current condition" });
    expect(containsCorrection(seen.at(-1)!)).toBe(false);
    expect(seen.at(-1)!.messages).toHaveLength(1);
    expect(JSON.stringify(seen.at(-1)!.messages)).not.toContain(CONTEXT_SUMMARY_MARKER);
    second.close();
  });
  it.each([1, 2])("reserves the last request after compacting retained chat with a cap of %s", async cap => {
    const { input } = await request();
    let checking = false, summaries = 0, calls = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (!checking) return assistant([{ type: "text", text: "retained observation ".repeat(2000) }]);
      calls++;
      if (isSummary(context)) { summaries++; return assistant([{ type: "text", text: "Earlier observations retained." }]); }
      expect(context.tools).toEqual([]);
      expect(context.systemPrompt).toContain("This is the final allowed model request.");
      return assistant([{ type: "text", text: "Final reply from existing observations." }]);
    }) }) });
    await session.send(input);
    await session.send({ ...input, text: "One more observation." });
    checking = true;
    const result = await session.send({ ...input, limits: { ...input.limits, maxTurnsPerRun: cap }, text: "Summarize existing results." });
    expect(calls).toBe(cap);
    expect(summaries).toBe(cap - 1);
    expect(result.input).toBe(cap * 3);
    expect(result.output).toBe(cap);
    session.close();
  });

  it("compacts a continuing tool loop, meters each summary once and retains private history for the next send", async () => {
    const { input, events, directory } = await request();
    await writeFile(join(directory, "fixture.txt"), "synthetic observation ".repeat(1100));
    let requests = 0;
    let summaries = 0;
    const contexts: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (isSummary(context)) {
        summaries++;
        expect(context.tools).toEqual([]);
        return assistant([{ type: "text", text: "Hypothesis A + B remains unverified. Prior reads completed; evidence is fixture.txt." }]);
      }
      requests++;
      contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      if (requests <= 7) return assistant([{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "fixture.txt" } }], "toolUse");
      return assistant([{ type: "text", text: "The fixture was read; A + B remains unverified." }]);
    }) }) });
    const first = await session.send(input);
    expect(summaries).toBeGreaterThan(0);
    expect(first.input).toBe((requests + summaries) * 3);
    expect(first.output).toBe(requests + summaries);
    expect(events.filter(event => event.type === "usage")).toHaveLength(requests + summaries);
    expect(contexts.some(context => JSON.stringify(context.messages).includes(CONTEXT_SUMMARY_MARKER))).toBe(true);
    expect(contexts.at(-1)?.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: input.text }] });
    expect(JSON.stringify(contexts.at(-1)?.messages)).toContain('"toolCallId":"read-7"');
    const before = requests;
    const next = await session.send({ ...input, text: "Use the retained hypothesis to plan the next local check." });
    expect(requests).toBe(before + 1);
    expect(next.input).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(contexts.at(-1)?.messages)).toContain("A + B");
    expect(await readdir(directory)).toEqual(["fixture.txt"]);
  });

  it("cancels during a summary before another model request and accounts for the completed summary", async () => {
    const { input, directory } = await request();
    const abort = new AbortController();
    input.signal = abort.signal;
    await writeFile(join(directory, "fixture.txt"), "synthetic evidence ".repeat(1600));
    let requests = 0;
    let summaries = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (isSummary(context)) {
        summaries++;
        abort.abort(new Error("cancelled during context maintenance"));
        return assistant([{ type: "text", text: "A remains unverified." }]);
      }
      requests++;
      return assistant([{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "fixture.txt" } }], "toolUse");
    }) }) });
    const failure = await session.send(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain("cancelled during context maintenance");
    expect(summaries).toBe(1);
    expect(failure.usage.input).toBe((requests + summaries) * 3);
  });

  it("does not issue a normal model request after summary usage exhausts an explicit token budget", async () => {
    const { input, directory } = await request();
    input.limits.maxTokens = 100;
    await writeFile(join(directory, "fixture.txt"), "synthetic evidence ".repeat(1600));
    let requests = 0;
    let summaries = 0;
    const summaryUsage = { ...usage, input: 150, totalTokens: 153 };
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (isSummary(context)) {
        summaries++;
        return assistant([{ type: "text", text: "Hypothesis A remains unverified." }], "stop", summaryUsage);
      }
      requests++;
      return assistant([{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "fixture.txt" } }], "toolUse");
    }) }) });
    const failure = await session.send(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain("budget reached");
    expect(summaries).toBe(1);
    expect(failure.usage.input).toBe(requests * 3 + 152);
    expect(failure.usage.cacheRead).toBe(requests + summaries);
    expect(failure.usage.cacheInput).toBe(failure.usage.input);
  });
});

describe("same-session transient chat continuation", () => {
  it("does not forward retained private history when the resolved endpoint changes under the same configured model", async () => {
    const { input } = await request();
    let resolutions = 0;
    const contexts: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({
      model: { ...model, baseUrl: ++resolutions === 1 ? model.baseUrl : "https://different.invalid/v1" },
      streamFn: stream(context => { contexts.push(context); return assistant([{ type: "text", text: "previous private answer" }]); }),
    }) });
    await session.send(input);
    await session.send({ ...input, text: "New endpoint task" });
    expect(contexts.map(context => context.messages.length)).toEqual([1, 1]);
    expect(JSON.stringify(contexts[1].messages)).not.toContain(input.text);
    expect(JSON.stringify(contexts[1].messages)).not.toContain("previous private answer");
  });

  it.each(["Stream error: error decoding response body", "Anthropic stream ended before message_stop", "Request timed out."])("recovers %s after a completed write and retains its durable result exactly once", async errorMessage => {
    const { input, events, directory } = await request();
    let requests = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      requests++;
      if (requests === 1) return assistant([{ type: "toolCall", id: "write-once", name: "write", arguments: { path: "result.txt", content: "completed exactly once" } }], "toolUse");
      if (requests === 2) return { ...assistant([{ type: "text", text: "incomplete transient response" }], "error"), errorMessage };
      expect(context.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "write-once", isError: false });
      expect(JSON.stringify(context.messages)).not.toContain("incomplete transient response");
      return assistant([{ type: "text", text: "The saved file is available." }]);
    }) }) });
    expect(await session.send(input)).toMatchObject({ input: 9, output: 3 });
    expect(requests).toBe(3);
    expect(events.filter(event => event.type === "tool_start" && event.toolName === "write")).toHaveLength(1);
    expect(events.filter(event => event.type === "notice").map(event => event.text).join(" ")).toContain("without replaying tools");
    expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("completed exactly once");
    expect(await readdir(directory)).toEqual(["result.txt"]);
  });

  it.each(["503 temporarily unavailable", "Anthropic stream ended before message_stop", "Request timed out."])("does not repeatedly retry %s and retains both attempts' usage", async errorMessage => {
    const { input } = await request();
    let requests = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      requests++;
      return { ...assistant([], "error"), errorMessage };
    }) }) });
    const failure = await session.send(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain(errorMessage);
    expect(requests).toBe(2);
    expect(failure.usage).toMatchObject({ input: 6, output: 2 });
  });

  it.each(["turns", "tokens", "cost"])("does not retry after an explicit %s budget is exhausted by a failed response", async kind => {
    const { input } = await request();
    if (kind === "turns") input.limits.maxTurnsPerRun = 1;
    if (kind === "tokens") input.limits.maxTokens = 4;
    if (kind === "cost") input.limits.maxCost = 0.02;
    let requests = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      requests++;
      return { ...assistant([], "error"), errorMessage: "503 temporarily unavailable" };
    }) }) });
    await expect(session.send(input)).rejects.toThrow("503");
    expect(requests).toBe(1);
  });

  it("disables tools for the last explicit request even when the previous error bypassed Pi's turn callback", async () => {
    const { input, events, directory } = await request();
    input.limits.maxTurnsPerRun = 2;
    let requests = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++requests === 1) return { ...assistant([], "error"), errorMessage: "network connection lost" };
      expect(context.tools).toEqual([]);
      return assistant([{ type: "toolCall", id: "forbidden-extra", name: "write", arguments: { path: "must-not-exist.txt", content: "no" } }], "toolUse");
    }) }) });
    await expect(session.send(input)).rejects.toThrow("budget reached");
    expect(requests).toBe(2);
    expect(events.filter(event => event.type === "tool_end" && event.toolName === "write" && !event.isError)).toHaveLength(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["401 Unauthorized", "context window exceeded", "Invalid API key", "model not found 404"])("does not blindly retry deterministic failure: %s", async errorMessage => {
    const { input } = await request();
    let requests = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      requests++;
      return { ...assistant([], "error"), errorMessage };
    }) }) });
    await expect(session.send(input)).rejects.toThrow(errorMessage);
    expect(requests).toBe(1);
  });

  it("never treats an aborted model response as a retryable network failure", () => {
    expect(isTransientModelFailure({ ...assistant([], "aborted"), errorMessage: "network connection lost" })).toBe(false);
    expect(isTransientModelFailure({ ...assistant([], "error"), errorMessage: "429 rate limit exceeded" })).toBe(true);
  });
});
