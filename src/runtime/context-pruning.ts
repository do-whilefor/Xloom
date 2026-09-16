import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Only complete native reads with no narration qualify. A user turn, ordinary
 * file read or mutating tool is a barrier; repeated observations across actions
 * may be evidence of a change (or lack of change), not redundant context. */
export function nativeReadBatch(messages: AgentMessage[]): { signature: string; original: boolean } | undefined {
  const [assistant, ...results] = messages;
  if (assistant?.role !== "assistant" || !assistant.content.length || assistant.content.some(part => part.type !== "toolCall")) return;
  const calls = assistant.content.filter(part => part.type === "toolCall");
  if (calls.length !== results.length) return;
  const packets: unknown[] = []; let original = false;
  for (const [i, call] of calls.entries()) {
    const result = results[i];
    if (call.name !== "read" || typeof call.arguments.path !== "string" || !call.arguments.path.startsWith("xloom://")
      || result?.role !== "toolResult" || result.toolCallId !== call.id || result.toolName !== "read" || result.isError
      || !(result.details as { nativeRetrieval?: boolean } | undefined)?.nativeRetrieval
      || result.content.length !== 1 || result.content[0]?.type !== "text") return;
    try {
      const packet = JSON.parse(result.content[0].text);
      if (!packet || typeof packet !== "object" || packet.complete === false || !["original_read", "retrieval", "task_search", "question_context"].includes(packet.type)) return;
      if (packet.type === "original_read") {
        if (packet.integrity !== "verified") return;
        original = true;
      }
      // Delivery/cache counters change on repeat; all source text, warnings,
      // locators, signatures and conditions remain in the equality comparison.
      const { reading: _reading, retrievalProgress: _progress, index: _index, ...content } = packet;
      packets.push([call.arguments, content]);
    } catch { return; }
  }
  return { signature: JSON.stringify(packets), original };
}

export function pruneReadBatches(messages: AgentMessage[], batches: { start: number; end: number }[]) {
  const seen = new Set<string>(), removed = new Set<number>();
  for (let i = batches.length - 1; i > 0; i--) {
    const batch = batches[i]!, reading = nativeReadBatch(messages.slice(batch.start, batch.end));
    if (!reading) { seen.clear(); continue; }
    if (seen.has(reading.signature) && i < batches.length - 2) removed.add(i);
    seen.add(reading.signature);
  }
  return { messages: batches.flatMap((batch, i) => removed.has(i) ? [] : messages.slice(batch.start, batch.end)), removed: removed.size };
}
