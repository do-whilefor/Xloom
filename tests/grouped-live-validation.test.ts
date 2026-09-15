import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolFailureDetails } from "../scripts/lib/tool-failure-details.js";
import { validateDecisionReferences } from "../src/loop/references.js";
import { nativeFixture } from "./fixtures/native-retrieval.js";
import type { Decision, RuntimeEvent } from "../src/types.js";

describe("grouped live replay diagnostics", () => {
  const start: RuntimeEvent = { type: "tool_start", mode: "decide", toolName: "submit", toolCallId: "first", text: '{"output":{"gapReviews":[{"gapId":"gap-inputs"}]}}' };
  const error: RuntimeEvent = { type: "tool_end", mode: "decide", toolName: "submit", toolCallId: "first", text: "Review each gap only once per decision.", isError: true };

  it("retains the first rejected submission and its input after the next submission is accepted", () => {
    const accepted: RuntimeEvent = { ...error, toolCallId: "repair", text: '{"accepted":true}', isError: false };
    expect(toolFailureDetails([start, error, accepted])).toEqual([{ mode: "decide", toolName: "submit", toolCallId: "first", message: error.text, input: start.text }]);
    expect(toolFailureDetails([accepted])).toEqual([]);
  });

  it("redacts plain and JSON-encoded credentials without losing validation diagnostics", () => {
    const secret = 'synthetic-"credential\\value';
    const details = toolFailureDetails([{ ...start, text: JSON.stringify({ output: secret }) },
      { ...error, text: `Validation failed: ${secret}` }], [secret]);
    expect(details[0]).toMatchObject({ input: '{"output":"[MODEL_CREDENTIAL_REDACTED]"}', message: "Validation failed: [MODEL_CREDENTIAL_REDACTED]" });
    expect(JSON.stringify(details)).not.toContain("synthetic-");
  });

  it("does not attach another role or call's input to a failure", () => {
    for (const changed of [{ ...error, mode: "execute" as const }, { ...error, toolCallId: "other" }, { ...error, toolName: "read" }]) {
      expect(toolFailureDetails([start, changed])[0]?.input).toBeUndefined();
    }
  });

  it("keeps a gap's revisit plan mutually exclusive with an explicit disposition", () => {
    const root = mkdtempSync(join(tmpdir(), "xloom-grouped-gap-contract-")), fixture = nativeFixture(root);
    try {
      const board = fixture.store.snapshot(), ref = { stepId: fixture.step.id, gapId: "gap-download" };
      const plan: Decision = { summary: "Plan a bounded follow-up", steps: [{ goalId: fixture.step.goalId, from: [],
        description: "Inspect the missing input", successSignal: "Actual conditions recorded", evidencePlan: "Retain source bytes", priority: 1, revisits: [ref] }] };
      const defer: Decision = { summary: "Wait for input", gapReviews: [{ ...ref, action: "defer", reason: "Still missing input", factIds: [] }] };
      expect(() => validateDecisionReferences(board, plan)).not.toThrow();
      expect(() => validateDecisionReferences(board, defer)).not.toThrow();
      expect(() => validateDecisionReferences(board, { ...plan, gapReviews: defer.gapReviews })).toThrow("Review each gap only once per decision.");
      expect(() => validateDecisionReferences(board, { ...defer, gapReviews: [...defer.gapReviews!, ...defer.gapReviews!] })).toThrow("Review each gap only once per decision.");
      expect(fixture.store.snapshot()).toEqual(board);
    } finally { fixture.store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
