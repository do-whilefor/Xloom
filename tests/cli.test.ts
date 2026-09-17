import { ensureProject, projectConfigPath, projectDirectory, workspaceLockPath } from "../src/paths.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_GOAL, defaultConfig, loadConfig, saveNewConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { currentTaskId, readSavedBoard, selectTask, taskDirectory } from "../src/workspace.js";
import { renderReport } from "../src/report.js";
import type { BoardSnapshot } from "../src/types.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cliFile = path.join(projectRoot, "src", "cli.ts");
const tsxFile = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const roots: string[] = [];
const missingKeyVariable = "XLOOM_CLI_TEST_MISSING_MODEL_CREDENTIAL_17";
const cliProcessTimeoutMs = 20_000;

it("lists tasks and current data paths without acquiring a writer or changing the board", () => {
  const root = workspace();
  const store = new BlackboardStore(root, defaultConfig("Saved task fixture"), { taskId: "task-inventory" });
  try {
    selectTask(root, "task-inventory");
    const before = store.snapshot();
    const result = cli(["tasks"], root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.objectContaining({ id: "task-inventory", selected: true, goal: "Saved task fixture" }));
    const paths = cli(["paths"], root);
    expect(paths.status).toBe(0);
    expect(JSON.parse(paths.stdout)).toMatchObject({ task: store.dataDir, chats: path.join(projectDirectory(root), "chats") });
    expect(store.snapshot()).toEqual(before);
  } finally { store.close(); }
});

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-cli-test-"));
  roots.push(root);
  return root;
}

function cli(args: string[], cwd = workspace()) {
  const result = spawnSync(process.execPath, [tsxFile, cliFile, ...args], {
    cwd, encoding: "utf8", timeout: cliProcessTimeoutMs, windowsHide: true,
    env: { ...process.env, [missingKeyVariable]: "", NO_COLOR: "1", PI_CODING_AGENT_DIR: path.join(cwd, ".pi-test"), PI_OFFLINE: "1" },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

function saveWorkspaceConfig(root: string, config: ReturnType<typeof defaultConfig>) {
  ensureProject(root);
  saveNewConfig(projectConfigPath(root), config);
}

function databaseState(root: string) {
  const db = new DatabaseSync(path.join(taskDirectory(root, currentTaskId(root)), "blackboard.sqlite"), { readOnly: true });
  try {
    return {
      board: JSON.parse(String(db.prepare("SELECT value FROM board WHERE id=1").get()!.value)) as BoardSnapshot,
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      runs: db.prepare("SELECT * FROM runs ORDER BY startedAt").all(),
    };
  } finally { db.close(); }
}

function registerDemoRoot(root: string): string {
  const canonical = realpathSync(root);
  const temporaryRoot = realpathSync(tmpdir());
  expect(path.dirname(canonical).toLocaleLowerCase()).toBe(temporaryRoot.toLocaleLowerCase());
  expect(path.basename(canonical)).toMatch(/^xloom-demo-[A-Za-z0-9]+$/);
  roots.push(canonical);
  return canonical;
}

afterEach(() => {
  const temporaryRoot = realpathSync(tmpdir());
  for (const root of roots.splice(0)) {
    const canonical = realpathSync(root);
    if (path.dirname(canonical).toLocaleLowerCase() !== temporaryRoot.toLocaleLowerCase()
      || !/^xloom-(?:cli-test|demo)-[A-Za-z0-9]+$/.test(path.basename(canonical))) {
      throw new Error(`Refusing test cleanup outside exact generated temp workspace: ${canonical}`);
    }
    rmSync(canonical, { recursive: true, force: true });
  }
});

describe("command-line entry points", () => {
  it("initializes a workspace from BOM-prefixed global defaults", () => {
    const root = workspace(), dataHome = path.join(root, "home");
    mkdirSync(dataHome);
    const { version, models, limits } = defaultConfig("unrelated goal");
    const settings = `\uFEFF${JSON.stringify({ version, models, limits })}`;
    const globalFile = path.join(dataHome, "settings.json");
    writeFileSync(globalFile, settings);
    const result = spawnSync(process.execPath, [tsxFile, cliFile, "init", "--goal", "BOM fixture"], {
      cwd: root, encoding: "utf8", timeout: 20000, windowsHide: true,
      env: { ...process.env, XLOOM_HOME: dataHome, PI_OFFLINE: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    const file = result.stdout.match(/^Created (.+)\r?$/m)?.[1].trim();
    expect(file).toBeTruthy();
    expect(loadConfig(file!)).toMatchObject({ goal: "BOM fixture", models, limits });
    expect(readFileSync(globalFile, "utf8")).toBe(settings);
  });

  it("controls Chrome without TTY, model credentials, a configured task or browser startup", () => {
    const root = workspace();
    const status = () => JSON.parse(cli(["chrome"], root).stdout);
    expect(status()).toEqual({ bridgeRunning: false, manuallyDisconnected: false });
    expect(existsSync(projectDirectory(root))).toBe(false);
    expect(cli(["chrome", "disconnect"], root).status).toBe(0);
    expect(status()).toEqual({ bridgeRunning: false, manuallyDisconnected: true });
    expect(cli(["chrome", "connect"], root).status).toBe(0);
    expect(status()).toEqual({ bridgeRunning: false, manuallyDisconnected: false });
    expect(existsSync(projectConfigPath(root))).toBe(false);
    expect(cli(["chrome", "unknown"], root).combined).toContain("Use chrome");
    expect(cli(["chrome", "connect", "extra"], root).status).toBe(1);
  }, 30_000);

  it("resolves arbitrary launch directories and explicit workspace without creating local data", () => {
    const a = workspace(); const b = workspace();
    const first = JSON.parse(cli(["paths"], a).stdout);
    const second = JSON.parse(cli(["paths"], b).stdout);
    expect(first).toMatchObject({ workspace: realpathSync(a), home: process.env.XLOOM_HOME, project: projectDirectory(a), config: projectConfigPath(a) });
    expect(first.project).not.toBe(second.project);
    expect(JSON.parse(cli(["paths", "--workspace", a], b).stdout)).toEqual(first);
    expect(existsSync(projectDirectory(a))).toBe(false);
    expect(existsSync(projectDirectory(b))).toBe(false);
    expect(existsSync(path.join(a, ".xloom"))).toBe(false);
  });

  it("shows help without creating project state or starting agents", () => {
    const root = workspace();
    const result = cli(["--help"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local two-agent research loop");
    expect(result.stdout).toContain("read/write/edit/powershell");
    expect(result.stdout).toContain("Chat and Execute have read/write/edit/powershell");
    expect(result.stdout).toContain("Chat and Execute have read/write/edit/powershell/chrome");
    expect(result.stdout).toContain("chrome [status|disconnect|connect]");
    expect(result.stdout).toContain("Decide and metacog have read for inspection");
    expect(result.stdout).toContain("submit for structured proposals");
    expect(result.stdout).toContain("--headless");
    expect(result.stdout).toContain("Ctrl+O");
    expect(result.stdout).toContain("/exit");
    expect(result.stdout).toContain("/login");
    expect(result.stdout).toContain("/logout");
    expect(result.stdout).not.toMatch(/\/apikey|\/details|\/quit/);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
    expect(existsSync(path.join(root, "xloom.json"))).toBe(false);
  });

  it("initializes user-input scope and preserves the config byte-for-byte on repeated init", () => {
    const root = workspace();
    const initialized = cli(["init", "--goal", "验证本地 fixture 对象权限"], root);
    expect(initialized.status).toBe(0);
    expect(initialized.stdout).toContain("configure a provider with /login, then choose its model with /model");
    expect(initialized.stdout).not.toMatch(/\bPi\b/);
    const file = projectConfigPath(root);
    const config = loadConfig(file);
    expect(config.goal).toBe("验证本地 fixture 对象权限");
    expect(config.scope).toBe(config.goal);
    expect(config.limits).not.toHaveProperty("maxSteps");
    expect(config.limits.maxTokens).toBeNull();
    expect(config.limits.maxTurnsPerRun).toBeNull();
    expect(config.limits.maxMinutes).toBeNull();
    expect(config.limits.stepTimeoutSeconds).toBeNull();
    const original = readFileSync(file);
    const repeated = cli(["init", "--goal", "Must not replace the original goal"], root);
    expect(repeated.status).toBe(1);
    expect(repeated.combined).toMatch(/EEXIST|already exists/i);
    expect(readFileSync(file)).toEqual(original);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("supports explicit workspace, scope and config filename", () => {
    const cwd = workspace();
    const target = workspace();
    const result = cli(["init", "--workspace", target, "--config", "project.json", "--goal", "Check fixture ownership", "--scope", "http://127.0.0.1:8000 fixture only"], cwd);
    expect(result.status).toBe(0);
    expect(loadConfig(path.join(target, "project.json")).scope).toBe("http://127.0.0.1:8000 fixture only");
    expect(existsSync(path.join(cwd, "xloom.json"))).toBe(false);
  });

  it("requires an explicit initialization goal", () => {
    const root = workspace();
    const result = cli(["init"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --goal/);
    expect(existsSync(path.join(root, "xloom.json"))).toBe(false);
  });

  it("refuses non-TTY run unless headless execution was explicit, before loading agents or state", () => {
    const root = workspace();
    const result = cli(["run"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/TUI needs an interactive terminal/);
    expect(result.stderr).not.toMatch(/credential|configuration at/i);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("fails safely when a headless run has no configuration", () => {
    const root = workspace();
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot read xloom configuration/);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("does not turn a chat-only configuration into a headless research task", () => {
    const root = workspace();
    saveWorkspaceConfig(root, defaultConfig(CHAT_GOAL));
    const old = new BlackboardStore(root, defaultConfig("Old saved goal"), { taskId: "task-old" });
    const before = old.snapshot(); old.close(); selectTask(root, "task-old");
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No red-team goal yet");
    expect(existsSync(path.join(projectDirectory(root), "blackboard.sqlite"))).toBe(false);
    expect(existsSync(workspaceLockPath(root))).toBe(false);
    expect(readSavedBoard(root)).toEqual(before);
  });

  it("reads the selected independent TUI task rather than creating or using a root task", () => {
    const root = workspace();
    saveWorkspaceConfig(root, defaultConfig(CHAT_GOAL));
    const store = new BlackboardStore(root, defaultConfig("Selected TUI fixture goal"), { taskId: "task-selected" });
    store.hint("Only this task hint");
    const before = store.snapshot(); store.close(); selectTask(root, "task-selected");
    const result = cli(["report"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Selected TUI fixture goal");
    expect(result.stdout).not.toContain(CHAT_GOAL);
    const reopened = new BlackboardStore(root, before.config, { taskId: "task-selected" });
    expect(reopened.snapshot()).toEqual(before); reopened.close();
    expect(existsSync(path.join(projectDirectory(root), "blackboard.sqlite"))).toBe(false);
  });

  it.each(["../outside", "missing-task"])("ignores an invalid old task pointer (%s) when starting a fresh headless task", taskId => {
    const root = workspace();
    const config = defaultConfig("Fresh configured goal");
    config.models.decide.apiKeyEnv = missingKeyVariable;
    saveWorkspaceConfig(root, config);
    ensureProject(root);
    writeFileSync(path.join(projectDirectory(root), "current-task.json"), JSON.stringify({ taskId }));
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.combined).toContain(`Missing model credential environment variable: ${missingKeyVariable}`);
    expect(existsSync(workspaceLockPath(root))).toBe(false);
    expect(currentTaskId(root)).not.toBe(taskId);
    expect(databaseState(root).board).toMatchObject({ config: { goal: config.goal }, facts: [], hints: [] });
  });

  // Two sequential CLI processes need their own startup budgets, plus fixture I/O.
  it("fails without a model request when the named credential variable is missing", () => {
    const root = workspace();
    const config = defaultConfig("Missing-credential fixture");
    config.models.decide.apiKeyEnv = missingKeyVariable;
    config.models.execute.apiKeyEnv = missingKeyVariable;
    const old = new BlackboardStore(root, { ...config, goal: "OLD_TASK_GOAL", chrome: { enabled: true } });
    old.hint("OLD_TASK_HINT"); const before = old.snapshot(); old.close();
    config.chrome = { enabled: false, channel: "beta" };
    saveWorkspaceConfig(root, config);
    const result = cli(["run", "--headless"], root);
    expect(result.status).toBe(1);
    expect(result.combined).toContain(`Missing model credential environment variable: ${missingKeyVariable}`);
    expect(result.combined).not.toMatch(/VULN_FOUND/);
    const saved = databaseState(root);
    expect(saved.board).toMatchObject({ status: "error", outcome: null, completedSteps: 0, usage: { input: 0, output: 0, cost: 0 } });
    expect(saved.board.facts).toEqual([]);
    expect(saved.board.config.chrome).toEqual(config.chrome);
    expect(saved.board.config.goal).toBe(config.goal);
    expect(saved.board.hints).toEqual([]);
    expect(readSavedBoard(root, null)).toEqual(before);
    const firstId = currentTaskId(root)!;
    const repeated = cli(["run", "--headless"], root);
    expect(repeated.combined).toContain(`Missing model credential environment variable: ${missingKeyVariable}`);
    expect(currentTaskId(root)).not.toBe(firstId);
    expect(readSavedBoard(root, firstId)).toEqual(saved.board);
    expect(existsSync(path.join(projectDirectory(root), "controller.lock"))).toBe(false);
  }, 2 * cliProcessTimeoutMs + 5_000);

  it("rejects status/report without creating an empty database", () => {
    const root = workspace();
    for (const command of ["status", "report"]) {
      const result = cli([command], root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No blackboard yet/);
    }
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
  });

  it("ships a valid example config with the same strict runtime contract", () => {
    const config = loadConfig(path.join(projectRoot, "xloom.example.json"));
    expect(config.version).toBe(1);
    expect(config.models.decide.apiKeyEnv).toBeUndefined();
    expect(config.models.execute.apiKeyEnv).toBeUndefined();
    expect(config.context).toContain("不会自动加载");
  });

  it("lists Pi models without project config, credentials, or an Agent run", () => {
    const root = workspace();
    const result = cli(["models", "--provider", "anthropic"], root);
    expect(result.status).toBe(0);
    const models = JSON.parse(result.stdout) as Record<string, string>[];
    expect(models.some(model => model.model === "claude-sonnet-4-6")).toBe(true);
    expect(models.every(model => model.provider === "anthropic" && Object.keys(model).sort().join() === "api,model,provider")).toBe(true);
    expect(existsSync(path.join(root, ".xloom"))).toBe(false);
    expect(existsSync(path.join(root, "xloom.json"))).toBe(false);
  });
});

describe("offline demo and read-only reports", () => {
  it("runs the complete synthetic loop, then reads status/report without changing saved state", () => {
    const result = cli(["demo", "--headless"]);
    const reportedRoot = result.stdout.match(/^DEMO workspace: (.+)\r?$/m)?.[1].trim();
    expect(reportedRoot).toBeTruthy();
    const root = registerDemoRoot(reportedRoot!);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DEMO ONLY");
    expect(result.stdout).toContain("no live target or model was tested");
    expect(result.stdout).not.toContain("VULN_FOUND");
    const before = databaseState(root);
    expect(before.board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, usage: { input: 0, output: 0, cost: 0 } });
    expect(before.board.config.title).toContain("synthetic");
    expect(before.board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(before.board.evidence).toHaveLength(1);
    const artifact = JSON.parse(readFileSync(path.join(projectDirectory(root), before.board.evidence[0].path), "utf8"));
    expect(artifact.synthetic).toBe(true);
    expect(artifact.purpose).toContain("NOT a network response or vulnerability evidence");
    expect(before.runs.map(run => run.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    const projection = readFileSync(path.join(projectDirectory(root), "blackboard.md"));

    const status = cli(["status", "--workspace", root]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", steps: 1 });
    const report = cli(["report", "--workspace", root]);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("synthetic");
    expect(report.stdout).toContain("SHA-256");
    expect(report.stdout).toContain("PoC evidence: not attached");
    expect(report.stdout).toContain("Integrity and schema checks do not independently establish a vulnerability");
    expect(report.stdout).not.toContain("VULN_FOUND");
    expect(databaseState(root)).toEqual(before);
    expect(readFileSync(path.join(projectDirectory(root), "blackboard.md"))).toEqual(projection);
    expect(existsSync(path.join(projectDirectory(root), "controller.lock"))).toBe(false);
  }, 30_000);

  it("renders claimed impact and evidence as reviewable data, not independently proven truth", () => {
    const board: BoardSnapshot = {
      revision: 1, config: defaultConfig("Report fixture"), status: "paused", outcome: null, reason: "Impact needs validation",
      goals: [], facts: [], steps: [], hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1,
      evidence: [{ id: "E1", path: ".xloom/evidence/test.bin", sha256: "a".repeat(64), bytes: 12, description: "Synthetic report fixture", runId: "R1", stepId: "S1" }],
      findings: [{ id: "V1", key: "fixture", title: "Unverified fixture claim", target: "fixture object", status: "technical_hit", rating: "unrated", evidenceIds: ["E1"], factIds: [], next: "Validate capability and affected object", impact: { capability: "Claimed read", object: "Fixture object", result: "Unverified result", scope: "Unknown", prerequisites: "Fixture account" } }],
    };
    const report = renderReport(board);
    expect(report).toContain("Status: technical_hit | Rating: unrated");
    expect(report).toContain("capability: Claimed read");
    expect(report).toContain("result: Unverified result");
    expect(report).toContain("Evidence: E1");
    expect(report).toContain("SHA-256");
    expect(report).toContain("do not independently establish a vulnerability");
    expect(report).not.toContain("VULN_FOUND");
  });
});
