import { expect, it } from "vitest";
import { evaluateContextMaintenance } from "./fixtures/context-maintenance.js";

it("keeps discoverability, corrections and exact sources through bounded context and repeated lossy compaction", async () => {
  const report = await evaluateContextMaintenance(process.cwd());
  for (const row of report.sizes) {
    expect(row.boundedIndexChars).toBeLessThanOrEqual(16000);
    expect(row.completeHistory).toBe(true);
    expect(row.indexedFacts + row.omittedFacts).toBe(row.facts);
  }
  expect(report.sizes.at(-1)!.contextChars).toBeLessThan(report.sizes.at(-1)!.allIndexEquivalentContextChars / 10);
  expect(report.compaction.summaries).toBe(3);
  for (const row of report.compaction.rounds) {
    expect(row).toMatchObject({ compacted: true, exactSourceRetained: true, constraintRetained: true, latestCorrectionRetained: true, completeToolPairs: true });
    expect(row.afterChars).toBeLessThan(row.beforeChars);
  }
  expect(report.repeatedReads).toMatchObject({ removedBatches: 10, summaries: 0 });
  expect(report.weakQuery).toEqual({ hits: 0, matchQuality: "no_informative_match" });
});
