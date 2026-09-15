import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";
import { createCheckedPowerShellOperations, createCheckedPowerShellTool, powerShellPrompt } from "../src/runtime/powershell.js";
import { decidePrompt, executePrompt, metacogPrompt } from "../src/runtime/prompts.js";

const directories: string[] = [];
// Two sequential calls each allow 10 seconds, with 5 more for fixture I/O.
const twoCallTestTimeoutMs = 2 * 10_000 + 5_000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "xloom-powershell-test-"));
  directories.push(directory);
  return directory;
}

function parserSourcePath(command: string) {
  const match = command.match(/::ParseFile\('((?:[^']|'')*)',/);
  expect(match).not.toBeNull();
  return match![1].replaceAll("''", "'");
}

describe("PowerShell syntax preflight", () => {
  it("parses source as file data and executes the identical command exactly once", async () => {
    const command = String.raw`$items = @('"', 'it''s', 'C:\tmp\a_b.txt', 'http\://example.invalid', 'literal\_name')
$items | ConvertTo-Json -Compress`;
    let sourcePath = "";
    const seen: string[] = [];
    const signal = new AbortController().signal;
    const env = { TASK_TEST: "yes" };
    const onData = vi.fn();
    const operations: PowerShellOperations = { exec: async (source, cwd, options) => {
      seen.push(source);
      expect(cwd).toBe("workspace");
      expect(options.signal).toBe(signal);
      expect(options.env).toBe(env);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(10);
      sourcePath = parserSourcePath(source);
      expect(await readFile(sourcePath, "utf8")).toBe(`\uFEFF${command}`);
      expect(source).not.toContain(command);
      options.onData(Buffer.from("observed output"));
      return { exitCode: 0 };
    } };
    await expect(createCheckedPowerShellOperations(operations).exec(command, "workspace", { onData, signal, env, timeout: 10 })).resolves.toEqual({ exitCode: 0 });
    expect(seen).toHaveLength(1);
    expect(onData).toHaveBeenCalledExactlyOnceWith(Buffer.from("observed output"));
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dirname(sourcePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns parser diagnostics and actionable quoting guidance without running invalid source", async () => {
    const command = '$words = @("alpha",""","omega")';
    const onData = vi.fn();
    const exec = vi.fn<PowerShellOperations["exec"]>(async (source, _cwd, options) => {
      expect(source).not.toBe(command);
      expect(source).toContain("Backslash does not escape quotes");
      expect(source).toContain("No command text was repaired or replayed automatically");
      options.onData(Buffer.from("PowerShell ParserError: Line 1, column 24"));
      return { exitCode: 65 };
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec(command, "workspace", { onData })).resolves.toEqual({ exitCode: 65 });
    expect(exec).toHaveBeenCalledTimes(1);
    const text = onData.mock.calls.map(([data]) => data.toString()).join("");
    expect(text).toContain("Line 1, column 24");
  });

  it("does not replay a valid command after a runtime error", async () => {
    const exec = vi.fn<PowerShellOperations["exec"]>().mockResolvedValueOnce({ exitCode: 1 });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'partial'; exit 1", "workspace", { onData() {} })).resolves.toEqual({ exitCode: 1 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([1, null])("does not retry an incomplete or failed process (%s)", async exitCode => {
    const exec = vi.fn<PowerShellOperations["exec"]>().mockResolvedValue({ exitCode });
    const result = createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {} });
    if (exitCode === null) await expect(result).rejects.toThrow("inspect possible side effects");
    else await expect(result).resolves.toEqual({ exitCode });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("uses one timeout across parsing and execution", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(250);
    const exec = vi.fn<PowerShellOperations["exec"]>(async (_source, _cwd, options) => {
      expect(options.timeout).toBe(0.75);
      throw new Error("timeout:0.75");
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {}, timeout: 1 })).rejects.toThrow("timeout:1");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("cleans up parser source after cancellation and never starts the original command", async () => {
    const controller = new AbortController();
    let sourcePath = "";
    const exec = vi.fn<PowerShellOperations["exec"]>(async source => {
      sourcePath = parserSourcePath(source);
      controller.abort();
      throw new Error("aborted");
    });
    await expect(createCheckedPowerShellOperations({ exec }).exec("Write-Output 'test'", "workspace", { onData() {}, signal: controller.signal })).rejects.toThrow("aborted");
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps PowerShell quoting guidance in its tool description without duplicating it in system prompts", () => {
    const tool = createCheckedPowerShellTool("workspace");
    expect(tool.name).toBe("powershell");
    expect(tool.description).toContain(powerShellPrompt);
    expect(tool.description).toContain("Backslash does not escape PowerShell quotes");
    expect(tool.description).toContain("do not assume python3 exists on Windows");
    expect(tool.description).toContain("pipe loops via & { ... }");
    expect(tool.description).toContain("only supplied command text, not -File or dot-sourced scripts");
    expect(tool.description).toContain("Check every native result");
    expect(tool.description).toContain("earlier exits on PowerShell 7.4+");
    expect(tool.description).toContain("explicitly exit 0 after checking");
    for (const prompt of [decidePrompt, executePrompt, metacogPrompt]) expect(prompt).not.toContain(powerShellPrompt);
  });

  it("allows truthful tool progress while retaining the final JSON contract in all research modes", () => {
    for (const prompt of [decidePrompt, executePrompt, metacogPrompt]) {
      expect(prompt).toContain("Optional progress must be factual");
      expect(prompt).toContain("Never invent evidence or private reasoning");
      expect(prompt).toContain("Final response: one JSON object");
    }
  });
});

describe.runIf(process.platform === "win32")("PowerShell syntax regressions on Windows", () => {
  it("retains an unhandled native failure after another native command succeeds", async () => {
    const directory = await workspace(), tool = createCheckedPowerShellTool(directory);
    const command = "Add-Content -LiteralPath 'once.txt' -Value 'once'; node -e 'process.exit(7)'; node -e 'process.exit(0)'; Write-Output 'NEXT_OK'";
    await expect(tool.execute("earlier-native-failure", { command, timeout: 10 }))
      .rejects.toThrow(/NEXT_OK[\s\S]*unhandled errors=1[\s\S]*last native exit code=0/);
    expect((await readFile(join(directory, "once.txt"), "utf8")).trim()).toBe("once");
  });

  it("allows explicit expected native exits without leaking the preference into later calls", async () => {
    const tool = createCheckedPowerShellTool(await workspace());
    const result = await tool.execute("expected-exit", { command: "$PSNativeCommandUseErrorActionPreference = $false; node -e 'process.exit(7)'; $observedExit = $LASTEXITCODE; if ($observedExit -ne 7) { exit 1 }; node -e 'process.exit(0)'; Write-Output 'HANDLED'", timeout: 10 });
    expect(result.content.filter(part => part.type === "text").map(part => part.text).join("")).toContain("HANDLED");
    await expect(tool.execute("next-call", { command: "node -e 'process.exit(7)'; node -e 'process.exit(0)'", timeout: 10 })).rejects.toThrow("unhandled errors=1");
  }, twoCallTestTimeoutMs);

  it("allows native failures explicitly caught by the caller", async () => {
    const tool = createCheckedPowerShellTool(await workspace());
    const caught = await tool.execute("caught-exit", { command: "$ErrorActionPreference = 'Stop'; try { node -e 'process.exit(7)' } catch { Write-Output 'CAUGHT' }; node -e 'process.exit(0)'", timeout: 10 });
    expect(caught.content.filter(part => part.type === "text").map(part => part.text).join("")).toContain("CAUGHT");
  });

  it.each([
    ["Write-Error 'runtime failure'", 1],
    ["Write-Error 'recoverable'; Write-Output 'continued'", 1],
    ["& cmd.exe /c exit 37", 1],
    ["& cmd.exe /c exit 37; Write-Output 'continued'", 1],
    ["throw 'terminating failure'", 1],
    ["exit 65", 65],
    ["exit 17", 17],
  ])("reports execution failure while preserving explicit exits: %s", async (command, exitCode) => {
    const output: Buffer[] = [];
    const result = await createCheckedPowerShellOperations().exec(command, await workspace(), { onData: chunk => output.push(chunk), timeout: 10 });
    expect(result.exitCode).toBe(exitCode);
    expect(Buffer.concat(output).toString()).not.toContain("syntax preflight");
  });

  it.each([
    ["Get-Content -LiteralPath './absent.txt'", "unhandled errors=1"],
    ["node -e 'process.exit(7)'", "last native exit code=7"],
  ])("does not hide an earlier failure or replay its side effect: %s", async (failing, diagnostic) => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = `Add-Content -LiteralPath 'once.txt' -Value 'once'; ${failing}; Write-Output 'NEXT_OK'`;
    const failure = await tool.execute("hidden-failure", { command, timeout: 10 }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(diagnostic);
    expect(failure.message).toContain("NEXT_OK");
    expect(failure.message).toContain("Command exited with code 1");
    expect((await readFile(join(directory, "once.txt"), "utf8")).trim()).toBe("once");
  });

  it.each([
    "try { throw 'expected' } catch { Write-Output 'HANDLED' }",
    "Get-Content -LiteralPath './absent.txt' -ErrorAction SilentlyContinue; Write-Output 'HANDLED'",
    "node -e 'process.exit(7)'; if ($LASTEXITCODE -eq 7) { Write-Output 'HANDLED'; exit 0 }; exit 1",
    `node -e 'process.stderr.write("HANDLED")'`,
    "Write-Output 'HANDLED'; return",
  ])("preserves handled errors, successful stderr and explicit return: %s", async command => {
    const tool = createCheckedPowerShellTool(await workspace());
    const result = await tool.execute("handled", { command, timeout: 10 });
    const output = result.content.filter(part => part.type === "text").map(part => part.text).join("");
    expect(output).toContain("HANDLED");
    expect(output).not.toContain("execution diagnostics");
  });

  it("explains method-argument format errors without replaying writes, and accepts the corrected expression", async () => {
    const directory = await workspace(), tool = createCheckedPowerShellTool(directory);
    const failure = await tool.execute("bad-format", { command: "Add-Content -LiteralPath 'once.txt' -Value 'once'; $items=[System.Collections.Generic.List[string]]::new(); $items.Add('x={0}, y={1}' -f 1,2); Write-Output 'continued'", timeout: 10 }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("parenthesize the complete -f expression");
    expect(failure.message).toContain("$list.Add(('x={0}, y={1}' -f $x, $y))");
    expect(failure.message).toContain("do not blindly rerun");
    expect(failure.message).toContain("continued");
    const corrected = await tool.execute("fixed-format", { command: "$items=[System.Collections.Generic.List[string]]::new(); $items.Add(('x={0}, y={1}' -f 1,2)); $items", timeout: 10 });
    expect(corrected.content.filter(part => part.type === "text").map(part => part.text).join("").trim()).toBe("x=1, y=2");
    expect((await readFile(join(directory, "once.txt"), "utf8")).trim()).toBe("once");
  }, twoCallTestTimeoutMs);

  it("keeps the caller's environment, working directory and default preference scope", async () => {
    const directory = await workspace();
    const chunks: Buffer[] = [];
    await createCheckedPowerShellOperations().exec("@($env:XLOOM_TEST_VALUE, (Get-Location).Path, $ErrorActionPreference.ToString(), $PSScriptRoot, $PSCommandPath) | ConvertTo-Json -Compress", directory,
      { env: { ...process.env, XLOOM_TEST_VALUE: "fixture" }, onData: chunk => chunks.push(chunk), timeout: 10 });
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(["fixture", directory, "Continue", "", ""]);
  });

  it.each(["timeout", "cancel"])("stops a running command on %s without replaying its side effect", async kind => {
    const directory = await workspace();
    const control = new AbortController();
    const chunks: Buffer[] = [];
    const running = createCheckedPowerShellOperations().exec("Add-Content -LiteralPath 'once.txt' -Value 'once'; Write-Output 'started'; Start-Sleep -Seconds 30; Set-Content -LiteralPath 'late.txt' -Value 'late'", directory,
      { timeout: kind === "timeout" ? 2 : 10, signal: control.signal, onData(chunk) { chunks.push(chunk); if (kind === "cancel" && Buffer.concat(chunks).toString().includes("started")) control.abort(); } });
    await expect(running).rejects.toThrow(kind === "timeout" ? "timeout:2" : "aborted");
    expect((await readFile(join(directory, "once.txt"), "utf8")).trim()).toBe("once");
    await expect(readFile(join(directory, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a nested script's parser failure after executing its valid launcher exactly once", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "invalid-child.ps1"), `Add-Content -LiteralPath 'child-executed.txt' -Value 'must not run'
$values.Add((1 + 2)`, "utf8");
    const tool = createCheckedPowerShellTool(directory);
    const command = `Add-Content -LiteralPath 'launcher-count.txt' -Value 'once'
$childShell = (Get-Process -Id $PID).Path
& $childShell -NoProfile -File './invalid-child.ps1'`;

    const failure = await tool.execute("nested-parser-error", { command }).catch(error => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("invalid-child.ps1");
    expect(failure.message).toMatch(/ParserError|MissingEndParenthesisInMethodCall/);
    expect(failure.message).toContain("Command exited with code 1");
    expect(failure.message).not.toContain("command was not executed (syntax preflight)");
    expect(failure.message).not.toContain("No command text was repaired or replayed automatically");
    expect((await readFile(join(directory, "launcher-count.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(["once"]);
    await expect(readFile(join(directory, "child-executed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures loop output through a script block without running a redirection as a command", async () => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = `& { foreach ($item in 1, 2) { Write-Output ('fixture-' + $item) } } 2>&1 | Out-File -LiteralPath 'captured.txt' -Encoding utf8
Get-Content -LiteralPath 'captured.txt'`;
    const result = await tool.execute("capture-loop", { command, timeout: 10 });
    const output = result.content.filter(part => part.type === "text").map(part => part.text).join("");
    expect(output.trim().split(/\r?\n/)).toEqual(["fixture-1", "fixture-2"]);
    expect((await readFile(join(directory, "captured.txt"), "utf8")).trim().split(/\r?\n/)).toEqual(["fixture-1", "fixture-2"]);
  });

  it("rejects the reported triple-double-quote list before any file side effect", async () => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = `Set-Content -LiteralPath 'should-not-exist.txt' -Value 'side effect'
$words = @("alpha",""","omega")`;
    await expect(tool.execute("invalid-quote", { command, timeout: 10 })).rejects.toThrow(/PowerShell ParserError: command was not executed[\s\S]*Line 2, column/);
    await expect(readFile(join(directory, "should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    String.raw`$words = @("alpha","\"","omega")`,
    String.raw`$words = @("alpha","'","\"","-","%",""+'"',"omega")`,
  ])("rejects the C-style quote escape seen in recorded commands: %s", async command => {
    const tool = createCheckedPowerShellTool(await workspace());
    await expect(tool.execute("recorded-quote-regression", { command, timeout: 10 })).rejects.toThrow(/PowerShell ParserError: command was not executed[\s\S]*Line 1, column[\s\S]*Backslash does not escape quotes/);
  });

  it("preserves valid quote literals, Unicode, paths and intentional backslashes", async () => {
    const directory = await workspace();
    const tool = createCheckedPowerShellTool(directory);
    const command = String.raw`$items = @('"', 'it''s', '中文', 'C:\tmp\a_b.txt', 'http\://example.invalid', 'literal\_name')
$items | ConvertTo-Json -Compress`;
    const result = await tool.execute("valid-quote", { command, timeout: 10 });
    const output = result.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
    expect(JSON.parse(output)).toEqual(['"', "it's", "中文", String.raw`C:\tmp\a_b.txt`, String.raw`http\://example.invalid`, String.raw`literal\_name`]);
  });
});
