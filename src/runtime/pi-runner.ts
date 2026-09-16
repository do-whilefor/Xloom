import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { createWorkspaceEditTool } from "./edit.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner, RunRequest, RunResult, RuntimeEvent, Usage } from "../types.js";
import { addUsage, modelUsage } from "../usage.js";
import { buildRunPrompt, buildRunTaskCore } from "./prompts.js";
import { resolveModel, modelThinkingLevel, type ModelResolver } from "./models.js";
import { createRunBudget } from "./run-budget.js";
import { createCheckedPowerShellTool } from "./powershell.js";
import { decisionSchema, executionSchema, formatValidationError } from "../schema.js";
import { createContextSummarizer, prepareContext, saveCheckpoint, loadCheckpoint, isTransientModelFailure, requireContextCapacity, requireLengthProgress } from "./continuity.js";
import { stageWriter } from "./stage.js";
import { validateDecisionReferences } from "../loop/references.js";
import { decisionRepairGuidance, normalizeDecisionInput } from "../loop/decision-input.js";
import { normalizeExecutionInput } from "../loop/execution-input.js";
import { credentialPatterns, redactCredentials } from "./redaction.js";
import { createWorkspaceReadTool } from "./read.js";
import { validateFinalJson } from "./protocol.js";
import { validateWikiReferences } from "../wiki/model.js";
import { validateKnowledgeSubmission } from "../knowledge/model.js";
import { validateCvssExecution } from "../scoring/cvss.js";
import { createChromeSession, type ChromeSession } from "./chrome.js";
import { scheduledTools } from "./execution.js";
import { submissionTool } from "./submission.js";
import { disposeHttpTool, withHttpEvidence } from "./http.js";
import { createRetrievalModel } from "./retrieval-model.js";
export { parseFinalJson } from "./protocol.js";

export class RuntimeRunError extends Error {
  constructor(message: string, public readonly usage: Usage, options?: ErrorOptions) { super(message, options); this.name = "RuntimeRunError"; }
}

export function executeTools(workspace: string, artifactsDirectory?: string) {
  const shell = createCheckedPowerShellTool(workspace);
  return [createWorkspaceReadTool(workspace, artifactsDirectory), createWriteTool(workspace), createWorkspaceEditTool(workspace),
    artifactsDirectory ? withHttpEvidence(shell, artifactsDirectory) : shell];
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

// Protocol fragments can split inside a JSON string or escape sequence.
const protocolText = (message: AssistantMessage | undefined) => message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";

function isProtocolText(value: string): boolean {
  if (/^(?:\{|\[|```(?:json)?\s*[\[{]|```json\b)/i.test(value)) return true;
  const body = value.replace(/^```\s*\n/, "").replace(/\n```$/, "");
  try { JSON.parse(body); return true; } catch { return false; }
}

export function runtimeEvent(event: AgentEvent, mode: RuntimeEvent["mode"]): RuntimeEvent | undefined {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") return { type: "text", mode, text: event.assistantMessageEvent.delta };
      return;
    case "tool_execution_start": return { type: "tool_start", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: JSON.stringify(event.args) };
    case "tool_execution_update": return { type: "tool_update", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: contentText(event.partialResult) };
    case "tool_execution_end": {
      const details = event.result?.details;
      return { type: "tool_end", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: contentText(event.result), isError: event.isError,
        ...(event.toolName === "read" && !event.isError && details?.nativeRetrieval === true && typeof details.retrievalFeedback === "string"
          ? { retrievalFeedback: details.retrievalFeedback } : {}) };
    }
    default: return;
  }
}

/** Forward only Pi-returned plain thinking, never signatures or provider-redacted payloads. */
export function createRuntimeForwarder(mode: RuntimeEvent["mode"], emit: (event: RuntimeEvent) => void,
  redact: (value: string) => string, secrets: () => readonly string[], fallbackText = false) {
  const prefix = randomUUID();
  let messageIndex = 0;
  const messageId = () => `${prefix}:${messageIndex}`;
  let pendingText = "";
  let sawText = false;
  type Thought = { id: string; pending: string; sawDelta: boolean; ended: boolean; replayed: boolean };
  let thoughts = new Map<number, Thought>();
  const availableText = (value: string, flush: boolean) => flush ? value.length
    : Math.max(0, value.length - Math.max(0, ...credentialPatterns(secrets()).map(secret => secret.length - 1)));
  const emitText = (delta: string, flush = false) => {
    pendingText = redact(pendingText + delta);
    const available = availableText(pendingText, flush);
    if (available) emit({ type: "text", mode, messageId: messageId(), text: pendingText.slice(0, available) });
    pendingText = pendingText.slice(available);
  };
  const begin = (index: number, replayed = false): Thought => {
    let thought = thoughts.get(index);
    if (!thought) {
      emitText("", true);
      thought = { id: `${prefix}:${messageIndex}:${index}`, pending: "", sawDelta: false, ended: false, replayed };
      thoughts.set(index, thought);
      emit({ type: "thinking_start", mode, messageId: messageId(), blockId: thought.id, text: "", ...(replayed ? { replayed: true } : {}) });
    }
    return thought;
  };
  const delta = (thought: Thought, value: string, flush = false) => {
    if (thought.ended) return;
    thought.pending = redact(thought.pending + value);
    const available = availableText(thought.pending, flush);
    if (available) emit({ type: "thinking", mode, messageId: messageId(), blockId: thought.id, text: thought.pending.slice(0, available), ...(thought.replayed ? { replayed: true } : {}) });
    thought.pending = thought.pending.slice(available);
  };
  const end = (thought: Thought) => {
    if (thought.ended) return;
    delta(thought, "", true);
    thought.ended = true;
    emit({ type: "thinking_end", mode, messageId: messageId(), blockId: thought.id, text: "", ...(thought.replayed ? { replayed: true } : {}) });
  };
  const finish = () => { for (const thought of thoughts.values()) end(thought); };
  return {
    finish,
    handle(event: AgentEvent): void {
      if (event.type === "message_start" && event.message.role === "assistant") {
        finish();
        messageIndex++;
        thoughts = new Map();
        sawText = false;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end") {
          const content = update.partial.content[update.contentIndex];
          if (content?.type !== "thinking" || content.redacted) return;
          const thought = begin(update.contentIndex);
          if (update.type === "thinking_delta") { thought.sawDelta = true; delta(thought, update.delta); }
          if (update.type === "thinking_end") {
            if (!thought.sawDelta) delta(thought, update.content, true);
            end(thought);
          }
          return;
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        event.message.content.forEach((content, index) => {
          if (content.type !== "thinking" || content.redacted || !content.thinking) return;
          const thought = begin(index, true);
          if (!thought.sawDelta && !thought.ended) delta(thought, content.thinking, true);
          end(thought);
        });
        finish();
        if (fallbackText && !sawText) emitText(contentText(event.message));
        emitText("", true);
        // Only actual, completed tool-use narration is public progress. Final JSON
        // still belongs to the controller's result contract; never invent prose.
        const narration = contentText(event.message).trim();
        if (event.message.stopReason === "toolUse" && event.message.content.some(part => part.type === "toolCall")
          && narration && !isProtocolText(narration)) {
          emit({ type: "narration", mode, messageId: messageId(), text: redact(narration) });
        }
        emit({ type: "usage", mode, text: "", usage: modelUsage(event.message.usage) });
      }
      const outgoing = runtimeEvent(event, mode);
      if (outgoing?.type === "text") { finish(); sawText = true; emitText(outgoing.text); }
      else if (outgoing) { finish(); emitText("", true); emit(outgoing); }
      if (event.type === "message_end") emitText("", true);
    },
  };
}

export interface PiRunnerOptions { resolveModel?: ModelResolver; createAgent?: (options: AgentOptions) => Agent; createChrome?: typeof createChromeSession }

/** Each invocation owns a fresh Pi Agent and transcript. Only the blackboard is input. */
export class PiRunner implements AgentRunner {
  constructor(private readonly options: PiRunnerOptions = {}) {}

  async run(request: RunRequest): Promise<RunResult> {
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    let redact = (value: string) => value;
    let agent: Agent | undefined;
    let unsubscribe: (() => void) | undefined;
    let detachAbort: (() => void) | undefined;
    let finalMessage: AssistantMessage | undefined;
    let forward: ReturnType<typeof createRuntimeForwarder> | undefined;
    let chrome: ChromeSession | undefined;
    let executionTools: AgentTool[] = [];
    try {
      request.signal.throwIfAborted();
      if (request.mode === "execute" && !request.step) throw new Error("Execute requires an assigned Step.");
      const config = request.snapshot.config.models[request.mode === "execute" ? "execute" : "decide"];
      const selected = await (this.options.resolveModel ?? resolveModel)(config, request.signal);
      request.signal.throwIfAborted();
      const configuredSecrets = Object.values(request.snapshot.config.models).map((entry) => entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined)
        .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
      // Pi may refresh OAuth during a run; include credentials discovered after resolution.
      const secrets = () => [...new Set([...(selected.secrets ?? []), ...configuredSecrets])].sort((a, b) => b.length - a.length);
      redact = value => redactCredentials(value, secrets());
      await mkdir(join(request.runDir, "artifacts"), { recursive: true });
      const budget = createRunBudget(request.snapshot.config.limits, usage, request.snapshot.usage, "agent", request.signal);
      const prompt = buildRunPrompt(request);
      prompt.systemPrompt += `\n\n${budget.instruction}`;
      await writeFile(join(request.runDir, "input.json"), redact(JSON.stringify({ mode: request.mode, ...prompt }, null, 2)), { flag: "wx" });
      const emit = (event: RuntimeEvent) => request.onEvent({ ...event, text: redact(event.text),
        ...(event.retrievalFeedback ? { retrievalFeedback: redact(event.retrievalFeedback) } : {}) });
      forward = createRuntimeForwarder(request.mode, emit, redact, secrets);
      if (selected.costKnown === false) emit({ type: "notice", mode: request.mode, text: "Endpoint pricing is unknown; cost is an estimate and an optional monetary budget cannot be enforced accurately." });
      const stage = request.mode === "execute" && request.onCheckpoint ? stageWriter(createWriteTool(request.workspace), request, usage, redact) : undefined;
      let normalizationChanges: string[] = [];
      function validateText(text: string): unknown { return validateFinalJson(redact(text), parsed => {
        if (request.mode === "execute") {
          const validated = executionSchema.safeParse(normalizeExecutionInput(parsed, stage?.snapshot ?? request.snapshot));
          if (!validated.success) throw new Error(formatValidationError(validated.error));
          validateWikiReferences(stage?.snapshot ?? request.snapshot, validated.data);
          validateKnowledgeSubmission(stage?.snapshot ?? request.snapshot, validated.data, request.step?.id);
          validateCvssExecution(stage?.snapshot ?? request.snapshot, validated.data);
          const output = validated.data;
          if (output.result === "done" && output.evidence?.length && !stage?.summary
            && ![output.facts, output.attempts, output.findings, output.wikiPages, output.capabilities,
              output.chains, output.gaps, output.gapLinks].some(records => records?.length)) {
            throw new Error("Evidence files alone do not establish completion. Use the existing observations to submit the missing facts or other research records, without replaying tools. If no supported record can be added, set result to no_progress or blocked; do not invent facts. Already committed checkpoint records must not be repeated.");
          }
          return validated.data;
        }
        const normalized = normalizeDecisionInput(parsed, request.snapshot);
        const validated = decisionSchema.safeParse(normalized.value);
        if (!validated.success) throw new Error(formatValidationError(validated.error));
        validateDecisionReferences(request.snapshot, validated.data, request.mode);
        normalizationChanges = normalized.changes;
        return validated.data;
      }); }
      const submission = submissionTool(request.mode, output => validateText(JSON.stringify(output)));
      const taskReading = request.blackboardPath ? { epoch: 0, dataDir: dirname(request.blackboardPath), snapshot: () => stage?.snapshot ?? request.snapshot,
          semantic: createRetrievalModel(selected, (...args) => mainStream(...args), consumed => {
            const added = modelUsage(consumed);
            addUsage(usage, added);
            emit({ type: "usage", mode: request.mode, text: "", usage: added });
          }, request.id, () => canRequest() && !finalRequest(), redact),
          materialBaseline: { ...request.materialBaseline, ...Object.fromEntries(request.materials?.items.map(item => [item.key, item.signature]) ?? []) },
          onAnnounced: (items: { key: string; signature: string }[]) => { if (request.materials) (request.materialReads ??= []).push(...items); } } : undefined;
      const readTool = createWorkspaceReadTool(request.workspace, request.mode === "execute" ? join(request.runDir, "artifacts") : undefined, taskReading);
      const contextMaintenance = taskReading ? { taskCore: () => redact(buildRunTaskCore({ ...request, snapshot: stage?.snapshot ?? request.snapshot })) } : undefined;
      if (request.mode === "execute") executionTools = executeTools(request.workspace, join(request.runDir, "artifacts"));
      const tools: AgentTool[] = request.mode === "execute" ? executionTools.map(tool => tool.name === "read" ? readTool : tool.name === "write" && stage ? stage.tool
        : tool.name === "edit" && stage ? createWorkspaceEditTool(request.workspace, join(request.runDir, "artifacts", "checkpoint.json")) : tool) : [readTool];
      if (request.mode === "execute" && request.snapshot.config.chrome?.enabled !== false && budget.toolsAllowed) {
        chrome = (this.options.createChrome ?? createChromeSession)({ workspace: request.workspace, artifactsDirectory: join(request.runDir, "artifacts"),
          config: request.snapshot.config.chrome, signal: request.signal });
        tools.push(chrome.tool);
      }
      tools.push(submission.tool);
      const checkpointFile = join(request.runDir, "continuation.json");
      const identity = { role: request.mode, provider: selected.model.provider, model: selected.model.id, api: selected.model.api,
        baseUrl: selected.model.baseUrl, workspace: request.workspace, taskId: request.id, stepId: request.step?.id ?? null };
      const pending = new Set<string>();
      let checkpointError: Error | undefined;
      const persist = async () => {
        if (!agent?.state) return;
        try { await saveCheckpoint(checkpointFile, { identity, messages: agent.state.messages, pendingToolCalls: [...pending], usage }, redact); }
        catch (error) { checkpointError = error instanceof Error ? error : new Error(String(error)); throw checkpointError; }
      };
      let modelRequests = 0;
      let requestLimitReached = false;
      const finalRequest = () => request.snapshot.config.limits.maxTurnsPerRun !== null
        && modelRequests === request.snapshot.config.limits.maxTurnsPerRun - 1;
      const finalInstruction = "This is the final allowed model request. Tools are unavailable. Return the required JSON from completed observations only; do not claim unfinished work succeeded.";
      const canRequest = () => budget.canRequest && (request.snapshot.config.limits.maxTurnsPerRun === null
        || modelRequests < request.snapshot.config.limits.maxTurnsPerRun);
      const mainStream: StreamFn = (...args) => {
        request.signal.throwIfAborted();
        if (!canRequest()) throw new Error("Explicit invocation budget exhausted before the next model request.");
        requireContextCapacity(args[0], args[1]);
        modelRequests++;
        return selected.streamFn(...args);
      };
      const summarizer = createContextSummarizer(mainStream, consumed => {
        const added = modelUsage(consumed);
        addUsage(usage, added);
        emit({ type: "usage", mode: request.mode, text: "", usage: added });
      }, request.id, () => canRequest() && !finalRequest());
      agent = (this.options.createAgent ?? ((options) => new Agent(options)))({
        initialState: { systemPrompt: prompt.systemPrompt, model: selected.model, thinkingLevel: modelThinkingLevel(selected.model, config.thinking), messages: [], tools: budget.toolsAllowed ? scheduledTools(tools) : [] },
        streamFn: mainStream,
        toolExecution: "parallel",
        sessionId: request.id,
        beforeToolCall: async () => {
          if (checkpointError) return { block: true, reason: "Private checkpoint could not be saved; tool was not executed.", terminate: true };
          if (submission.accepted) return { block: true, reason: "Final result accepted; remaining tools were not executed.", terminate: true };
          if (stage?.yielded) return { block: true, reason: "Execute has yielded to Decide; remaining tools were not executed.", terminate: true };
          request.signal.throwIfAborted();
          return undefined;
        },
        shouldStopAfterTurn: async context => {
          const stopped = await budget.shouldStopAfterTurn(submission.accepted
            ? { ...context, message: { ...context.message, content: [] } } : context);
          const exhausted = request.snapshot.config.limits.maxTurnsPerRun !== null && modelRequests >= request.snapshot.config.limits.maxTurnsPerRun;
          if (exhausted && !submission.accepted && context.message.content.some(part => part.type === "toolCall")) requestLimitReached = true;
          return stopped || exhausted || !!stage?.yielded || submission.accepted;
        },
        prepareNextTurnWithContext: async context => {
          request.signal.throwIfAborted();
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted before context maintenance.");
          const next = await budget.prepareNextTurnWithContext(context);
          const base = next?.context ?? context.context;
          const prepared = await prepareContext(base.messages, selected.model, request.signal, finalRequest() ? undefined : summarizer, false, base, contextMaintenance);
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted during context maintenance.");
          if (prepared.compacted) {
            if (taskReading) taskReading.epoch++;
            agent!.state.messages = prepared.messages;
            await persist();
            emit({ type: "notice", mode: request.mode, text: `Private context compacted (${prepared.estimatedTokensBefore} → ${prepared.estimatedTokensAfter} estimated tokens); original evidence remains available.` });
          }
          return { context: { ...base, messages: prepared.messages, ...(finalRequest() ? { tools: [], systemPrompt: `${base.systemPrompt}\n${finalInstruction}` } : {}) } };
        },
      });
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          finalMessage = event.message;
          addUsage(usage, modelUsage(event.message.usage));
        }
        // Keep UI/block state ordered at callback entry, before transcript I/O.
        forward!.handle(event);
        if (event.type === "message_end") {
          if (event.message.role === "assistant") for (const part of event.message.content) if (part.type === "toolCall") pending.add(part.id);
          if (event.message.role === "toolResult") pending.delete(event.message.toolCallId);
          // This awaited write precedes execution of any assistant tool batch.
          await persist();
        }
        // Log completed messages and tool events. Partial transcript copies would grow quadratically.
        if (event.type !== "message_update" && event.type !== "agent_end") {
          const logged = event.type === "message_start" ? { type: event.type, role: event.message.role } : event;
          await appendFile(join(request.runDir, "events.jsonl"), `${redact(JSON.stringify({ at: Date.now(), ...logged }))}\n`);
        }
      });
      const onAbort = () => agent?.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => request.signal.removeEventListener("abort", onAbort);
      request.signal.throwIfAborted();
      const running = agent.prompt(redact(prompt.userPrompt));
      if (request.signal.aborted) agent.abort();
      await running;
      request.signal.throwIfAborted();
      let retriedTransient = false;
      let partialJson = "";
      let completingJson = false;
      let responseText: string | undefined;
      let jsonBaseMessages: AgentMessage[] | undefined;
      const recoverResponse = async () => {
        // A provider's per-response boundary is not a task or retry-count budget.
        // Keep requesting the remainder until it stops, fails, or the user cancels
        // (or an explicitly configured budget is exhausted).
        while (!stage?.yielded && !checkpointError && !submission.accepted) {
          request.signal.throwIfAborted();
          if (budget.error) throw new Error(budget.error);
          if (isTransientModelFailure(finalMessage) && !retriedTransient && canRequest()) {
            const checkpoint = await loadCheckpoint(checkpointFile, identity);
            if (!checkpoint) throw new Error("No complete private checkpoint is available for continuation.");
            agent!.state.messages = checkpoint.messages;
            if (finalRequest()) {
              agent!.state.tools = [];
              agent!.state.systemPrompt += `\n${finalInstruction}`;
            }
            retriedTransient = true;
            emit({ type: "notice", mode: request.mode, text: "Transient model failure; continuing once from this role's completed tool results. No tool calls are replayed." });
            finalMessage = undefined;
            await agent!.continue();
            continue;
          }
          if (finalMessage?.stopReason !== "length") break;
          requireLengthProgress(finalMessage);
          if (!canRequest()) throw new Error("Cannot continue a provider length response: an explicitly configured invocation budget is exhausted. Completed results are retained.");
          if (pending.size || agent!.state.pendingToolCalls.size) throw new Error("Cannot continue a length response with unfinished tool calls; inspect their state before resuming.");
          const fragment = protocolText(finalMessage);
          // Once a JSON reply has started, finish its bytes without tools. A
          // thinking-only cutoff instead resumes the current work with its tools.
          if (completingJson || isProtocolText(fragment.trimStart())) {
            completingJson = true;
            partialJson += fragment;
            jsonBaseMessages ??= agent!.state.messages.slice(0, -1);
            // Pin the exact accumulated prefix as the last indivisible message.
            // Only earlier work history may be summarized, never protocol bytes.
            agent!.state.messages = [...jsonBaseMessages, { ...finalMessage, content: [{ type: "text", text: partialJson }] }];
            agent!.state.tools = [];
            agent!.shouldStopAfterTurn = async context => { await budget.shouldStopAfterTurn(context); return true; };
          }
          const prepared = await prepareContext(agent!.state.messages, selected.model, request.signal, finalRequest() ? undefined : summarizer, false,
            { systemPrompt: agent!.state.systemPrompt, tools: agent!.state.tools }, contextMaintenance);
          if (completingJson) jsonBaseMessages = prepared.messages.slice(0, -1);
          if (prepared.compacted) {
            if (taskReading) taskReading.epoch++;
            agent!.state.messages = prepared.messages;
            await persist();
            emit({ type: "notice", mode: request.mode, text: `Private context compacted (${prepared.estimatedTokensBefore} → ${prepared.estimatedTokensAfter} estimated tokens); original evidence remains available.` });
          }
          request.signal.throwIfAborted();
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted during length continuation; completed results are retained.");
          if (finalRequest()) {
            agent!.state.tools = [];
            agent!.state.systemPrompt += `\n${finalInstruction}`;
          }
          emit({ type: "notice", mode: request.mode, text: completingJson
            ? "Model response ended with length; continuing the unfinished JSON without tools. It will be validated only when complete."
            : "Model response ended with length; continuing from retained private context and completed tool results." });
          finalMessage = undefined;
          await agent!.prompt(completingJson
            ? "The provider cut off the JSON response. Continue exactly after its last character, outputting only the remaining JSON bytes; do not restart, repeat the prefix, or add fences. If the object is already complete, return only whitespace. Tools are unavailable. Only the complete validated object can be committed."
            : "The provider cut off the previous response. Continue the current task from the retained context and completed tool results; do not repeat completed actions. Return the required complete JSON when ready. The cutoff is not task completion.");
        }
        if (completingJson) responseText = partialJson + protocolText(finalMessage);
      };
      await recoverResponse();
      request.signal.throwIfAborted();
      if (budget.error) throw new Error(budget.error);
      if (requestLimitReached) throw new Error(`Agent budget reached before a final result (maxTurnsPerRun=${request.snapshot.config.limits.maxTurnsPerRun}, requests=${modelRequests}); completed evidence is retained.`);
      if (checkpointError) throw checkpointError;
      if (stage?.yielded) {
        const result: RunResult = { output: { summary: `${stage.summary} Partial checkpoint handed to Decide; Step success remains unverified.`, result: "blocked" }, usage, yielded: true };
        await writeFile(join(request.runDir, "output.json"), JSON.stringify(result, null, 2), { flag: "wx" });
        return result;
      }
      if (!finalMessage) throw new Error("Agent returned no final assistant message.");
      if (!submission.accepted && finalMessage.stopReason !== "stop") throw new Error(finalMessage.errorMessage ?? `Agent stopped without a complete result: ${finalMessage.stopReason}`);
      const validate = () => {
        if (submission.accepted) return submission.output;
        try { return validateText(responseText ?? protocolText(finalMessage)); }
        catch (error) {
          // Some providers restart with a full object despite a suffix request.
          // Accept it only if that completed response independently validates.
          if (completingJson) {
            try { return validateText(protocolText(finalMessage)); } catch { /* Report the assembled response's error. */ }
          }
          throw error;
        }
      };
      let output: unknown;
      try { output = validate(); }
      catch (error) {
        if (!canRequest()) throw new Error(`Final response protocol validation failed: ${error instanceof Error ? error.message : String(error)}`);
        const reason = error instanceof Error ? error.message : String(error);
        emit({ type: "notice", mode: request.mode, text: "Final response has an invalid protocol shape or reference; requesting one tool-free repair using existing results." });
        agent.state.tools = [];
        agent.shouldStopAfterTurn = async context => { await budget.shouldStopAfterTurn(context); return true; };
        partialJson = "";
        completingJson = false;
        responseText = undefined;
        jsonBaseMessages = undefined;
        await agent.prompt(`Repair only the final JSON protocol. Validation error: ${reason}.${request.mode !== "execute" ? decisionRepairGuidance(reason) : ""} Tools are unavailable. Use only observations already present; do not invent evidence, files, committed IDs, findings, or completion. New Goal IDs must be unused. Submit only records not already committed by checkpoints. Return the required single JSON object.`);
        await recoverResponse();
        request.signal.throwIfAborted();
        if (budget.error) throw new Error(budget.error);
        if (finalMessage?.stopReason !== "stop") throw new Error(finalMessage?.errorMessage ?? "Protocol repair did not finish.");
        try { output = validate(); }
        catch (error) { throw new Error(`Final response protocol validation failed after one repair: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (normalizationChanges.length) emit({ type: "notice", mode: request.mode, text: `Decision format normalized without another model request: ${normalizationChanges.join("; ")}` });
      await writeFile(join(request.runDir, "output.json"), JSON.stringify({ output, usage }, null, 2), { flag: "wx" });
      return { output, usage };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      throw new RuntimeRunError(message, usage);
    } finally {
      detachAbort?.();
      if (request.signal.aborted) agent?.abort();
      try { await agent?.waitForIdle(); }
      finally { forward?.finish(); unsubscribe?.(); executionTools.forEach(disposeHttpTool); await chrome?.close(); }
    }
  }
}
