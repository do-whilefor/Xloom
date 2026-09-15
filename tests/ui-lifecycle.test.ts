import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor, Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { AppController, type AppOptions } from "../src/app.js";
import { CHAT_GOAL, defaultConfig, saveNewConfig } from "../src/config.js";
import { currentTaskId, readSavedBoard } from "../src/workspace.js";
import { runTui } from "../src/ui/index.js";

class MemoryTerminal implements Terminal {
  columns = 90; rows = 24; kittyProtocolActive = false; stopped = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(): void {} moveBy(): void {} hideCursor(): void {} showCursor(): void {}
  clearLine(): void {} clearFromCursor(): void {} clearScreen(): void {}
  setTitle(): void {} setProgress(): void {}
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(runner: NonNullable<AppOptions["runner"]>) {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-ui-lifecycle-"));
  const config = defaultConfig(CHAT_GOAL); config.chrome = { enabled: false };
  const configPath = path.join(root, "xloom.json"); saveNewConfig(configPath, config);
  const options: AppOptions = { runner,
    chat: { async send() { return { input: 0, output: 0, cost: 0 }; }, reset() {} },
    settings: { async listModels() { return []; }, async listProviders() { return []; },
      async saveApiKey() {}, async login() {}, async logout() {} },
  };
  const apps: AppController[] = [];
  const open = () => { const app = new AppController(root, configPath, config, options); apps.push(app); return app; };
  const app = open();
  cleanup.push(async () => { for (const item of apps) await item.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, app, open };
}

type Exit = "command" | "ctrl-c" | "SIGINT" | "SIGTERM";
function launch(app: AppController) {
  const terminal = new MemoryTerminal();
  let editor!: Editor;
  let tui!: TuiAltScreen;
  const session = runTui(app, terminal, { workspace: app.workspace,
    clipboard: { async readText() { return ""; }, async writeText() { return true; } },
    onReady(controls) { editor = controls.editor; tui = controls.tui; } });
  const submit = (text: string) => { editor.setText(text); terminal.input("\r"); };
  const quit = (kind: Exit) => {
    if (kind === "command") submit("/exit");
    else if (kind === "ctrl-c") { terminal.input("\x03"); terminal.input("\x03"); }
    else process.emit(kind);
  };
  cleanup.push(async () => { if (!terminal.stopped) quit("command"); await session; });
  return { terminal, session, quit, submit, tui };
}

describe("real AppController and TUI shutdown", () => {
  for (const status of ["paused", "error"] as const) {
    it.each<Exit>(["command", "ctrl-c", "SIGINT", "SIGTERM"])(`preserves an idle ${status} task through %s and starts the next launch empty`, async kind => {
      const test = fixture({ async run() {
        if (status === "error") throw new Error("Synthetic original checksum failure");
        return { output: { summary: "No executable fixture step" }, usage: { input: 0, output: 0, cost: 0 } };
      } });
      await test.app.runGoal("Preserve this task's original diagnosis");
      const before = test.app.snapshot(), taskId = currentTaskId(test.root)!;
      expect(before.status).toBe(status);
      const tui = launch(test.app); tui.quit(kind); await tui.session; await test.app.close();
      expect(tui.terminal.stopped).toBe(true);
      expect(readSavedBoard(test.root)).toEqual(before);
      const reopened = test.open();
      expect(reopened.getSessionInfo()).toMatchObject({ mode: "chat", busy: false, status: "idle", usage: { input: 0, output: 0, cost: 0 } });
      expect(reopened.snapshot()).toMatchObject({ facts: [], steps: [], hints: [] });
      expect(reopened.listTasks().every(task => !task.selected)).toBe(true);
      reopened.openTask(taskId);
      expect(reopened.snapshot()).toEqual(before);
    });
  }

  it("cancels an open settings dialog without stopping the idle selected task", async () => {
    const test = fixture({ async run() {
      return { output: { summary: "No executable fixture step" }, usage: { input: 0, output: 0, cost: 0 } };
    } });
    await test.app.runGoal("Keep the paused task diagnosis while choosing a model");
    const before = test.app.snapshot(), ui = launch(test.app);
    ui.submit("/model"); await Promise.resolve();
    expect(ui.tui.hasOverlay()).toBe(true);
    expect(test.app.getSessionInfo().busy).toBe(false);
    ui.quit("SIGTERM"); await ui.session; await test.app.close();
    expect(ui.terminal.stopped).toBe(true);
    expect(readSavedBoard(test.root)).toEqual(before);
  });

  it("stops active execution and waits for cancellation before restoring the terminal", async () => {
    const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const test = fixture({ async run(request) {
      request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      started.resolve(); await cancelled.promise; await release.promise;
      throw new Error("Synthetic execution cancelled");
    } });
    const running = test.app.runGoal("Cancel this active synthetic run"); await started.promise;
    const tui = launch(test.app);
    cleanup.push(async () => { release.resolve(); });
    tui.quit("command"); await cancelled.promise;
    expect(tui.terminal.stopped).toBe(false);
    expect(test.app.snapshot().status).toBe("stopped");
    release.resolve(); await running; await tui.session; await test.app.close();
    expect(tui.terminal.stopped).toBe(true);
    expect(readSavedBoard(test.root)).toMatchObject({ status: "stopped", outcome: null });
  });
});
