import type { AgentMessage } from "@earendil-works/pi-agent-core";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Normalize only documented packet locations, never similarly named fields
 * inside source records. Keep cache warnings and unknown metadata significant. */
function readContent(packet: Record<string, unknown>): Record<string, unknown> {
  const { reading: _reading, retrievalProgress: _progress, ...content } = packet;
  if (["retrieval", "original_search"].includes(String(packet.type)) && isRecord(packet.index)) {
    const { added: _added, updated: _updated, reused: _reused, removed: _removed, indexedBytes: _bytes,
      verifiedOriginals: _verified, snapshotReused: _snapshot, ...index } = packet.index;
    if (Object.keys(index).length) content.index = index;
    else delete content.index;
  }
  const children = packet.type === "task_search" ? { wiki: "retrieval", originals: "original_search" }
    : packet.type === "question_context" ? { sourceContext: "retrieval", originals: "original_search" } : {};
  for (const [key, type] of Object.entries(children)) {
    const child = content[key];
    if (isRecord(child) && child.type === type) content[key] = readContent(child);
  }
  return content;
}

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
      packets.push([call.arguments, readContent(packet)]);
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
