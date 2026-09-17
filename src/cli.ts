#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CHAT_GOAL, defaultConfig, ensureGlobalSettings, loadConfig, saveNewConfig, workspaceDefaults } from "./config.js";
import { BlackboardStore } from "./store.js";
import { LoopController } from "./controller.js";
import { DemoRunner } from "./demo.js";
import { renderReport } from "./report.js";
import { currentTaskId, listTasks, readSavedBoard, selectTask, taskDirectory, WorkspaceLock } from "./workspace.js";
import { ensureProject, projectConfigPath, projectDirectory, xloomHome } from "./paths.js";
import { migrateWorkspace } from "./migration.js";

const help = `xloom — local two-agent research loop (Windows MVP)

  xloom init --goal "User-supplied goal / authorized target" [--scope "target details"]
  xloom run [--headless]       Start fresh chat, or a new configured task headlessly
  xloom status               Read the saved board without running agents
  xloom report               Print a Markdown report with evidence references
  xloom doctor               Check local Node/PowerShell/config/model credentials
  xloom models [--provider NAME]  List Xloom's local built-in/cached/custom model catalog
  xloom paths                Show workspace, user data and configuration paths
  xloom tasks                List saved research tasks without running agents
  xloom chrome [status|disconnect|connect]  Manage the persistent Chrome connection
  xloom migrate [--pi-dir PATH]  Import legacy workspace data / model settings; retain originals
  xloom demo [--headless]     Offline synthetic fixture in a new temporary workspace

Options: --workspace PATH  --config PATH  --help
TUI: plain text chats; /run GOAL starts a separate two-agent task
     /model /apikey /new /tasks /open TASK_ID /paths /start /pause /stop /hint /meta /board /help /exit
     Ctrl+O toggles details; click an activity summary to expand and its content to collapse
User input defines authorization. No extra authorization confirmation or hooks.
Chat and Execute have read/write/edit/powershell/chrome for the running browser.
Decide and metacog have read for inspection. Research roles also have submit for structured proposals.
Tools run with the current user's OS permissions.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    goal: { type: "string" }, scope: { type: "string" }, workspace: { type: "string" }, config: { type: "string" },
    provider: { type: "string" }, "pi-dir": { type: "string" },
    headless: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
  }, allowPositionals: true, strict: true });
  const command = positionals[0] ?? "run";
  if (values.help || command === "help") { process.stdout.write(help); return; }
  if (positionals.length > (command === "chrome" ? 2 : 1)) throw new Error("Unexpected positional arguments; use --goal for task text.");
  const demo = command === "demo";
  if (!["init", "run", "status", "report", "doctor", "demo", "models", "paths", "tasks", "migrate", "chrome"].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (values.provider !== undefined && command !== "models") throw new Error("--provider is only supported by the models command.");
  if (values["pi-dir"] !== undefined && command !== "migrate") throw new Error("--pi-dir is only supported by migrate.");
  if (command === "models") {
    const { listModels } = await import("./runtime/index.js");
    const models = await listModels(values.provider);
    // Select public identifiers only; never print model headers or authentication.
    process.stdout.write(`${JSON.stringify(models.map(model => ({ provider: model.provider, model: model.id, api: model.api })), null, 2)}\n`);
    return;
  }
  if (demo && (values.workspace || values.config)) throw new Error("Demo always uses a new temporary workspace; omit --workspace and --config.");
  const workspace = demo ? mkdtempSync(path.join(tmpdir(), "xloom-demo-")) : realpathSync(path.resolve(values.workspace ?? process.cwd()));
  const configPath = values.config ? path.resolve(workspace, values.config) : projectConfigPath(workspace);
  if (command === "chrome") {
    const action = positionals[1] ?? "status";
    if (action !== "status" && action !== "disconnect" && action !== "connect") throw new Error("Use chrome [status|disconnect|connect].");
    const { controlChrome } = await import("./runtime/chrome-daemon.js");
    const result = await controlChrome({ workspace, artifactsDirectory: projectDirectory(workspace),
      config: existsSync(configPath) ? loadConfig(configPath).chrome : undefined }, action);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "tasks") { process.stdout.write(`${JSON.stringify(listTasks(workspace), null, 2)}\n`); return; }
  if (command === "paths") {
    const taskId = currentTaskId(workspace);
    process.stdout.write(`${JSON.stringify({ workspace, home: xloomHome(), project: projectDirectory(workspace), config: configPath,
      task: taskId || existsSync(path.join(projectDirectory(workspace), "blackboard.sqlite")) ? taskDirectory(workspace, taskId) : undefined,
      chats: path.join(projectDirectory(workspace), "chats") }, null, 2)}\n`);
    return;
  }
  if (command === "init" && !values.goal?.trim()) throw new Error("init requires --goal. Your input defines the authorized task and targets.");
  if ((command === "run" || demo) && !values.headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("TUI needs an interactive terminal. Use --headless to run explicitly without a TUI.");
  if (await migrateWorkspace(workspace)) process.stderr.write(`Imported legacy Xloom data into ${projectDirectory(workspace)}; original files retained.\n`);
  if (command === "migrate") {
    if (values["pi-dir"]) {
      const { importPiSettings } = await import("./runtime/storage.js");
      importPiSettings(realpathSync(path.resolve(values["pi-dir"])));
    }
    if (existsSync(configPath)) ensureGlobalSettings(loadConfig(configPath));
    process.stdout.write(`Data: ${projectDirectory(workspace)}\nOriginal files retained; existing imported data is never overwritten.\n`);
    return;
  }
  if (command === "init") {
    if (!values.goal?.trim()) throw new Error("init requires --goal. Your input defines the authorized task and targets.");
    ensureProject(workspace);
    const config = workspaceDefaults(values.goal!, values.scope);
    saveNewConfig(configPath, config);
    ensureGlobalSettings(config);
    process.stdout.write(`Created ${configPath}\nStart xloom, configure a provider with /apikey, then choose its model with /model. Goal completion, not a Step count, ends the loop.\n`);
    return;
  }
  if (command === "status" || command === "report") {
    const board = readSavedBoard(workspace);
    process.stdout.write(command === "report" ? renderReport(board, { workspace, dataDir: taskDirectory(workspace, currentTaskId(workspace)) }) : `${JSON.stringify({ status: board.status, outcome: board.outcome, reason: board.reason, revision: board.revision, steps: board.completedSteps, findings: board.findings.length, usage: board.usage, elapsedMs: board.elapsedMs ?? 0 }, null, 2)}\n`);
    return;
  }
  if (command === "doctor") {
    const shell = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    process.stdout.write(`Node ${process.version}; platform ${process.platform}\nPowerShell 7: ${shell.status === 0 ? shell.stdout.trim() : "not found on PATH"}\n`);
    if (process.platform !== "win32" || shell.status !== 0) throw new Error("This MVP expects Windows and PowerShell 7 (pwsh.exe) on PATH.");
    if (existsSync(configPath)) {
      const config = loadConfig(configPath);
      const { resolveModel } = await import("./runtime/index.js");
      for (const role of ["chat", "decide", "execute"] as const) {
        const resolved = await resolveModel(config.models[role] ?? config.models.execute, new AbortController().signal);
        process.stdout.write(`${role}: ${resolved.model.provider}/${resolved.model.id}; Xloom credential resolution OK (no model request)\n`);
      }
    } else process.stdout.write(`No workspace settings yet (${configPath}); use init --goal. No model request was made.\n`);
    return;
  }
  if (!values.headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("TUI needs an interactive terminal. Use --headless to run explicitly without a TUI.");
  if (!demo && !values.headless) {
    ensureProject(workspace);
    if (!existsSync(configPath)) saveNewConfig(configPath, workspaceDefaults(CHAT_GOAL));
    ensureGlobalSettings(loadConfig(configPath));
    const [{ AppController }, { startTui }] = await Promise.all([import("./app.js"), import("./ui/index.js")]);
    const app = new AppController(workspace, configPath, loadConfig(configPath));
    try { await startTui(app, workspace); } finally { await app.close(); }
    return;
  }
  const config = demo ? defaultConfig("DEMO: validate only the offline synthetic protocol fixture", "Local synthetic fixture; no external target") : loadConfig(configPath);
  if (demo) { ensureProject(workspace); config.title = "xloom DEMO (synthetic, no live test)"; saveNewConfig(configPath, config); process.stdout.write(`DEMO workspace: ${workspace}\n`); }
  else ensureGlobalSettings(config);
  const runner = demo ? new DemoRunner() : new (await import("./runtime/index.js")).PiRunner();
  const sessionLock = new WorkspaceLock(workspace);
  let store: BlackboardStore;
  try {
    if (config.goal === CHAT_GOAL) throw new Error("No red-team goal yet. Use init --goal to configure a headless task, or open the TUI and use /run with your goal.");
    const taskId = demo ? undefined : `task-${randomUUID()}`;
    store = new BlackboardStore(workspace, config, { taskId });
    try { selectTask(workspace, taskId ?? null); } catch (error) { store.close(); throw error; }
  } catch (error) { sessionLock.close(); throw error; }
  const controller = new LoopController(store, runner);
  try {
    if (values.headless) {
      const interrupt = () => controller.pause();
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      const unsubscribe = controller.subscribe(event => {
        if (event.type === "state" && event.snapshot) process.stdout.write(`[${event.snapshot.status}] ${event.snapshot.reason}\n`);
        else if (event.type === "handoff" && event.handoff) {
          const { role, mode, revision, trigger } = event.handoff;
          process.stdout.write(`[${mode === "metacog" ? "Decide · Meta" : role === "execute" ? "Execute" : "Decide"}] r${revision} · ${trigger.kind}\n`);
        }
        else if (event.type === "notice" && event.message) process.stdout.write(`${event.message}\n`);
        else if (event.runtime && event.runtime.type !== "text" && event.runtime.type !== "tool_update") process.stdout.write(`[${event.runtime.mode}] ${event.runtime.type}${event.runtime.toolName ? ` ${event.runtime.toolName}` : ""}\n`);
      });
      try { await controller.start(); } finally { unsubscribe(); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
      const board = controller.snapshot();
      process.stdout.write(`${board.outcome ?? board.status}: ${board.reason}\nBlackboard: ${store.projectionPath}\n`);
      if (board.status === "error") process.exitCode = 1;
    } else {
      const { startTui } = await import("./ui/index.js");
      await startTui(controller, workspace);
    }
  } finally { await controller.waitForIdle(); store.close(); sessionLock.close(); }
}

main().catch(error => { process.stderr.write(`xloom: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
