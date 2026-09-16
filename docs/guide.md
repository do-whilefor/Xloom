# xloom

基于 Pi 的 Windows 双 Agent 安全研究 Loop，当前为 **0.1 MVP**。

默认以普通聊天打开，模型可以使用五工具。输入 `/run 目标` 切换到双 Agent 红队任务：两个角色不共享聊天历史，只通过结构化黑板协作。Decide 负责计划、读取证据与审查，通过 `read` 读取资料、`submit` 提交提案；Execute 使用五工具（含复用当前登录会话的 `chrome`） 深入调查当前步骤，并可先提交关键观察再继续或交回规划。元认知是 Decide 的一次全新上下文调用，不是第三个 Agent。普通聊天不是第三个红队角色，聊天历史不会注入任务。

## 快速开始

需要 Windows、Node.js 24+、PowerShell 7（`pwsh.exe` 在 PATH 中）。推荐 Windows Terminal。模型服务凭据由用户提供。

```powershell
Set-Location 'D:\Users\Acer\Desktop\SRC\xloom'
npm ci --ignore-scripts
npm run check

# 不连接模型、不访问外部目标的合成闭环演示
npm start -- demo --headless

# 打开普通聊天 TUI；首次自动生成不含凭据的 xloom.json
npm start -- run
# 在 TUI 中使用 /model 选择模型、/apikey 设置 Key；也可复用 Pi 已保存的认证
# 普通文字聊天；/run 加实际目标启动双 Agent；/hint 补充任务信息
```

打开 TUI 不会自动请求模型。`xloom.example.json` 提供配置样例；显式 `init --goal "目标"` 仍支持旧的预配置任务工作流，且不会覆盖已有文件。运行时不会自动加载项目或用户目录中的 AGENTS.md、Skills、MCP、扩展或 Pi CLI 会话。

构建后也可使用 `node dist/cli.js`，或 `npm link` 后使用 `xloom`。

## 本版功能

- Chat 和 Execute 的 `chrome` 工具按需连接当前 Chrome 登录会话，发现和调用浏览器能力、保存原始证据与截图；详见 [Chrome 接入](chrome.md)。

- Pi `0.84.4` 的真实 Agent 内核与工具工厂；普通聊天及 Execute 使用 `read / write / edit / powershell / chrome`，Decide / 元认知使用 `read` 和只提交结构化提案的 `submit`，Execute 也有 `submit`。研究角色的纯读取批次最多四路并发，包含其他操作的批次顺序执行；PowerShell 对传入命令做语法预检，通过后交给 Pi 原样执行。`read` 的文件与图片读取沿用 Pi，目录读取返回真实的直接条目（不递归），最多 200 条/16 KiB，可用原 `offset` / `limit` 分页。不存在的路径仍报告失败，并在可查询时给出最近存在的父目录，不猜测或替换文件名。`edit` 保留 Pi 的匹配规则；旧文本不匹配或不唯一时提示重读当前文件后再编辑。
- 普通聊天保留当前进程内的独立会话，使用相同的私有上下文压缩和一次瞬断续接策略；`/new`、切换模型或凭据会清空会话。聊天不写入黑板，上下文保存为私有归档；每次启动新会话，不恢复旧消息、摘要或用量。
- 本地 Controller 串行调度；每次 Decide、每个 Execute Step、每次元认知都重新创建 Pi Agent，消息数组从空开始。
- 同一次研究调用接近模型上下文窗口时压缩较早的完整交互，保留初始任务、近期工具结果和私有工作摘要；摘要不成为证据。可识别的模型瞬断在当前 run 内续接一次，最终 JSON 无效或规划实体引用不合法时尝试一次无工具纠正，仍受取消、超时及显式预算约束。
- FGS 黑板：Fact / Goal / Step，附带 Finding / Evidence / Hint。控制器验证提案后统一提交，Agent 不直接写权威黑板。
- Goal 声明按 ID、描述、父目标精确去重：三者一致时复用原记录，保留状态和事实关联，不额外请求模型。不同定义占用同一 ID、无效父目标等错误会与其他引用错误一起交给一次无工具纠正；冲突批次不会部分入库，已关闭目标不会因重复声明而重新激活。
- 按角色投影黑板：提供全部 Fact 的简短索引，按所选依赖补齐 `Fact → 来源 Step → 前置 Facts` 因果链和修正链。旧事实被修正后，依赖它的待办先回到规划复核；共享的是任务事实与证据。
- Execute 通过原有 `write` 工具向指定 `artifacts/checkpoint.json` 提交阶段结果。事实、证据和累计用量原子入库，可继续调查，也可主动交回 fresh Decide；后续失败保留已提交成果。
- SQLite WAL 持久化、追加审计事件、步骤 claim、单控制器锁、暂停/停止/恢复。中断步骤标记失败，不会盲目重放。
- 新技术命中/命中证据更新、事实修正、每 3 个步骤、停滞、执行受阻、完成前或 `/meta` 触发元认知；完成必须来自一次 fresh Decide review，确认根 Goal 已满足并引用证据事实。步数只计数，不设任务上限。
- 技术命中保持 `unrated`；只有证据关联、影响字段、PoC 和 Decide 审查符合规则后才允许 `impact_verified` 与评级。
- 证据归档、SHA-256 校验、引用完整性检查、组合前提和带条件的尝试记录。同一假设、范围、身份、环境版本、基线、改变变量与结论的重复记录不计进展，时间戳变化的原始证据仍保留。
- Claude 风格的暖珊瑚色极简会话：用户 `❯`、自然语言进展、`Thought for …, read …, ran …` 活动汇总，以及包含耗时和 token 的尾行。已完成工具默认折叠，运行中显示命令和耗时，失败直接可见；双 Agent 交接只占一行。

## TUI / CLI

| 输入 | 行为 |
| --- | --- |
| 普通文字 | 普通聊天，可调用五工具；即使有已暂停任务，也不会自动作为 Hint |
| `/chrome [status|disconnect|connect]` | 查看常驻 Chrome 连接、手动断开或允许下次工具调用重连 |
| `/run 目标` | 新建独立双 Agent 任务并开始执行；旧任务与证据保留，不带入聊天历史 |
| `/start` | 继续本次会话已选任务；未选择时为 `init` 的显式目标新建任务 |
| `/hint 文字` | 显式写入当前任务黑板；下一个规划边界读取 |
| `/new` | 新建普通聊天，保留旧聊天文件、任务与证据 |
| `/history` | 只查看本次聊天的保存内容和文件路径，启动时为空 |
| `/tasks` | 列出当前工作区的历史研究任务 |
| `/open 任务ID` | 选择历史任务，随后用 `/start` 继续 |
| `/paths` | 显示当前数据与任务位置 |
| `/model [all\|chat\|decide\|execute]` | 搜索选择 Pi 模型；默认应用全部角色，可分别选择 |
| `/apikey [provider]` | 打开遮蔽输入框，把 Key 保存到 Pi 凭据文件；不接受行内 Key |
| `/meta` | 在安全的运行边界调用 Decide 元认知；空闲时启动 |
| `/pause`、Esc | 取消当前调用并暂停，保留状态；候选打开时 Esc 先关闭候选，设置弹窗中则取消设置 |
| `/stop` | 停止，保留状态和证据 |
| `/board` | 查看简洁 FGS / Finding 视图 |
| Ctrl+O | 展开 / 收起工具输入输出、思考、交接原因、费用说明及原始协议；详情有长度限制，不影响原始运行日志 |
| 点击活动汇总、Ctrl+T | 展开或收起该组思考和工具详情；也可点击展开的正文收起，拖选仍复制；Ctrl+T 切换最近一组，不修改模型思考配置 |
| `/help` | 查看命令与快捷键帮助 |
| `/exit` | 退出 TUI；取消当前运行并等待清理，保留状态和证据 |
| `/` | 输入框开头显示命令候选，继续输入按前缀筛选；↑/↓ 选择，Tab / Enter 补全，再按 Enter 执行；不会仅因选中而调用模型或退出 |
| ↑ / ↓、Ctrl+P / Ctrl+N | 无候选时切换上一条 / 下一条已提交输入（当前 TUI 会话最多 100 条），返回最新时恢复未提交草稿 |
| Alt+↑ / Alt+↓ | 在多行输入内移动光标 |
| Alt+Enter / Shift+Enter | 插入换行；Enter 提交 |
| 拖动选择文字 | 松开鼠标后复制到系统剪贴板 |
| Ctrl+C | 输入框有内容（含空格、多行）时清空，不计为退出的第一次；空输入框 2 秒内连续按两次退出。第一次只提示，不暂停任务；期间输入内容会取消退出确认 |
| Ctrl+Shift+C / Ctrl+Insert | 复制选中文字；无选择时复制当前输入框内容 |
| Ctrl+V / Shift+Insert / 右键 | 将系统剪贴板文字粘贴到输入框；支持中文及多行，不会自动提交 |
| 滚轮 / PageUp / PageDown | 滚动会话区；上翻后新输出不会强制拉回底部 |
| End | 回到会话底部，恢复自动跟随新输出 |

界面只保留三行头部、会话区、输入框和状态栏；头部与正文之间留一行空白，终端高度不足时先移除空白，再压缩头部以保留输入，不常驻显示功能介绍或底部快捷帮助。需要时手动输入 `/help`。剪贴板只在用户触发复制/粘贴时访问，不传给 Agent；Windows 剪贴板操作在隐藏的 PowerShell 子进程中异步、按顺序完成。终端若拦截 Ctrl+Shift+C/V 或 Shift+Insert，则由终端处理原生复制粘贴；建议使用 Windows Terminal。旧控制台若抢占鼠标选择或右键，仍可使用键盘快捷键及 PageUp/PageDown。

普通聊天继续流式显示自然语言；双 Agent 可在工具调用前给出简短进展，原始结果协议默认收起，只有控制器成功提交黑板后的摘要才显示为结果，工具成功不等于目标完成。工具错误仍直接可见；状态栏和耗时尾行保留 token、不显示费用。未知定价说明仅在详情中保留一次，配置的费用预算继续生效。`/` 列表只提供应用已有命令，不新增工具、MCP 或 Skills。候选中的 `/model` 也支持补全角色。

```text
 ▀█▄ ▄█▀   Xloom v0.1.0
   ███     deepseek-flash[1M] · API Key
 ▄█▀ ▀█▄   D:\Users\Acer\Desktop\SRC\xloom

Python 可用。现在跑测试并核对文档。
  ▸ Thought for 3s, read 1 file, ran 1 shell command
测试完成，继续检查构建结果。
  ▸ Thought for 2s, running 1 shell command
  ● PowerShell · 1m56s npm run build
  ✻ Working… 2m5s · 11,543 tokens
```

以上是界面结构示例。头部版本来自 package.json，模型随当前 Chat / Decide / Execute 角色变化，容量来自配置或 Pi 本地目录；未知容量不显示。认证显示 API Key / OAuth / Subscription 等已知状态，不把 API Key 等同于按量收费。工作目录取当前项目的真实路径。实际正文来自模型，统计来自工具事件。没有模型思考内容时只汇总工具活动，不编造 `Thought for`。点击汇总或用 Ctrl+O 查看输入输出，点击展开的内容可收起。

思考只来自 Pi 转发的模型实际 `thinking` 内容，不解析正文中的伪思考标签，不展示签名或提供方已隐藏的内容，也不生成额外“解释思考”请求。`thinking: off` 或模型未返回思考时只显示 `Working…` 和最终回答；本次界面改动不会自动开启思考。`Thought for` 计量客户端观察到的思考流时间，不等同于服务端纯推理耗时；仅在最终消息才收到的思考显示 `Thought`，不虚构秒数。总 `Worked for` 包含本地等待、模型请求和工具执行时间；取消、超时和错误分别保留实际终态，不显示 done。活动摘要和展开正文保持普通文本样式，不带超链接虚线下划线。点击命中仍由 Pi 在内部处理，发送到终端时移除内部链接标记；不打开浏览器，拖动仍可复制。

每次启动都进入空聊天，不加载已保存任务的内容或停止/暂停原因；须先 `/open 任务ID`，再用 `/board` 查看或 `/start` 继续旧任务。模型服务错误与本地回复时间限制会显示不同的错误说明。研究调用可对已识别的瞬断续接一次已完成的工具结果，不自动重放已执行工具；无法确认工具是否完成时停止续接。

工具失败摘要优先展示实际退出状态和尾部异常；长失败输出保留头尾并标记中间省略。前面出现 HTTP 200 或其他正常输出，不代表整条脚本成功；失败标签取自工具实际返回状态。语法检查通过后仍可能发生运行时错误，例如循环输出应通过 `& { foreach (...) { ... } } 2>&1 | Out-File ...` 捕获，不能把 `2>&1` 作为独立命令。

模型选择和 API Key 设置在临时弹窗中完成，Key 不进入聊天 Feed 或输入历史。Esc 取消设置；取消不能撤销已经保存的凭据。OAuth 认证可复用 Pi 已保存的登录，Xloom 不再提供登录／登出命令。模型或任务运行期间先 `/pause` 并等待取消完成，再改模式、模型或凭据；不并发运行聊天与红队任务。

应用收到 Ctrl+V 后会直接插入剪贴板文本，不将换行解释为 Enter。终端自己的粘贴功能则需要支持并透传 bracketed paste（括号粘贴）协议；缺少该协议的旧控制台/PTY 通道可能把换行转成回车提交。此时应使用应用的 Ctrl+V，或换用支持该协议的终端。自动测试使用模拟剪贴板，不会读取或覆盖用户当前的系统剪贴板。

Ctrl+C 不再用于复制或暂停。复制仍可拖选，或使用 Ctrl+Shift+C / Ctrl+Insert；暂停用 Esc 或 `/pause`。清空输入不会提交内容、修改黑板或中断运行，尚未完成的旧粘贴也不会重新填回被清空的输入框。

底部显示当前 `chat` / `run` 模式、模型和状态。聊天显示独立聊天用量；红队模式的 `r0` 是黑板 revision（版本号）0，每次保存状态、Hint 或执行结果等都会递增，不是 Agent 轮数。`step 0` 表示已结算 0 个 Execute 步骤，没有 `/24` 上限。步骤计数包含已返回并提交结果的无进展/受阻步骤，不等于成功次数、模型调用次数或漏洞数。token 在每个模型消息结束后更新，包含输入、缓存读取/写入和输出；黑板提交后不重复累计。窄终端优先保留 token。

```powershell
npm start -- run --headless
npm start -- status
npm start -- report
npm start -- models
npm start -- models --provider anthropic
npm start -- run --workspace "D:\Work\my-research"
```

`status` / `report` 只读磁盘指针记录的最近任务，不调用模型、不启动 Loop。报告输出到标准输出。`--headless` 每次为配置中的目标新建独立任务并立即执行，不自动恢复旧任务；没有实际 Goal 的聊天配置不能用它启动研究。非交互环境不会隐式启动 TUI 或模型。

## 模型选择与 Goal 完成

`models.chat`、`models.decide`、`models.execute` 可以配置不同模型；旧配置没有 chat 时回退到 execute，元认知始终复用 decide。模型目录、供应商适配和认证直接使用当前依赖 Pi `0.84.4` 的 `ModelRuntime`，不维护 xloom 模型白名单。`npm start -- models` 列出 Pi 本地内置、缓存及自定义目录，不调用模型；TUI `/model` 也会保留当前配置的内联模型别名。默认模型不代表账户已获调用权限。

普通聊天提示附上当前配置的原始模型 ID 和供应商；询问模型时要求直接回答该 ID，不改名或映射到推测型号，也不硬编码本地问答。配置为 `deepseek-flash` 时提供的身份就是 `deepseek-flash`；这不能证明供应商别名背后的具体权重版本。固定聊天提示为 215 字符，另加这一行动态身份信息；字符数不等于 token，实际请求还包含五工具定义、历史消息和本轮输入，统计也包含模型输出。

复用 Pi 用户目录（默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定）的 `auth.json`、`models.json` 和模型缓存，支持 Pi 的环境认证、API Key 与 OAuth 登录/刷新。TUI `/apikey` 使用 Pi 的持久凭据接口，只修改选中供应商的凭据，不把密钥写进 xloom.json。此文件与 Pi 共用，不是操作系统密钥库。配置不指定 `apiKeyEnv` 时由 Pi 选择认证；显式指定时该变量必须存在。成功设置同供应商凭据后会清除对应角色的显式环境变量覆盖，让新凭据生效。`doctor` 不发起模型推理请求，但 Pi 的凭据刷新或按需动态目录发现可能需要网络，遵守 `PI_OFFLINE`。

OpenCode Go 使用会话路由请求头 `x-opencode-session`。xloom 仅在 `opencode-go` 的官方 HTTPS `/zen/go` 端点合并此请求头，值复用 Pi 当前会话 ID，不修改 Pi 内层。目录与服务端可能存在版本差：例如 `deepseek-flash` 是线上可用别名，可按用户端点配置 `api: anthropic-messages`、`baseUrl: https://opencode.ai/zen/go`；是否可用仍以真实请求与账户权限为准，不把它自动替换成另一个型号。

在 Pi `models.json` 中已配置的模型，仅填 provider / model 即可。也保留以下单角色端点覆盖写法：

接入兼容端点时，在相应模型配置中设置：

```json
{
  "provider": "my-endpoint",
  "model": "your-model-id",
  "api": "openai-completions",
  "baseUrl": "https://your-endpoint.example/v1",
  "apiKeyEnv": "XLOOM_MODEL_KEY",
  "thinking": "off"
}
```

`api` 由 Pi 的供应商/API 注册机制处理，不再限制为三种协议；自定义模型的细节、headers 和认证优先按 Pi `models.json` 配置。xloom 配置不接受明文 Key。实际支持范围与所依赖的 Pi 版本、账户、模型工具调用能力及端点实现有关；未知 API 仍由 Pi 报错。需要自定义 JavaScript 扩展才能注册的供应商不会自动加载，因为本项目不启用 Pi 扩展系统。

任务正常结束由 LLM 判断根 Goal 是否完成：Decide 读取黑板 → Execute 有界执行 → 持续规划；完成提议必须经过全新 Decide 元认知复核，使用 `updateGoals` 将根 Goal 标记 `satisfied` 并引用证据事实，同时提交最终结论。根 Goal 不能用 `abandoned` 代替完成，必须处理子目标及待执行步骤；发现单个漏洞不自动代表整个 Goal 完成。控制器只校验结构、引用及证据完整性，完成语义仍由 LLM 审查。

`maxNoProgress: 3` 是元认知触发阈值，不再强制暂停；有新执行计划就继续。LLM 无法给出可执行步骤或有效结论时，保留未完成状态并暂停；确实缺少必要输入时为 `NEED_INPUT`，补充后可恢复。没有隐藏的 24 步停机点。

计划文件尚未生成不等于缺少用户输入。`NEED_INPUT` 必须有未解决的 lead / technical_hit，且 `next` 记录具体外部缺失条件；不满足该条件的等待提议会被忽略，计划按正常校验提交后继续调度，无可执行计划时经过复核进入操作暂停。真实缺失条件仍需要模型判断，程序不把一般无进展认定为缺输入。只有 Execute 提示包含本次可写的 `artifacts` 目录；Decide / 复核从黑板中的真实证据路径读取，不能把计划中的文件名当成已有产物。

Execute 的现有 `read` 支持本次产物短路径：`{"path":"artifact://"}` 列目录，`{"path":"artifact://response.txt"}` 读取文件，子目录可写 `artifact://responses/result.txt`。目录由当前运行绑定，模型无需反复拼接项目哈希、任务 ID 和运行 ID。文件名按原文处理，不做 URL 解码；不允许绝对路径或 `..`。该前缀仅用于 Execute 的 `read`，不会改变工作目录、普通文件路径或其他角色的读取规则；`write` / `edit` / PowerShell 仍使用文件系统路径，证据提交仍填写绝对产物路径。不存在的路径仍报错，并提示从 `artifact://` 核对真实名称，不会自动改读同名文件或重放执行命令。

`updateSteps` 的 `abandon` / `prioritize` 只作用于 `ready` 步骤。已经完成、无进展、受阻、失败或放弃的步骤保留为历史；规划器对这些步骤的再次更新会提示并忽略，有效待办更新和新计划仍正常校验提交。同批先放弃再修改的重复操作也会忽略，不会重新激活旧步骤。未知 ID、正在执行的步骤和其他非法引用仍会拒绝。需要继续已结算的工作时，应检查已有结果后另提新步骤。

新配置的 `stepTimeoutSeconds`、累计 `maxMinutes`、`maxTurnsPerRun`、`maxTokens`、`maxCost` 默认均为 `null`。应用默认不设置单次运行或累计运行时间上限，也不按回合数或累计输入/输出 token 停机；token 计量照常保留，用户可随时 `/pause` 或 `/stop`。未设时间上限时不创建运行超时定时器。只有用户显式设正数才启用对应资源暂停条件，它不是 Goal 完成条件。提供方的请求超时及工具显式指定的超时仍可能终止对应调用。

`maxTurnsPerRun: null` 不预留“最后一轮”，工具始终可用，直到模型正常提交、用户取消、发生错误或触及其他显式限制。设置有限值后，它限制单次 Chat send / 角色 run 的应用层模型请求总数，包含上下文摘要、失败续接和协议修复；不计供应商 SDK 内部传输重试。最后一个请求禁用工具并整理已有结果，摘要不能占用它；例如设 12 时最多 12 个请求（摘要也占名额），设 1 时只有无工具回复。每回合可以调用多个工具，失败的模型请求同样计数。提前正常回答直接结束，已触及资源限制或取消时不追加收尾请求。若剩余上下文已超过供应商容量且没有摘要名额，仍可能报容量错误；预留收尾不是成功保证。

累计 token 预算与单次响应容量是不同概念。未指定 `models.<role>.maxTokens` 时，xloom 不向 Pi 的请求选项添加输出覆盖，但 Pi 仍会使用模型的有限 `maxTokens`；目录中未知的内联自定义模型目前回退为 16,384。Pi 会据剩余上下文调整，并向 Anthropic 发送必需的 `max_tokens` 等协议参数，所以省略配置不等于单次响应无限长。模型配置里的 `contextWindow` / `maxTokens` 是可选覆盖，需填写端点真实支持的值，不能用 `Infinity` 冒充无限容量。

供应商以 `length` 结束响应时，普通聊天及 Decide / Execute / 元认知会在当前调用中继续，不把截断直接当作任务失败，也不额外限制续接次数或累计回复长度。思考被截断时保留私有上下文和已完成工具结果；JSON 已开始时禁用工具续写后缀，按原字符拼接，保留完整前缀而不让上下文摘要替代它，直到正常结束并通过协议校验才入库。截断的工具调用仍由 Pi 拒绝执行，已有工具和 checkpoint 不重放。续接及上下文维护的实际 token 全部计入统计；用户取消和显式资源预算仍生效，提供方容量或请求错误仍可能中止调用。

PowerShell 的 `command` 是 JSON 解码一次后的原始源码，反斜线不能转义 PowerShell 引号；例如单个双引号可写成单引号字符串 `'"'`。工具先用同一 PowerShell 解释器对传入命令做 AST 语法检查，错误返回源码行列及修复提示，通过后原样执行一次。预检和执行共用工具超时，临时源码在结束时清理；程序不自动改写命令或重放副作用。`-File`、点调用的外部脚本及动态生成的源码不在这次预检范围内，它们的语法错误仍会原样返回；此时外层命令可能已有副作用，应先检查再修正和执行。

兼容旧配置：旧 `limits.maxSteps` 会在加载时忽略；旧文件中已有的回合、单次/累计时间、Token、费用上限仍按显式配置保留。旧配置的 `stepTimeoutSeconds: 180` 会触发 `Run time limit reached`；取消时间上限须将 `limits.stepTimeoutSeconds` 和 `limits.maxMinutes` 设为 `null` 或删除并重启，恢复旧任务时也会使用新配置。取消回合和累计 token 上限同理修改 `limits.maxTurnsPerRun`、`limits.maxTokens`；去掉各角色的 `models.<role>.maxTokens` 则取消应用输出覆盖。任务证据和 token 计量不会清空。

Token / 费用在模型回合结束后累计，正在进行的调用可能超出软上限；超时由取消信号处理。自定义端点价格可能未知，费用上限不能视为准确账单硬限额。暂停时间不计入运行时间；进程被强制结束时，最后一次调用的 token 统计可能不完整。

普通聊天仅调用一个 ChatSession，不启动双 Agent 或注入红队黑板。输入用量仍包含简短系统提示词、五工具的说明和参数定义、当前消息及历史；输出包含提供方计量的回答/思考。PowerShell 说明只放在工具描述中，无限回合时不再追加预算说明。红队调用另含角色 JSON 契约和公开黑板。UI 的 token 是累计输入（含缓存读取/写入）加输出，既不是系统提示词长度，也不是新增输出量或账单金额；缓存折扣由提供方决定。

## 数据与恢复

```text
workspace/
  xloom.json                      用户配置（默认不进 Git）
  state/blackboard.md              旧工作流的可读黑板投影
  .xloom/
    session.lock                  单工作区应用锁
    current-task.json             TUI 当前选中的任务 ID
    tasks/<task-id>/              每次 /run 的独立任务
      blackboard.sqlite           该任务权威状态与审计
      blackboard.md               该任务可读投影
      evidence/                   该任务归档证据
      runs/                       该任务各次调用产物与私有日志
    controller.lock               防止同时运行两个本地控制器
    blackboard.sqlite             旧工作流的权威状态（不会自动删除）
    evidence/<sha256>.bin          原始证据的归档副本
    runs/<run-id>/
      input.json                  该次独立调用的输入
      events.jsonl                该次调用的运行记录
      output.json                 该次调用的结果
      continuation.json           当前角色的私有续接检查点，不进入共享黑板
      artifacts/                  Execute 写入的原始证据
        checkpoint.json           Execute 可选的阶段提交文件
```

黑板投影中的 `tested` 使用 Jase 的 `target / finding_status / rating / evidence / next` 字段。已有非 xloom 生成的 `state/blackboard.md` 会被保留并提示，不会覆盖。新 `/run` 只建立新任务目录，不复制旧任务范围、Hint 或聊天；文件与 PowerShell 工具的工作目录仍是用户打开的项目，不会变成任务数据目录。重启进入新的空聊天，不选择上次任务；历史任务须先 `/open 任务ID` 再 `/start`。

会话分为三层：普通聊天在同次会话内连续对话，并将上下文保存到项目数据目录 `chats/`；每次启动使用新的聊天 ID，旧消息、摘要、工具结果与用量不恢复。每个任务的黑板、证据和运行记录独立保存；每次 Decide / Execute / 元认知调用都创建新的私有 Agent，上一次调用的聊天不进入下一次。`/run` 不清除本次普通聊天；补充任务信息使用 `/hint`。`/new`、模型或凭据变更新建聊天并重置聊天 token 计数，旧文件与任务保留。`/history` 只查看本次聊天，`/tasks`、`/open` 显式切换研究任务；详见 [会话与任务](sessions.md)。

`/start` 根据本次会话已选任务的黑板重新规划，不把旧 `continuation.json` 当成可跨重启恢复的会话，也不重放中断工具。未选任务时，仅为配置中的显式目标创建新任务；聊天配置提示使用 `/run`。TUI 会话显示记录同样只在内存，重启不重放旧界面。当前只支持一个工作区实例串行运行聊天/任务；`current-task.json` 供离线 `status`、`report` 等命令定位最近任务，启动会话不读取此指针。

证据单文件最多 10 MiB，单次结果最多 50 MiB；黑板保存归档引用、哈希和每份最多 4096 字节的原始片段，大正文留在文件中。角色视图将片段进一步限制到最多 2,000 个字符，并显式标注截断；片段不完整时应安排 Execute 进一步查阅，不应据此确认影响。

Decide / 元认知保留全部 Goal、待执行 Step、未关闭 Finding、Hint 和简短尝试记录，另带少量历史尾部；Execute 保留分配的 Step、祖先 Goal、相关 Finding、相关尝试及证据依赖。全部 Fact 的简短索引用于发现较早的线索；选中 Fact 后递归补齐其来源 Step、前置 Facts、证据及双向修正链。`combination` 可描述共同范围、环境版本、已有前提、缺失条件、预期能力与反证事实。提交时先验证所有 Fact 引用存在，再将 `combination.requires` 合并去重到 Step 的 `from`；重复字段漏写不再让任务退出，也不增加模型请求。反证 `counterEvidence` 保留为反证，不并入正向前提。被修正事实的直接或间接待办依赖会触发复核，不继续执行旧计划。

投影明确列出省略数量、缺失引用和片段截断情况；省略不代表未测试或可以重复执行。黑板和原始证据不会因投影或私有摘要而删除。摘要压缩仅处理同一次研究调用中较早的完整交互；过大的初始黑板、单条消息或工具结果仍可能超过提供方容量，不承诺无限上下文。

Finding 自动继承所引用合法 Fact 的全部支持证据，并校验归档完整性；不再要求模型在 evidenceRefs 中重复列全。未知 Fact / Evidence、证据损坏及不属于 Finding 的 PoC 仍被拒绝，失败批次不会提交。

Finding 的 key 是稳定身份：新 key 必须给 target，更新已有 key 可省略 target 以保留原值，或原样提供已提交 target。新增观察写入 facts / next；不要因扩写描述而另建 key。显式冲突仍拒绝，并返回原 target 和修正方法，避免不同目标的证据混在一起。checkpoint 成功响应同时返回 Finding 的 id / key / target，可供后续批次或最终提交复用。旧任务中已存在的重复线索不会自动合并或删除。

阶段提交是可选的 Execute 协议：使用原有 `write` 写入运行提示中的绝对 `artifacts/checkpoint.json` 路径，内容为 `{ "id": "checkpoint-1", "execution": { "summary": "已保存一批观察", "result": "done", "evidence": [], "facts": [] }, "yieldToDecide": false }`。实际观察仍必须引用本次 artifacts 中的原始证据。工具只有在 Controller 提交成功后才返回 `committed: true` 与公开引用；相同 ID / 内容重复提交幂等，不重复计费。相同 ID 改内容会被拒绝；后续批次使用新 ID 和已返回的证据 / Fact ID。`yieldToDecide: true` 提交后停止执行剩余工具，当前 Step 记为阶段性移交、尚未完整验证，交给 fresh Decide 重新规划。它不表示 Goal 完成。

checkpoint 在覆盖文件前先检查 JSON 语法与字段结构；检查失败保留原文件和已提交记录，并提示修正 `write.content` 后重新提交，不自动补引号或改变证据文字。写入后核对文件内容，再由 Controller 验证引用并提交。普通文件仍沿用 Pi 的写入行为；直接 `edit` checkpoint 文件不触发提交。

`Execution.attempts` 记录稳定 `hypothesis`、`scope`、`identity`、`stateVersion`、`baseline`、`changedVariable`、`outcome`、`observation` 和 `evidenceRefs`。新的支持 / 反证结论才算该条件下的进展；`inconclusive` / `blocked` 保留但不凭新增记录重置停滞。观察措辞和原始响应时间戳不参与试验去重；范围、身份和变量保留大小写。变更实际条件后可以重新验证。旧输出没有 attempts 时继续接受，仅按规范化事实和有证据的线索状态判断，不能可靠识别任意语义改写；仅添原始文件、未验证 lead 或重新打开旧结论不算新进展。

正常暂停会取消 Pi 调用及 PowerShell 子进程树；硬杀进程、断电或远端已经产生的效果不能回滚。重新打开时会保留失败/中断信息，由新 Decide 判断下一步，不自动再次执行原步骤。

私有 `continuation.json` 绑定当前 run、角色、Step、工作区和模型身份，在完整消息边界原子保存。当前 run 内的已识别模型瞬断可自动续接一次，包括 Anthropic 流缺少结束事件（`Anthropic stream ended before message_stop`）及供应商请求超时（`Request timed out.`）。续接移除失败响应，保留已完成工具结果；不把残缺输出当作完整结果提交。这与 `length` 的持续续写分别处理，不因续写而重置瞬断重试额度。有未完成工具、身份不匹配、损坏检查点、取消、认证错误或上下文容量错误时不自动重试。最终 JSON 形状不合法，或 Decide / 元认知的实体引用不合法时，最多追加一次无工具纠正请求；纠正回复本身被截断时也先续写完整再校验。校验按完整黑板一次汇总 Fact、Step、Goal、Finding、PoC 引用及其字段位置，支持按提交顺序引用同批新 Goal；不猜测或自动补全 ID。未知 Step 会明确报不存在，实际非 ready Step 则注明状态，已结算历史更新仍由 Controller 过滤。纠正请求复用已有观察，不重跑工具；仍不合法时保留明确诊断。摘要、失败请求和修复请求的实际 token 都计入用量。重启仍由新 Decide 读取公开状态，不向新 run 或另一个角色注入旧私有会话。

如果最终回复在 JSON 前后附带说明，但其中的单个外层对象可以独立解析，纠正请求会同时包含格式错误与该对象的 Schema / 引用错误；诊断时提取的对象不会直接提交，也不会从多个对象中猜选一个。PoC 归属错误会列出对应 Finding 已关联的 `evidenceIds`。模型只能选择确实支持该 review 的已有证据；否则应暂缓该 review，安排 Execute 通过原 Finding key 提交必要证据关联。系统不会自动替换 ID、跨 Finding 挂接证据或放宽验证规则。此诊断仅在出错时提供，常驻提示词和纠正请求次数保持不变。

Finding 审查的状态规则也在同一次纠正前检查，并与 Store 共用校验：`closed` 必须 `unrated`；只有 `technical_hit` / `impact_verified` 能进入影响验证，且需评级、影响字段、所属 PoC 和有证据的事实。已有大量证据不自动把 lead 升级为 technical_hit；应暂缓审查并由 Execute 沿原 key 完成技术验证。诊断同时报告字段位置与非法引用，避免修正 ID 后才在提交时暴露状态错误。文件哈希仍在 Store 内校验，不为纠正而重跑工具或改写历史。

研究任务还会生成 `wiki/index.md` 及按记录组织的页面。Execute 可按需读取提示中的 Wiki 编写说明，用原有输出或 checkpoint 保存带来源的解释页；来源修订后显示待复核，旧解释保留。Wiki 编辑本身不增加研究进展、不验证 Finding。普通聊天不参与，详见 [Wiki 与来源关系](wiki.md)。

研究调用的 `rag` 会自动提供少量相关 Wiki／公开记录及完整来源包，`wiki/organization.json` 列出整理和复核入口。Execute 可用原 powershell 调用提示中的本地脚本进行精确检索、查看整理或完整审计；命令不会修改研究状态。当前是任务内词法检索，原始响应正文仍按需 read，详见 [本地检索与审计](retrieval.md)。

失败 Step 的公开视图可带有 `recovery`，仅指向旧调用的 `artifacts` 目录，并标记为未验证。即使工具写入后模型报错、结果尚未入库，Decide 也可安排新 Step 检查残留文件；它们不会自动成为 Fact / Evidence，必须先检查并按正常证据流程提交。这个引用不包含旧聊天或运行日志。

升级旧黑板时，若旧任务尚未完成却提前关闭了根 Goal，会恢复根 Goal 为 active；旧任务标记 completed 但根 Goal 没有 satisfied 的，会改为 paused 并提示重新复核。原结论记录进审计，证据、事实、线索和计数保留；迁移不会自动调用模型或重放步骤。

`.xloom` 及报告可能含研究目标的敏感证据。默认不加入 Git、不自动上传、不全量脱敏目标证据；应由使用者管理本地文件和报告的访问权限。模型服务凭据会在运行日志/显示文本中尽量过滤，但这不是密钥保险库。

## 明确的边界

Chat 和 Execute 的 Chrome 接入默认复用用户正在运行的浏览器，授权后保持连接（包括回复结束、切换模式和退出 Xloom）；用 `/chrome disconnect` 手动断开，`/chrome connect` 允许下次调用重连，不启动独立 profile。启用步骤、参数适配、证据归档与真实模型验证见 [Chrome 接入](chrome.md)。

这是上下文隔离，不是操作系统沙箱。普通聊天和 Execute 的原生文件及 PowerShell 工具拥有当前用户权限，Decide / 元认知使用 `read` 读取资料及 `submit` 提交提案；没有额外操作系统隔离层。程序不向另一角色注入聊天历史，提示词也禁止读取其他 run 的聊天/日志和凭据，但不声称能用提示词阻止越权读文件。需要纳入权威 Fact / Evidence 的新观察仍交给 Execute 按证据契约提交。

引用、文件哈希、JSON 校验只能保证结构和证据完整性，**不能独立证明请求确实发生或漏洞成立**。真实性、可复现性、实际影响和缺失输入的判断仍依赖模型对原始证据的审查及用户复核。`NEED_INPUT` 不能用一般停滞代替；预算/错误/空计划只进入操作暂停或错误状态。

本版没有网络代理、扫描器插件、通用 MCP／Skills 加载、任意工具注册、第三 Agent、跨任务长程记忆、向量检索或多任务并发。Chrome 是 Execute 的固定适配工具。角色投影只组织当前任务的结构化状态；同次调用的模型摘要是有损私有记忆，不加载 Jase 知识包，也不能替代原始证据。审计事件是追加日志，不是可从事件完整重建数据库的事件溯源系统。

`demo` 和单元测试中的合成证据仅验证软件闭环，不能作为真实漏洞研究结果。未提供模型 Key 时也可以运行全部离线测试；这不等于完成真实模型/真实目标验收。

## 扩展位置

详见 [架构说明](architecture.md)。MVP 扩展边界是 `ContextProjector`（角色视图）、`LoopPolicy`（选步及执行后复核）、`AgentRunner`（执行后端）、结果契约、黑板 Store 和 `LoopEvent`（含角色交接）。通过构造参数和 TypeScript 接口扩展，不增加运行时插件系统。运行适配层使用 Pi 的下一回合上下文接口维护私有上下文，在显式有限回合数下预留收尾，通过 PowerShell operations 做语法预检，不修改 Pi 依赖源码。

设计参考 Cairn / Cairn_Y 的黑板协作与 FGS；Jase 体现在外层的边界建模、改变变量、影响闭环与完成复核，独立实现，不复用 Cairn 的 AGPL 源码。Pi 依赖使用 MIT 许可证；保留各依赖原有许可。
