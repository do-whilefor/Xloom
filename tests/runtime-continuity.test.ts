import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { CONTEXT_SUMMARY_MARKER, createContextSummarizer, isTransientModelFailure, loadCheckpoint, prepareContext, recoverableMessages, saveCheckpoint, requireContextCapacity,
  type CheckpointIdentity, type CheckpointState } from "../src/runtime/continuity.js";

const model: Model<"openai-completions"> = {
  id: "mock", name: "mock", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2000, maxTokens: 500,
};
const usage: Usage = { input: 30, output: 10, cacheRead: 3, cacheWrite: 2, totalTokens: 45,
  cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const user = (content = "Investigate fixture; preserve hypotheses and evidence."): AgentMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, usage, timestamp: 0,
});
function batch(id: string, text = "observation ".repeat(90)): AgentMessage[] {
  return [assistant([{ type: "text", text: `Testing hypothesis ${id}` }, { type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }], "toolUse"),
    { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 }];
}
const history = (): AgentMessage[] => [user(), ...Array.from({ length: 9 }, (_, index) => batch(`call-${index}`)).flat()];
async function location() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-continuity-"));
  dirs.push(directory);
  const identity: CheckpointIdentity = { role: "execute", provider: model.provider, model: model.id, api: model.api,
    baseUrl: model.baseUrl, workspace: directory, taskId: "task-1", stepId: "step-1" };
  const state: CheckpointState = { identity, messages: [user(), ...batch("completed")], pendingToolCalls: [], usage: { input: 35, output: 10, cost: 0.02 } };
  return { directory, path: join(directory, "private-checkpoint.json"), identity, state };
}

describe("provider failure classification", () => {
  it.each(["Anthropic stream ended before message_stop", "Request timed out."])("recognizes the provider's incomplete response: %s", errorMessage => {
    expect(isTransientModelFailure({ ...assistant([], "error"), errorMessage })).toBe(true);
    for (const stopReason of ["stop", "length", "toolUse", "aborted"] as const) {
      expect(isTransientModelFailure({ ...assistant([], stopReason), errorMessage })).toBe(false);
    }
  });

  it.each(["401 Unauthorized", "403 Forbidden", "Invalid API key", "context window exceeded", "too many tokens", "Request aborted", "Request cancelled"])("preserves deterministic failure precedence: %s", cause => {
    for (const failure of ["Anthropic stream ended before message_stop", "Request timed out."]) {
      expect(isTransientModelFailure({ ...assistant([], "error"), errorMessage: `${cause}: ${failure}` })).toBe(false);
    }
  });

  it("does not treat arbitrary early termination or missing diagnostics as a transient model failure", () => {
    for (const errorMessage of ["", "Stream ended", "Missing message_stop handler", "Agent stopped without a complete result: length"]) {
      expect(isTransientModelFailure({ ...assistant([], "error"), errorMessage })).toBe(false);
    }
    expect(isTransientModelFailure(assistant([], "error"))).toBe(false);
    expect(isTransientModelFailure(undefined)).toBe(false);
  });
});

describe("long-running context maintenance", () => {
  it("compacts for complete request pressure when provider usage is unavailable", async () => {
    const selected = { ...model, contextWindow: 16000 };
    const messages = history();
    for (const message of messages) if (message.role === "assistant") message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const envelope = { systemPrompt: "Keep this system instruction.", tools: [{ name: "read", description: "Tool documentation ".repeat(2100), parameters: { type: "object" as const } }] };
    const original = structuredClone(messages);
    expect(() => requireContextCapacity(selected, { ...envelope, messages: messages as any })).toThrow("capacity exhausted");
    const summarize = vi.fn(async () => ({ text: "Completed reads retained; evidence remains unverified." }));
    const prepared = await prepareContext(messages, selected, undefined, summarize, false, envelope);
    expect(prepared.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
    expect(prepared.messages[0]).toBe(messages[0]);
    expect(prepared.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(() => requireContextCapacity(selected, { ...envelope, messages: prepared.messages as any })).not.toThrow();
    expect(messages).toEqual(original);
  });

  it("retains original Chat corrections and newer input in order independently of a lossy summary, without enabling this for Run", async () => {
    const correction = user("Later correction: identity=bob, state=v3, result=NOT_ATTEMPTED; alice/v1 is withdrawn.");
    const newest = user("Newest user preference: answer briefly; continue checking bob/v3 against original evidence.");
    const messages = [user("Original condition: alice/v1"), correction, ...history().slice(1), newest];
    const original = JSON.stringify(messages);
    const summarize = async () => ({ text: "Older observations summarized without the condition." });
    const chat = await prepareContext(messages, model, undefined, summarize, true);
    expect(chat.compacted).toBe(true);
    expect(chat.messages).toContain(correction);
    expect(chat.messages.indexOf(correction)).toBeLessThan(chat.messages.findIndex(m => typeof m.content === "string" && m.content.startsWith(CONTEXT_SUMMARY_MARKER)));
    expect(chat.messages.at(-1)).toBe(newest);
    expect(chat.messages[0]).toBe(messages[0]);
    expect(JSON.stringify(messages)).toBe(original);
    const run = await prepareContext(messages, model, undefined, summarize);
    expect(run.compacted).toBe(true);
    expect(run.messages).not.toContain(correction);
  });

  it("bounds retained historical user text and does not promote old summary text to original user turns", async () => {
    const oldSummary = user(CONTEXT_SUMMARY_MARKER + "\nOld lossy memory");
    const messages = [user(), oldSummary, ...Array.from({ length: 30 }, (_, i) => [user("Correction " + i + ": " + "x".repeat(200)), ...batch(String(i))]).flat()];
    const result = await prepareContext(messages, model, undefined, async () => ({ text: "Recent work remains unverified." }), true);
    expect(result.compacted).toBe(true);
    expect(result.messages).not.toContain(oldSummary);
    expect(result.messages).not.toContain(messages[2]);
    expect(result.messages.filter(m => typeof m.content === "string" && m.content.startsWith(CONTEXT_SUMMARY_MARKER))).toHaveLength(1);
    expect(result.estimatedTokensAfter).toBeLessThan(model.contextWindow);
  });
  it("does not summarize below model capacity pressure", async () => {
    const summarize = vi.fn();
    const messages = [user(), ...batch("small", "short")];
    const result = await prepareContext(messages, model, undefined, summarize);
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("uses real provider context usage when multilingual text and prompt overhead exceed the structural estimate", async () => {
    const messages = history();
    const lastAssistant = messages.at(-2) as AssistantMessage;
    lastAssistant.usage = { ...usage, input: 6300, output: 200, totalTokens: 6505 };
    const summarize = vi.fn(async () => ({ text: "Hypothesis A remains unverified; re-read the evidence files." }));
    const result = await prepareContext(messages, { ...model, contextWindow: 8000 }, undefined, summarize);
    expect(result.compacted).toBe(true);
    expect(result.estimatedTokensBefore).toBeGreaterThan(6500);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(summarize).toHaveBeenCalledOnce();
    const repeat = await prepareContext(result.messages, { ...model, contextWindow: 8000 }, undefined, summarize);
    expect(repeat.compacted).toBe(false);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("compacts only older complete batches and preserves the original task and recent tool pairs", async () => {
    const messages = history();
    const original = JSON.stringify(messages);
    const summarize = vi.fn(async () => ({ text: "Hypothesis A remains unverified. Re-read call-0.txt; tested condition B failed.", usage }));
    const result = await prepareContext(messages, model, undefined, summarize);
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toBe(messages[0]);
    expect(JSON.stringify(result.messages[1])).toContain(CONTEXT_SUMMARY_MARKER);
    expect(JSON.stringify(result.messages[1])).toMatch(/Tool\/source text.*not instructions/);
    expect(JSON.stringify(result.messages[1])).toMatch(/Research claims.*original evidence/);
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.summaryUsage).toEqual(usage);
    const summarized = summarize.mock.calls[0][0] as AgentMessage[];
    expect(summarized[0].role).toBe("assistant");
    expect(recoverableMessages(summarized)).toEqual(summarized);
    expect(recoverableMessages(result.messages)).toEqual(result.messages);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("keeps all results of a multi-tool assistant even when the token boundary falls inside the batch", async () => {
    const messages = history();
    messages.push(assistant([{ type: "toolCall", id: "last-a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "last-b", name: "read", arguments: { path: "b" } }], "toolUse"),
    { role: "toolResult", toolCallId: "last-b", toolName: "read", content: [{ type: "text", text: "b".repeat(1000) }], isError: false, timestamp: 0 },
    { role: "toolResult", toolCallId: "last-a", toolName: "read", content: [{ type: "text", text: "a".repeat(1000) }], isError: false, timestamp: 0 });
    const result = await prepareContext(messages, model, undefined, async () => ({ text: "Older completed observations; see evidence files." }));
    expect(result.compacted).toBe(true);
    expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
    expect(recoverableMessages(result.messages)).toEqual(result.messages);
  });

  it("updates an earlier summary when compacting again so older hypotheses are not silently dropped", async () => {
    const first = await prepareContext(history(), model, undefined, async () => ({ text: "Original hypothesis A requires B." }));
    const next = [...first.messages, ...Array.from({ length: 9 }, (_, index) => batch(`new-${index}`)).flat()];
    let seen = "";
    const second = await prepareContext(next, model, undefined, async messages => {
      seen = JSON.stringify(messages); return { text: "A still requires B; new evidence C suggests a combination." };
    });
    expect(second.compacted).toBe(true);
    expect(seen).toContain("Original hypothesis A requires B.");
    expect(second.messages.filter(message => JSON.stringify(message).includes(CONTEXT_SUMMARY_MARKER))).toHaveLength(1);
  });

  it("refuses to compact incomplete tools or orphan results", async () => {
    const summarize = vi.fn();
    const messages = [...history(), assistant([{ type: "toolCall", id: "pending", name: "write", arguments: { path: "state", content: "new" } }], "toolUse")];
    const result = await prepareContext(messages, model, undefined, summarize);
    expect(result.reason).toBe("pending-tools");
    expect(result.messages).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
    const orphan = [...history(), batch("orphan")[1]];
    expect((await prepareContext(orphan, model, undefined, summarize)).reason).toBe("pending-tools");
  });

  it("does not truncate a single oversized tool result or replace it with invented evidence", async () => {
    const messages = [user(), ...batch("large", "evidence ".repeat(1500))];
    const result = await prepareContext(messages, model, undefined, vi.fn());
    expect(result.reason).toBe("no-older-turns");
    expect(result.messages).toBe(messages);
  });

  it("reports unavailable summarization and unknown model capacity without discarding history", async () => {
    const messages = history();
    expect((await prepareContext(messages, model)).reason).toBe("summarizer-unavailable");
    expect((await prepareContext(messages, { ...model, contextWindow: 0 })).reason).toBe("unknown-capacity");
  });

  it("keeps the original transcript if a summary is longer, and still returns consumed summary usage", async () => {
    const messages = history();
    const result = await prepareContext(messages, model, undefined, async () => ({ text: "expansion ".repeat(9000), usage }));
    expect(result.reason).toBe("summary-not-smaller");
    expect(result.messages).toBe(messages);
    expect(result.summaryUsage).toEqual(usage);
  });

  it("honors cancellation before and during summarization", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled before"));
    const summarize = vi.fn();
    await expect(prepareContext(history(), model, abort.signal, summarize)).rejects.toThrow("cancelled before");
    expect(summarize).not.toHaveBeenCalled();
    const during = new AbortController();
    const messages = history();
    await expect(prepareContext(messages, model, during.signal, async () => {
      during.abort(new Error("cancelled during")); return { text: "summary", usage };
    })).rejects.toThrow("cancelled during");
    expect(messages).toHaveLength(19);
  });
});

describe("summary provider calls", () => {
  function stream(response: AssistantMessage, inspect?: (options: unknown, context: unknown) => void): StreamFn {
    return (_model, context, options) => {
      inspect?.(options, context);
      const events = new AssistantMessageEventStream();
      queueMicrotask(() => {
        if (response.stopReason === "error" || response.stopReason === "aborted") events.push({ type: "error", reason: response.stopReason, error: response });
        else events.push({ type: "done", reason: response.stopReason as "stop" | "length" | "toolUse", message: response });
        events.end();
      });
      return events;
    };
  }

  it("uses the existing stream authentication without adding input/output caps and reports cached token usage", async () => {
    const counted = vi.fn();
    const summarizer = createContextSummarizer(stream(assistant([{ type: "text", text: "Preserved A + B hypothesis." }]), (options, context) => {
      expect(options).not.toHaveProperty("maxTokens");
      expect(options).not.toHaveProperty("apiKey");
      expect(options).toMatchObject({ cacheRetention: "none", sessionId: "same-session" });
      expect(context).toMatchObject({ tools: [] });
      expect(JSON.stringify(context)).toContain("Do not invent findings");
    }), counted, "same-session");
    const result = await summarizer([user(), ...batch("a")], model);
    expect(result.text).toBe("Preserved A + B hypothesis.");
    expect(counted).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it("summarizes user corrections and public tool records without promoting private thinking into conversation history", async () => {
    const corrected = "User correction: current condition is bob/v3; alice/v1 is withdrawn.";
    const messages = [user("Original condition: alice/v1"), user(corrected),
      assistant([{ type: "thinking", thinking: "PRIVATE_CONFLICT: alice/v1 is still current despite the user's correction.", thinkingSignature: "PRIVATE_THINKING_SIGNATURE" },
        { type: "text", text: "Acknowledged the corrected condition.", textSignature: "PRIVATE_TEXT_SIGNATURE" },
        { type: "toolCall", id: "verified-read", name: "read", arguments: { path: "evidence/correction.txt" }, thoughtSignature: "PRIVATE_TOOL_SIGNATURE" }], "toolUse"),
      { role: "toolResult" as const, toolCallId: "verified-read", toolName: "read", content: [{ type: "text" as const, text: "Observed bob/v3 in the source." }], isError: false, timestamp: 0 }];
    const before = structuredClone(messages);
    const summarize = createContextSummarizer(stream(assistant([{ type: "text", text: "The user corrected alice/v1 to bob/v3; source read completed." }]), (_options, context) => {
      const transcript = JSON.stringify(context);
      expect(transcript).not.toContain("PRIVATE_");
      expect(transcript).not.toContain("[Assistant thinking]");
      expect(transcript).toContain(corrected);
      expect(transcript).toContain("Acknowledged the corrected condition.");
      expect(transcript).toContain("evidence/correction.txt");
      expect(transcript).toContain("Observed bob/v3 in the source.");
      expect(transcript.indexOf("Original condition: alice/v1")).toBeLessThan(transcript.indexOf(corrected));
    }), () => {});
    await summarize(messages, model);
    expect(messages).toEqual(before);
  });

  it.each(["error", "aborted", "length", "toolUse"] as const)("counts %s summary usage but never persists its incomplete output", async stopReason => {
    const counted = vi.fn();
    const summarize = createContextSummarizer(stream(assistant([{ type: "text", text: "partial" }], stopReason)), counted);
    await expect(summarize(history(), model)).rejects.toThrow("did not finish safely");
    expect(counted).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it("rejects empty summaries after accounting for usage", async () => {
    const counted = vi.fn();
    const summarize = createContextSummarizer(stream(assistant([{ type: "text", text: "  " }])), counted);
    await expect(summarize(history(), model)).rejects.toThrow("empty");
    expect(counted).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it("repairs leaked tool-call text before allowing it to replace older context", async () => {
    let calls = 0; const counted = vi.fn();
    const markup = "<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"read\">batch-25.txt</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>";
    const summarize = createContextSummarizer((model, context, options) => {
      if (++calls === 2) expect(context.systemPrompt).toContain("Do not output tool calls");
      return stream(assistant([{ type: "text", text: calls === 1 ? markup : "Latest conditions: bob / v3 / NOT_ATTEMPTED. Earlier alice / v1 withdrawn." }]))(model, context, options);
    }, counted);
    const result = await summarize(history(), model);
    expect(result.text).toContain("bob / v3 / NOT_ATTEMPTED");
    expect(result.text).not.toContain("DSML"); expect(counted).toHaveBeenCalledTimes(2);
  });

  it.each(["<｜｜DSML｜｜ calls>", "<tool_call>", "<function_calls>"])("retains original messages if summary repair still emits %s", async markup => {
    const counted = vi.fn(), messages = history(), before = structuredClone(messages);
    const summarize = createContextSummarizer(stream(assistant([{ type: "text", text: markup + "read another file" }])), counted);
    await expect(prepareContext(messages, model, undefined, summarize)).rejects.toThrow("original context was not replaced");
    expect(messages).toEqual(before);
    expect(counted).toHaveBeenCalledTimes(2);
  });

  it("does not spend a reserved final request repairing summary markup", async () => {
    const counted = vi.fn();
    const summarize = createContextSummarizer(stream(assistant([{ type: "text", text: "<｜｜DSML｜｜ calls>" }])), counted, undefined, () => false);
    await expect(summarize(history(), model)).rejects.toThrow("tool-call markup");
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it("retries a temporary summary failure once using the same transcript and counts both attempts", async () => {
    let calls = 0; const contexts: unknown[] = [], counted = vi.fn();
    const transient = { ...assistant([], "error"), errorMessage: "503 temporarily unavailable" };
    const summarize = createContextSummarizer((model, context, options) => {
      contexts.push(context);
      return stream(++calls === 1 ? transient : assistant([{ type: "text", text: "Retained original observations" }]))(model, context, options);
    }, counted);
    const result = await summarize(history(), model);
    expect(result).toMatchObject({ text: "Retained original observations", usage: { input: 60, output: 20, cost: { total: 0.04 } } });
    expect(contexts[0]).toEqual(contexts[1]); expect(counted).toHaveBeenCalledTimes(2);
  });

  it.each(["401 Unauthorized", "context window exceeded", "Unknown provider failure"])("retains deterministic summary diagnostics without retry: %s", async errorMessage => {
    const counted = vi.fn();
    const summarize = createContextSummarizer(stream({ ...assistant([], "error"), errorMessage }), counted);
    await expect(summarize(history(), model)).rejects.toThrow(errorMessage);
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it.each(["reserved-request", "cancelled", "repeat-failure"])("stops summary retry at %s without losing usage", async reason => {
    const abort = new AbortController(), counted = vi.fn(() => { if (reason === "cancelled") abort.abort(new Error("Cancelled summary")); });
    const summarize = createContextSummarizer(stream({ ...assistant([], "error"), errorMessage: "503 temporary" }), counted,
      undefined, () => reason !== "reserved-request");
    await expect(summarize(history(), model, abort.signal)).rejects.toThrow(reason === "cancelled" ? "Cancelled summary" : "503 temporary");
    expect(counted).toHaveBeenCalledTimes(reason === "repeat-failure" ? 2 : 1);
  });
});

describe("private checkpoint continuity", () => {
  it("round-trips completed tool results without replaying them and retains accounted usage", async () => {
    const { path, identity, state } = await location();
    await saveCheckpoint(path, state);
    const loaded = await loadCheckpoint(path, identity);
    expect(loaded?.messages).toEqual(state.messages);
    expect(loaded?.usage).toEqual(state.usage);
    expect(loaded?.pendingToolCalls).toEqual([]);
  });

  it("redacts credentials in text, tool arguments, results and keys while preserving JSON escaping", async () => {
    const { path, identity, state } = await location();
    const secret = 'key-"\\\nsecret';
    state.messages = [user(secret), assistant([{ type: "toolCall", id: "c", name: "read", arguments: { [secret]: secret } }], "toolUse"),
      { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: secret }], isError: false, timestamp: 0 }];
    await saveCheckpoint(path, state, value => value.split(secret).join("[REDACTED]"));
    const loaded = await loadCheckpoint(path, identity);
    expect(JSON.stringify(loaded)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.stringify(loaded)).toContain("[REDACTED]");
  });

  it("never persists private thinking or opaque provider signatures", async () => {
    const { path, identity, state } = await location();
    state.messages.push(assistant([{ type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_THINKING_SIGNATURE" },
      { type: "text", text: "public summary", textSignature: "PRIVATE_TEXT_SIGNATURE" }]));
    const tool = state.messages[1];
    if (tool.role === "assistant") {
      const call = tool.content.find(part => part.type === "toolCall")!;
      call.thoughtSignature = "PRIVATE_TOOL_SIGNATURE";
    }
    await saveCheckpoint(path, state);
    expect(await readFile(path, "utf8")).not.toContain("PRIVATE_");
    expect(JSON.stringify((await loadCheckpoint(path, identity))?.messages)).toContain("public summary");
    expect(JSON.stringify(state.messages)).toContain("PRIVATE_REASONING");
  });

  it.each(["role", "provider", "model", "api", "baseUrl", "workspace", "taskId", "stepId"] as const)("refuses a different %s identity", async field => {
    const { path, identity, state } = await location();
    await saveCheckpoint(path, state);
    const expected = { ...identity, [field]: field === "role" ? "decide" : `${identity[field]}-different` } as CheckpointIdentity;
    await expect(loadCheckpoint(path, expected)).rejects.toThrow("identity does not match");
  });

  it("persists pending tools as a recovery barrier even when earlier messages were complete", async () => {
    const { path, identity, state } = await location();
    await saveCheckpoint(path, state);
    await saveCheckpoint(path, { ...state, pendingToolCalls: ["side-effect-in-flight"] });
    await expect(loadCheckpoint(path, identity)).rejects.toThrow("unfinished tools");
    expect(JSON.parse(await readFile(path, "utf8")).pendingToolCalls).toEqual(["side-effect-in-flight"]);
  });

  it("rejects incomplete, duplicate, orphan or mismatched tool records regardless of a cleared pending flag", async () => {
    const { path, identity, state } = await location();
    for (const messages of [
      [user(), batch("unfinished")[0]],
      [user(), ...batch("duplicate"), ...batch("duplicate")],
      [user(), batch("orphan")[1]],
      [user(), batch("call")[0], batch("other")[1]],
      [user(), batch("call")[0], { ...batch("call")[1], toolName: "write" } as AgentMessage],
    ]) {
      await saveCheckpoint(path, { ...state, messages });
      await expect(loadCheckpoint(path, identity)).rejects.toThrow("incomplete or mismatched tool results");
    }
  });

  it("removes failed response tails while retaining the preceding durable tool results", async () => {
    const { path, identity, state } = await location();
    const complete = state.messages.slice();
    state.messages.push(assistant([{ type: "text", text: "partial failure" }], "error"), assistant([], "aborted"));
    await saveCheckpoint(path, state);
    expect((await loadCheckpoint(path, identity))?.messages).toEqual(complete);
    expect(state.messages).toHaveLength(complete.length + 2);
  });

  it("refuses uncertain tool calls inside an aborted response", async () => {
    const { path, identity, state } = await location();
    state.messages.push(assistant([{ type: "toolCall", id: "uncertain", name: "write", arguments: { path: "state" } }], "aborted"));
    await saveCheckpoint(path, state);
    await expect(loadCheckpoint(path, identity)).rejects.toThrow("uncertain tool calls");
  });

  it("rejects unknown versions and malformed checkpoints with stable errors that do not echo stored secrets", async () => {
    const { path, identity, state } = await location();
    for (const data of ['{"PRIVATE_SECRET":', JSON.stringify({ version: 999, ...state, secret: "PRIVATE_SECRET" }),
      JSON.stringify({ version: 1, ...state, savedAt: new Date().toISOString(), messages: [{ role: "developer", content: "PRIVATE_SECRET" }] })]) {
      await writeFile(path, data);
      const failure = await loadCheckpoint(path, identity).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("automatic recovery is refused");
      expect(failure.message).not.toContain("PRIVATE_SECRET");
    }
  });

  it("serializes racing writes in event order and snapshots mutable messages at call time", async () => {
    const { path, identity, state, directory } = await location();
    const first = saveCheckpoint(path, state);
    state.messages.push(assistant([{ type: "text", text: "second turn" }]));
    const second = saveCheckpoint(path, { ...state, pendingToolCalls: ["next-action"] });
    state.messages.push(assistant([{ type: "text", text: "not yet checkpointed" }]));
    await Promise.all([first, second]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("second turn");
    expect(text).not.toContain("not yet checkpointed");
    await expect(loadCheckpoint(path, identity)).rejects.toThrow("unfinished tools");
    expect(await readdir(directory)).toEqual(["private-checkpoint.json"]);
  });

  it("returns undefined only when the checkpoint file is absent", async () => {
    const { path, identity } = await location();
    expect(await loadCheckpoint(path, identity)).toBeUndefined();
  });
});
