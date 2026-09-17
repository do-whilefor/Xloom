import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, getKeybindings, KeybindingsManager, setKeybindings, TuiAltScreen, TUI_KEYBINDINGS, type Terminal } from "@earendil-works/pi-tui";
import { COMMANDS, createCommandAutocomplete } from "../src/ui/autocomplete.js";

const signal = (): AbortSignal => new AbortController().signal;
const provider = createCommandAutocomplete();
const query = (text: string, cursor = text.length) => provider.getSuggestions([text], 0, cursor, { signal: signal() });

class MemoryTerminal implements Terminal {
  columns = 90;
  rows = 30;
  kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function editorFixture() {
  const plain = (text: string) => text;
  const tui = new TuiAltScreen(new MemoryTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const editor = new Editor(tui, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  });
  editor.setAutocompleteProvider(createCommandAutocomplete());
  editor.render(90);
  const submit = vi.fn();
  editor.onSubmit = submit;
  return { editor, submit };
}

async function type(editor: Editor, text: string): Promise<void> {
  for (const char of text) editor.handleInput(char);
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true), { interval: 1 });
}

const bindings = getKeybindings();
afterEach(() => { setKeybindings(bindings); vi.restoreAllMocks(); });

describe("command-only autocomplete", () => {
  it("lists the local slash catalog with Chinese descriptions", async () => {
    const suggestions = await query("/");
    expect(suggestions?.prefix).toBe("/");
    expect(suggestions?.items.map(item => item.value)).toEqual(COMMANDS.map(command => command.name));
    expect(suggestions?.items.every(item => /[\u4e00-\u9fff]/.test(item.description!))).toBe(true);
    expect(suggestions?.items.find(item => item.value === "/run")?.label).toBe("/run <目标>");
  });

  it("filters command prefixes without fuzzy matches", async () => {
    expect((await query("/mo"))?.items.map(item => item.value)).toEqual(["/model"]);
    expect((await query("/EX"))?.items.map(item => item.value)).toEqual(["/exit"]);
    expect(await query("/unknown")).toBeNull();
  });

  it.each(["/details", "/quit"])("does not suggest or accept removed command %s", async command => {
    expect(await query(command)).toBeNull();
    expect((await query("/"))?.items.some(item => item.value === command)).toBe(false);
    expect(provider.applyCompletion(["/"], 0, 1, { value: command, label: command }, "/").lines).toEqual(["/"]);
  });

  it("completes required and optional arguments with a space, but not no-argument commands", async () => {
    for (const name of ["/run", "/hint", "/model", "/apikey", "/login", "/logout", "/chrome", "/help", "/exit"]) {
      const suggestions = (await query(name))!;
      const result = provider.applyCompletion([name], 0, name.length, suggestions.items[0]!, name);
      const hasArgument = ["/run", "/hint", "/model", "/apikey", "/login", "/logout", "/chrome"].includes(name);
      expect(result.lines).toEqual([name + (hasArgument ? " " : "")]);
      expect(result.cursorCol).toBe(result.lines[0]!.length);
    }
  });

  it("preserves arguments while completing within a command token", async () => {
    const lines = ["/run  existing target"];
    const result = provider.applyCompletion(lines, 0, 3, (await query("/ru"))!.items[0]!, "/ru");
    expect(result.lines).toEqual(["/run  existing target"]);
    expect(lines).toEqual(["/run  existing target"]);
    expect(result.cursorCol).toBe(4);
  });

  it("suggests only static model roles, without reading provider or credential data", async () => {
    expect((await query("/model "))?.items.map(item => item.value)).toEqual([
      "/model all", "/model chat", "/model decide", "/model execute",
    ]);
    const suggestions = (await query("/model d"))!;
    expect(suggestions.items.map(item => item.value)).toEqual(["/model decide"]);
    expect(provider.applyCompletion(["/model d"], 0, 8, suggestions.items[0]!, suggestions.prefix).lines).toEqual(["/model decide"]);
  });

  it.each(["hello /", " /", "C:\\Users\\Acer", "./src/", "/src/", "@src", "/run some goal", "/hint /model", "/apikey provider secret", "/login provider", "/logout provider"])(
    "does not activate for text, paths, task arguments, or credentials: %s", async text => {
      expect(await query(text)).toBeNull();
      expect(provider.shouldTriggerFileCompletion?.([text], 0, text.length)).toBe(false);
      expect(await provider.getSuggestions([text], 0, text.length, { signal: signal(), force: true })).toBeNull();
    },
  );

  it("never completes any multiline message", async () => {
    expect(await provider.getSuggestions(["/", "second line"], 0, 1, { signal: signal() })).toBeNull();
    expect(await provider.getSuggestions(["hello", "/"], 1, 1, { signal: signal() })).toBeNull();
  });

  it("ignores aborted queries, stale prefixes and unknown completion items", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await provider.getSuggestions(["/"], 0, 1, { signal: abort.signal })).toBeNull();
    const item = { value: "/run", label: "/run" };
    expect(provider.applyCompletion(["/help"], 0, 5, item, "/ru").lines).toEqual(["/help"]);
    expect(provider.applyCompletion(["/"], 0, 1, { value: "unknown", label: "unknown" }, "/").lines).toEqual(["/"]);
  });
});

describe("real Pi Editor command picker", () => {
  it("opens on slash, filters, and accepts Tab without submitting", async () => {
    const { editor, submit } = editorFixture();
    await type(editor, "/");
    expect(editor.render(90).join("\n")).toContain("启动独立的双 Agent 任务");
    await type(editor, "ru");
    await vi.waitFor(() => expect(editor.render(90).join("\n")).not.toContain("/model"), { interval: 1 });
    editor.handleInput("\t");
    expect(editor.getText()).toBe("/run ");
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("documents native slash Enter submission so the TUI must map it to Tab", async () => {
    const { editor, submit } = editorFixture();
    await type(editor, "/help");
    editor.handleInput("\r");
    expect(submit).toHaveBeenCalledWith("/help");
  });

  it("closes the picker with Esc while preserving the draft", async () => {
    const { editor, submit } = editorFixture();
    await type(editor, "/ru");
    editor.handleInput("\x1b");
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(editor.getText()).toBe("/ru");
    expect(submit).not.toHaveBeenCalled();
  });

  it("gives candidate navigation precedence over up/down history", async () => {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.historyPrevious": ["up", "ctrl+p"],
      "tui.editor.historyNext": ["down", "ctrl+n"],
      "tui.editor.cursorUp": "alt+up", "tui.editor.cursorDown": "alt+down",
    }));
    const { editor, submit } = editorFixture();
    editor.addToHistory("previous input");
    await type(editor, "/");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("/model ");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not treat pasted multiline content or regular text as slash commands", async () => {
    const { editor, submit } = editorFixture();
    editor.handleInput("\x1b[200~/help\nsecond line\x1b[201~");
    editor.handleInput("\t");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(editor.getExpandedText()).toBe("/help\nsecond line");
    editor.setText("say ");
    editor.handleInput("/");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
