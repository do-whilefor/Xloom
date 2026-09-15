import { redactCredentials } from "../../src/runtime/redaction.js";
import type { RuntimeEvent } from "../../src/types.js";

/** Preserve first-pass failures even after a successful repair, without provider credentials. */
export function toolFailureDetails(events: readonly RuntimeEvent[], secrets: readonly string[] = []) {
  const starts = new Map<string, RuntimeEvent>();
  const errors: { mode: RuntimeEvent["mode"]; toolName?: string; toolCallId?: string; message: string; input?: string }[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.mode, event.toolName, event.toolCallId]);
    if (event.type === "tool_start") { starts.set(key, event); continue; }
    if (event.type !== "tool_end") continue;
    const start = event.toolCallId ? starts.get(key) : undefined; starts.delete(key);
    if (event.isError) errors.push({ mode: event.mode, toolName: event.toolName, toolCallId: event.toolCallId,
      message: redactCredentials(event.text, secrets), ...(start ? { input: redactCredentials(start.text, secrets) } : {}) });
  }
  return errors;
}
