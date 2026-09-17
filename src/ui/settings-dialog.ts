import chalk from "chalk";
import { CURSOR_MARKER, Input, matchesKey, SelectList, truncateToWidth,
  type Component, type Focusable, type OverlayHandle, type SelectItem, type TuiAltScreen } from "@earendil-works/pi-tui";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { Clipboard } from "./clipboard.js";
import { fitLines, plainText, type ModelRole, type SettingsCommand, type UiController } from "./model.js";

const coral = chalk.hex("#D98B73");
const listTheme = { selectedPrefix: coral, selectedText: coral, description: chalk.gray, scrollInfo: chalk.gray, noMatch: chalk.gray };
const cancelled = (): Error => Object.assign(new Error("设置已取消。"), { name: "AbortError" });

/** Private overlay state is never appended to the feed or main Editor history. */
export class SettingsPanel implements Component, Focusable {
  private input: Input;
  private list?: SelectList;
  private items: SelectItem[] = [];
  private secret = false;
  private allowEmpty = false;
  private inputEnabled = false;
  private pasteBuffer: string | undefined;
  private submit?: (value: string) => void;
  private notices: string[] = [];
  private question = "";
  private generation = 0;
  private pastePending = false;
  private copyStatus = "";
  onCancel?: () => void;
  onPaste?: () => void;
  onCopyLoginUrl?: () => void;
  constructor(readonly title: string, private readonly renderAgain: () => void) {
    this.input = this.createInput();
  }
  private createInput(): Input {
    const input = new Input();
    input.onSubmit = value => { if (this.inputEnabled && !this.pastePending && !this.list && (this.allowEmpty || value.trim())) this.submit?.(value.trim()); };
    input.onEscape = () => this.onCancel?.();
    return input;
  }
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  get version(): number { return this.generation; }
  invalidate(): void { this.input.invalidate(); this.list?.invalidate(); }
  setNotices(lines: string[]): void { this.notices = lines.map(plainText).slice(-8); this.renderAgain(); }
  setCopyStatus(message: string): void { this.copyStatus = message; this.renderAgain(); }
  setPrompt(question: string, options: { secret?: boolean; allowEmpty?: boolean; items?: SelectItem[] } | undefined, submit?: (value: string) => void): void {
    this.generation++;
    this.question = plainText(question);
    // Pi Input retains undo/kill-ring data after setValue; never carry it across prompts.
    const focused = this.input.focused;
    this.input = this.createInput();
    this.input.focused = focused;
    this.pasteBuffer = undefined;
    this.pastePending = false;
    this.secret = options?.secret ?? false;
    this.allowEmpty = options?.allowEmpty ?? false;
    this.items = (options?.items ?? []).map(item => ({ ...item, label: plainText(item.label), description: item.description ? plainText(item.description) : undefined }));
    this.submit = submit;
    this.inputEnabled = Boolean(submit);
    this.list = options?.items ? this.makeList(this.items) : undefined;
    this.renderAgain();
  }
  private makeList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 7, listTheme);
    list.onSelect = item => this.submit?.(item.value);
    list.onCancel = () => this.onCancel?.();
    return list;
  }
  private filter(): void {
    if (!this.list) return;
    const words = this.input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
    this.list = this.makeList(this.items.filter(item => words.every(word => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(word))));
  }
  beginPaste(): number { this.pastePending = true; return this.generation; }
  finishPaste(version: number): void { if (this.generation === version) this.pastePending = false; }
  paste(text: string, expectedVersion = this.generation): void {
    if (!this.inputEnabled || expectedVersion !== this.generation) return;
    const clean = plainText(text).replace(/\n/g, " ");
    if (Buffer.byteLength(clean, "utf8") > 64 * 1024) { this.setNotices(["粘贴内容超过 64 KiB，请重新输入。"]); return; }
    // Bracketed paste prevents pasted Enter/Esc bytes becoming dialog actions.
    this.input.handleInput(`\x1b[200~${clean}\x1b[201~`);
    this.filter();
    this.renderAgain();
  }
  handleInput(data: string): void {
    if (this.pasteBuffer !== undefined || data.startsWith("\x1b[200~")) {
      this.pasteBuffer = (this.pasteBuffer ?? "") + (this.pasteBuffer === undefined ? data.slice(6) : data);
      const end = this.pasteBuffer.lastIndexOf("\x1b[201~");
      if (end !== -1) {
        const text = this.pasteBuffer.slice(0, end) + this.pasteBuffer.slice(end + 6);
        this.pasteBuffer = undefined;
        this.paste(text);
      } else if (this.pasteBuffer.length > 64 * 1024) this.pasteBuffer = this.pasteBuffer.slice(0, 64 * 1024 + 1) + this.pasteBuffer.slice(-5);
      return;
    }
    if (matchesKey(data, "escape")) { this.onCancel?.(); return; }
    if (matchesKey(data, "ctrl+c")) {
      if (this.input.getValue()) { this.generation++; this.pastePending = false; this.input.setValue(""); this.filter(); this.renderAgain(); }
      else this.onCancel?.();
      return;
    }
    if (matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+shift+v") || matchesKey(data, "shift+insert")) { this.onPaste?.(); return; }
    if (matchesKey(data, "ctrl+l")) { this.onCopyLoginUrl?.(); return; }
    // Never copy secret inputs or feed a kill-ring copy shortcut back to the main Editor.
    if (matchesKey(data, "ctrl+shift+c") || matchesKey(data, "ctrl+insert")) return;
    if (!this.inputEnabled) return;
    if (this.pastePending && matchesKey(data, "enter")) return;
    if (this.list && (["up", "down", "ctrl+p", "ctrl+n", "enter"] as const).some(key => matchesKey(data, key))) this.list.handleInput(data);
    else { this.input.handleInput(data); this.filter(); }
    this.renderAgain();
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines = [coral(this.title), ...this.notices.flatMap(line => fitLines(line, inner)), "", ...fitLines(this.question, inner)];
    if (this.inputEnabled) {
      if (this.secret) {
        const count = Math.min([...this.input.getValue()].length, Math.max(0, inner - 2));
        lines.push(`> ${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""}`);
      } else lines.push(...this.input.render(inner));
    }
    if (this.list) lines.push(...this.list.render(inner));
    if (this.onCopyLoginUrl) lines.push(...fitLines("本界面不自动打开浏览器；Ctrl+L 复制原始登录地址。", inner));
    if (this.copyStatus) lines.push(...fitLines(this.copyStatus, inner));
    lines.push("", chalk.gray(this.list ? "输入搜索 · ↑/↓ 选择 · Enter 确认 · Esc 取消"
      : `${this.secret ? "私密输入" : "当前设置"} · Enter 确认${this.allowEmpty ? "（可留空）" : ""} · Esc 取消`));
    return lines.map(line => truncateToWidth(`  ${line}`, Math.max(0, width), ""));
  }
  clear(): void { this.setPrompt("", undefined); this.notices = []; this.copyStatus = ""; this.onCopyLoginUrl = undefined; }
}

/** Reuses Pi's provider/model catalog and AuthInteraction, without browser-launch hooks. */
export class SettingsDialogs {
  private abort?: AbortController;
  private panel?: SettingsPanel;
  private overlay?: OverlayHandle;
  private readonly clipboardTasks = new Set<Promise<unknown>>();
  private clipboardPending?: Promise<unknown>;
  private authUrl?: string;
  constructor(private readonly controller: UiController, private readonly tui: TuiAltScreen, private readonly clipboard: Clipboard,
    private readonly print: (label: string, text: string, error?: boolean) => void) {}
  get isOpen(): boolean { return Boolean(this.panel); }
  cancel(): void { this.abort?.abort(); }
  paste(): void {
    const panel = this.panel;
    if (!panel || this.clipboardPending) return;
    const version = panel.beginPaste();
    const task = Promise.resolve().then(() => this.clipboard.readText()).then(text => {
      if (this.panel === panel && !this.abort?.signal.aborted) panel.paste(text, version);
    }).catch(() => { if (this.panel === panel) panel.setNotices(["无法读取剪贴板，请尝试终端括号粘贴。"]); }).finally(() => { panel.finishPaste(version); this.clipboardPending = undefined; });
    this.clipboardPending = task;
    this.clipboardTasks.add(task);
    void task.finally(() => this.clipboardTasks.delete(task));
  }
  async waitForIdle(): Promise<void> { await Promise.allSettled([...this.clipboardTasks]); }
  private copyAuthUrl(): void {
    const panel = this.panel;
    const url = this.authUrl;
    if (!panel || !url) return;
    const task = Promise.resolve().then(() => this.clipboard.writeText(url)).catch(() => false).then(ok => {
      if (this.panel === panel) panel.setCopyStatus(ok ? "登录地址已复制，请粘贴到浏览器。" : "复制失败，请检查系统剪贴板后重试。");
    });
    this.clipboardTasks.add(task);
    void task.finally(() => this.clipboardTasks.delete(task));
  }
  private ask(message: string, options: { secret?: boolean; allowEmpty?: boolean; items?: SelectItem[] }, promptSignal?: AbortSignal): Promise<string> {
    const signal = this.abort!.signal;
    const panel = this.panel!;
    if (signal.aborted || promptSignal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener("abort", onAbort); promptSignal?.removeEventListener("abort", onAbort); panel.setPrompt("等待提供方响应…", undefined); };
      const onAbort = (): void => { cleanup(); reject(cancelled()); };
      signal.addEventListener("abort", onAbort, { once: true });
      promptSignal?.addEventListener("abort", onAbort, { once: true });
      panel.setPrompt(message, options, value => { cleanup(); resolve(value); });
    });
  }
  private notify(event: AuthEvent): void {
    const candidate = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : event.type === "info" ? event.links?.[0]?.url : undefined;
    if (candidate !== undefined && this.panel) {
      this.authUrl = undefined;
      try {
        const parsed = new URL(candidate);
        if (["http:", "https:"].includes(parsed.protocol) && !/[\u0000-\u0020\u007f-\u009f]/.test(candidate)) this.authUrl = candidate;
      } catch { /* Invalid or non-web links are displayed as text but never copied by this shortcut. */ }
      this.panel.onCopyLoginUrl = this.authUrl ? () => this.copyAuthUrl() : undefined;
      this.panel.setCopyStatus("");
    }
    const lines = event.type === "auth_url" ? [event.instructions ?? "请在浏览器中完成登录：", event.url]
      : event.type === "device_code" ? ["请访问下方地址并输入设备码：", event.verificationUri, event.userCode]
      : event.type === "info" ? [event.message, ...(event.links ?? []).map(link => `${link.label ?? "登录链接"}: ${link.url}`)]
      : [event.message];
    this.panel?.setNotices(lines);
  }
  async open(command: SettingsCommand, argument: string): Promise<void> {
    if (this.panel) throw new Error("请先完成或取消当前设置。");
    if (this.controller.getSessionInfo?.().busy) throw new Error("模型正在运行，请先 /pause 再修改设置。");
    this.abort = new AbortController();
    this.panel = new SettingsPanel(command === "model" ? "选择模型" : command === "apikey" ? "API Key" : command === "login" ? "订阅登录" : "移除本地凭据", () => this.tui.requestRender());
    this.panel.onCancel = () => this.cancel();
    this.panel.onPaste = () => this.paste();
    this.panel.setPrompt("正在读取 Xloom 配置…", undefined);
    this.overlay = this.tui.showOverlay(this.panel, { width: "85%", maxHeight: "90%", anchor: "center", margin: 1 });
    try {
      if (command === "model") {
        if (!this.controller.getModels || !this.controller.selectModel) throw new Error("unsupported");
        const models = await this.controller.getModels();
        if (this.abort.signal.aborted) throw cancelled();
        const items = models.map(model => ({ value: `${model.provider}/${model.model}`, label: `${model.provider}/${model.model}`, description: model.name }));
        if (!items.length) { this.print("xloom", "没有已接入的模型。请先使用 /apikey 配置供应商，再使用 /model 选择模型。", true); return; }
        const selected = await this.ask(`选择 ${argument || "all"} 模型（仅已接入供应商；输入名称搜索）`, { items });
        if (this.abort.signal.aborted) throw cancelled();
        const model = models[items.findIndex(item => item.value === selected)]!;
        await this.controller.selectModel(model.provider, model.model, (argument || "all") as ModelRole, this.abort.signal);
        this.print("xloom", `模型已更新：${argument || "all"} → ${model.provider}/${model.model}`);
      } else {
        if (!this.controller.getProviders) throw new Error("unsupported");
        const providers = await this.controller.getProviders();
        if (this.abort.signal.aborted) throw cancelled();
        const eligible = command === "login" ? providers.filter(provider => provider.authTypes.includes("oauth"))
          : command === "apikey" ? providers.filter(provider => provider.authTypes.includes("api_key")) : providers;
        if (!eligible.length) { this.print("xloom", "没有支持此认证方式的提供方。", true); return; }
        let provider = argument;
        if (!provider) provider = await this.ask("选择提供方（输入名称搜索）", { items: eligible.map(item => ({ value: item.id, label: item.name, description: item.id })) });
        if (!eligible.some(item => item.id === provider)) { this.print("xloom", "提供方不存在或不支持此认证方式；请不带参数打开选择器。", true); return; }
        if (command === "apikey") {
          if (!this.controller.saveApiKey) throw new Error("unsupported");
          const key = await this.ask(`${provider} API Key（输入将遮蔽，不进入会话和历史）`, { secret: true });
          if (this.abort.signal.aborted) throw cancelled();
          await this.controller.saveApiKey(provider, key, this.abort.signal);
          this.print("xloom", `${provider} 的 API Key 已保存。使用 /model 选择该供应商的模型；凭据不自动通用于其他供应商。`);
        } else if (command === "logout") {
          if (!this.controller.logout) throw new Error("unsupported");
          await this.ask(`确认移除 ${provider} 的本地凭据？环境变量中的凭据不受影响。`, { items: [{ value: "yes", label: "确认移除本地凭据" }] });
          if (this.abort.signal.aborted) throw cancelled();
          await this.controller.logout(provider, this.abort.signal);
          this.print("xloom", "已移除该提供方的本地凭据；环境变量中的凭据不受影响。");
        } else {
          if (!this.controller.login) throw new Error("unsupported");
          const interaction: AuthInteraction = {
            signal: this.abort.signal,
            notify: event => { if (!this.abort?.signal.aborted) this.notify(event); },
            prompt: (prompt: AuthPrompt) => this.ask(prompt.message, prompt.type === "select"
              ? { items: prompt.options.map(item => ({ value: item.id, label: item.label, description: item.description })) }
              : prompt.type === "text" ? { allowEmpty: true } : { secret: true }, prompt.signal),
          };
          await this.controller.login(provider, interaction);
          if (!this.abort.signal.aborted) this.print("xloom", "认证成功；凭据已保存到本地 Xloom 凭据存储。");
        }
      }
    } catch {
      this.print("xloom", this.abort.signal.aborted ? "设置已取消。" : "设置失败。请检查提供方、网络和本地凭据存储后重试。", !this.abort.signal.aborted);
    } finally {
      this.panel.clear();
      this.overlay?.hide();
      this.panel = undefined;
      this.overlay = undefined;
      this.abort = undefined;
      this.authUrl = undefined;
      this.tui.requestRender();
    }
  }
}
