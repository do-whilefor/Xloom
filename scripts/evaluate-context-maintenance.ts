import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { evaluateContextMaintenance } from "../tests/fixtures/context-maintenance.js";

const { values } = parseArgs({ options: { output: { type: "string" } }, strict: true });
const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), node: process.version,
  ...await evaluateContextMaintenance(resolve("synthetic-context-maintenance")) };
const output = resolve(values.output ?? join(tmpdir(), "xloom-context-maintenance-report.json"));
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, ...report }, null, 2));
if (report.sizes.some(row => !row.completeHistory || row.boundedIndexChars > 16000)
  || report.compaction.rounds.some(row => !row.compacted || !row.exactSourceRetained || !row.constraintRetained || !row.latestCorrectionRetained || !row.completeToolPairs)
  || report.repeatedReads.removedBatches !== 10 || report.repeatedReads.summaries !== 0 || report.weakQuery.hits !== 0) process.exitCode = 1;
