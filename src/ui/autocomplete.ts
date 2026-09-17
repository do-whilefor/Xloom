import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

export interface CommandDefinition {
  name: `/${string}`;
  description: string;
  argumentHint?: string;
}

/** Local UI commands only: no filesystem, provider, credential, or plugin discovery. */
export const COMMANDS = [
  { name: "/run", argumentHint: "<目标>", description: "启动独立的双 Agent 任务" },
  { name: "/model", argumentHint: "[角色]", description: "选择聊天或 Agent 使用的模型" },
  { name: "/apikey", argumentHint: "[供应商]", description: "在私密输入框中设置 API Key" },
  { name: "/login", argumentHint: "[供应商]", description: "选择账号登录或 API Key 接入" },
  { name: "/logout", argumentHint: "[供应商]", description: "移除供应商的本地凭据" },
  { name: "/new", description: "新建普通聊天，保留历史与任务黑板" },
  { name: "/history", description: "查看当前聊天的保存内容和路径" },
  { name: "/start", description: "开始或恢复当前任务" },
  { name: "/tasks", description: "列出当前工作区的历史研究任务" },
  { name: "/open", argumentHint: "<任务ID>", description: "选择历史任务，使用 /start 继续" },
  { name: "/paths", description: "查看聊天、任务和证据的数据位置" },
  { name: "/chrome", argumentHint: "[status|disconnect|connect]", description: "查看 Chrome 常驻连接，手动断开或允许重新连接" },
  { name: "/pause", description: "暂停当前运行" },
  { name: "/stop", description: "停止当前运行，保留黑板与证据" },
  { name: "/hint", argumentHint: "<信息>", description: "向任务黑板补充信息" },
  { name: "/meta", description: "请求 Decide 进行元认知复核" },
  { name: "/board", description: "查看当前任务黑板" },
  { name: "/help", description: "查看命令与快捷键" },
  { name: "/exit", description: "退出 xloom" },
] as const satisfies readonly CommandDefinition[];

const MODEL_ROLES = [
  { value: "/model all", label: "/model all", description: "同时设置所有角色" },
  { value: "/model chat", label: "/model chat", description: "设置普通聊天模型" },
  { value: "/model decide", label: "/model decide", description: "设置规划与复核模型" },
  { value: "/model execute", label: "/model execute", description: "设置步骤执行模型" },
] satisfies AutocompleteItem[];

function commandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
  if (lines.length !== 1 || cursorLine !== 0 || cursorCol < 1 || cursorCol > lines[0]!.length) return;
  const prefix = lines[0]!.slice(0, cursorCol);
  // Slash commands are anchored to the message start, never to paths or later lines.
  if (/^\/[a-z]*$/i.test(prefix) || /^\/model +[a-z]*$/i.test(prefix)) return prefix;
}

/** Use with Pi Editor. Its native Enter submits slash completions; the UI maps
 * Enter to Tab while the picker is visible so accepting a command never runs it. */
export function createCommandAutocomplete(): AutocompleteProvider {
  return {
    triggerCharacters: ["/"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const prefix = commandPrefix(lines, cursorLine, cursorCol);
      if (prefix === undefined) return null;
      const normalized = prefix.toLowerCase().replace(/ +/g, " ");
      const items = prefix.includes(" ")
        ? MODEL_ROLES.filter(item => item.value.startsWith(normalized)).map(item => ({ ...item }))
        : COMMANDS.filter(command => command.name.startsWith(normalized)).map((command: CommandDefinition) => ({
          value: command.name,
          label: command.name + (command.argumentHint ? ` ${command.argumentHint}` : ""),
          description: command.description,
        }));
      return items.length ? { items, prefix } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const unchanged = { lines: [...lines], cursorLine, cursorCol };
      if (commandPrefix(lines, cursorLine, cursorCol) !== prefix) return unchanged;
      const command: CommandDefinition | undefined = COMMANDS.find(command => command.name === item.value);
      if (!command && !MODEL_ROLES.some(role => role.value === item.value)) return unchanged;
      const line = lines[0]!;
      const tokenRemainder = line.slice(cursorCol).match(/^\S*/)?.[0] ?? "";
      const suffix = line.slice(cursorCol + tokenRemainder.length);
      const value = item.value + (command?.argumentHint && !/^\s/.test(suffix) ? " " : "");
      return { lines: [value + suffix], cursorLine: 0, cursorCol: value.length };
    },
    // Pi also uses this gate for forced Tab completion. Allow only our model-role
    // arguments; arbitrary paths and authentication arguments never trigger it.
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return commandPrefix(lines, cursorLine, cursorCol)?.startsWith("/model ") ?? false;
    },
  };
}
