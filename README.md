<h1 align="center">Xloom</h1>

<p align="center">基于 Pi Agent 内核的 Windows 双 Agent 安全研究 Loop</p>

<p align="center">
  <a href="#使用边界"><img src="https://img.shields.io/badge/Scope-Authorized%20Security%20Research-blue" alt="Scope: Authorized Security Research"></a>
  <a href="#核心设计"><img src="https://img.shields.io/badge/Agent-Decide%20%7C%20Execute-6f42c1" alt="Agent: Decide and Execute"></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Runtime-Node%2024%20%7C%20PowerShell%207-success" alt="Runtime: Node 24 and PowerShell 7"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT"></a>
</p>

Xloom 是一个本地运行、面向授权安全研究的双 Agent 研究 Loop。

默认以普通聊天打开。Chat 和 Execute 都可使用 `read / write / edit / powershell / chrome` 五个工具。输入 `/run 目标` 切换到双 Agent 红队任务：两个角色不共享聊天历史，只通过结构化黑板协作。Decide 负责计划、读取证据与审查，通过 `read` 读取资料、`submit` 提交提案；Execute 深入调查当前步骤，并可先提交关键观察再继续或交回规划。元认知是 Decide 的一次全新上下文调用，不是第三个 Agent。

`chrome` 按需复用用户已登录的 Chrome，连接跨回复和应用重启保留；用 `/chrome disconnect` 手动断开，`/chrome connect` 允许重连。

它不做批量扫描，也不预设漏洞数量，而是模拟真实研究过程：

> 探索 → 假设 → 技术命中 → 证据 → 危害验证 → 结论

---

## 核心原则

> 广泛探索，严格验证。没有完整证据，不确认漏洞。

- 以服务端认证、授权、对象归属、租户隔离、状态流转和业务规则为主要安全边界。
- 静态特征、扫描结果、错误信息、历史案例只能生成线索，不能替代动态验证。
- 技术命中保持 `unrated`；只有证据关联、影响字段与 PoC 通过审查后，才允许 `impact_verified` 与评级。
- 使用文件保存状态和证据，而不是让模型凭上下文记忆重复测试、遗漏测试或凭空重建结论。

## 核心设计

### 两个角色，三种运行模式

`decide`、`execute`、`metacog` 是调用模式，不是三个 Agent。每个新 run 创建新的 Pi Agent，消息数组从空开始；不同 run / 角色之间不共享 `messages`。

- **Decide / 元认知**：使用 `read` 读取资料及 `submit` 提交提案，负责规划、读取证据、验证交接条件与审查。元认知映射到 Decide 的模型，在同一套黑板上的全新上下文复核。
- **Execute**：使用五个工具完成调查与状态变更，新增的权威事实 / 证据由 Execute 提交。

一次典型闭环：

```text
Decide 读取黑板并提交 Step
  → Controller 校验并 claim
  → Execute 调查，必要时阶段性提交证据 / 事实 / 条件尝试
  → Controller 归档证据并事务提交
  → Execute 继续或交回 fresh Decide
  → 触发条件满足时元认知复核
  → 完成提议由独立复核确认
```

### FGS 黑板

Agent 不共享完整聊天历史，而共享结构化状态。Controller 验证提案后统一提交，Agent 不直接写权威黑板。

```text
Fact / Goal / Step  +  Finding / Evidence / Hint
```

- 按角色投影黑板：提供全部 Fact 的简短索引，按依赖补齐 `Fact → 来源 Step → 前置 Facts` 因果链与修正链。
- 旧事实被修正后，依赖它的待办先回到规划复核。
- Execute 通过 `write` 向 `artifacts/checkpoint.json` 提交阶段结果，事实、证据和累计用量原子入库。
- 中断步骤标记失败，不盲目重放；后续失败保留已提交成果。

### 证据与状态

- SQLite WAL 持久化、追加审计事件、步骤 claim、单控制器锁、暂停 / 停止 / 恢复。
- 证据归档与 SHA-256 校验、引用完整性检查、组合前提和带条件的尝试记录。
- 重复记录不计进展；时间戳变化的原始证据仍保留。
- 完成必须来自一次 fresh Decide review，确认根 Goal 已满足并引用证据事实。步数只计数，不设任务上限。

## 快速开始

需要 Windows、Node.js 24+、PowerShell 7（`pwsh.exe` 在 PATH 中）。推荐 Windows Terminal。模型服务凭据由用户提供。

```powershell
Set-Location 'D:\path\to\xloom'
npm ci --ignore-scripts
npm run check

# 不连接模型、不访问外部目标的合成闭环演示
npm start -- demo --headless

# 注册全局入口；上面的 check 已构建 dist，npm 全局 bin 目录需在 PATH 中
npm link

# 之后可在任意工作目录打开普通聊天 TUI
xloom
```

在 TUI 中使用 `/model` 选择模型、`/apikey` 设置 Key，首次使用默认用户目录时会导入 Pi 已保存的认证，原件保留。普通文字为聊天；`/run 目标` 启动双 Agent；`/hint 文字` 补充任务信息；`/help` 查看全部命令。

```powershell
npm start -- run --headless      # 为配置中的目标新建独立任务并立即执行
npm start -- status              # 只读当前任务状态，不调用模型
npm start -- report              # 输出 Markdown 报告
npm start -- models              # 列出 Pi 本地模型目录
```

构建后也可使用 `node dist/cli.js`；`npm link` 注册的 `xloom` 始终保留终端当前工作目录，不会切换到源码安装目录。源码更新后执行 `npm run build` 即可更新链接命令。

终端底部用量显示 `I 输入 · O 输出 · C 缓存命中 · H 命中率`。I 包含缓存读取和缓存写入，
C 仅统计模型服务返回的缓存读取 token，H 为 C 占对应输入的比例；它不是本地 RAG 缓存命中率。
窄窗口会缩写数字。旧任务／聊天没有缓存明细时显示 `—`；混合新旧统计时 C、H 后的 `*`
表示仅统计具有缓存明细的输入，I、O 仍显示完整累计值。新统计随任务／聊天保存，压缩及
语义检索辅助调用也计入。已运行的终端需在安全暂停后重新启动程序，才能加载新版显示。

## 项目结构

```text
xloom/
├── src/
│   ├── app.ts / cli.ts            # 应用路由、TUI / CLI 入口
│   ├── controller.ts              # 串行调度、预算、生命周期、完成复核
│   ├── store.ts                   # SQLite 权威状态、归档与可读投影
│   ├── schema.ts / types.ts       # 版本化配置与结果契约
│   ├── loop/                      # ContextProjector / LoopPolicy / 尝试去重
│   ├── runtime/                   # Pi 运行适配、文件/Shell/Chrome 工具、模型、续接、阶段提交
│   └── ui/                        # LoopEvent → TUI
├── tests/                         # vitest 单元与集成测试
├── arxiv.pdf
├── xloom.example.json             # 配置样例
└── LICENSE
```

运行数据默认写入用户目录 `~/.xloom/`（Windows 使用系统用户目录，例如 `C:\Users\Acer\.xloom`）。可用绝对路径环境变量 `XLOOM_HOME` 指定另一数据目录。工作区仍是启动目录，或 `--workspace` 指定的目录；默认不再向工作区创建内部 `.xloom`、配置或黑板投影。每次启动都是新会话，不自动加载旧聊天、用量或任务黑板；同次聊天保留连续上下文。`/history` 只查看本次聊天，`/new` 新建聊天并保留归档。历史研究任务须用 `/tasks`、`/open 任务ID` 明确选择后再 `/start` 继续；`/paths` 查看数据位置。

`~/.xloom` 内的布局：

```text
settings.json                     全局默认模型和资源限制，不含任务目标
models.json / auth.json            Xloom 自己的模型配置与认证
cache/models-store.json            模型缓存
locks/<工作区哈希>.lock            各工作区独立的应用锁
projects/<工作区哈希>/
  project.json                    真实工作区路径、名称和迁移记录
  settings.json                   该工作区配置（新建时继承全局默认）
  current-task.json                该工作区选中的研究任务
  tasks/task-<UUID>/
    blackboard.sqlite             权威状态和审计事件
    blackboard.md                 可读投影
    evidence/<SHA256>.bin          归档证据
    runs/<run-id>/                调用输入、事件、续接检查点和产物
```

工作区按规范化真实路径区分，同名目录不会混用任务，文件系统别名映射到同一工作区。不同工作区可以分别运行；同一工作区仍只允许一个应用控制器。每次 `/run` 新建任务；重新启动进入空聊天，历史任务须通过 `/tasks`、`/open 任务ID` 明确选择，随后 `/start` 继续。未选择任务时，`/start` 为配置中的显式目标创建新任务。

`xloom paths` 显示实际工作区、用户数据、项目数据和配置路径。全局 `settings.json` 提供新工作区的默认值，已有工作区保留各自设置；`/model` 保存当前工作区的选择，认证和自定义模型目录由所有工作区共用。`--config PATH` 仍支持显式配置文件，其相对路径以工作区解析。

首次打开旧工作区，或执行 `xloom migrate`，会复制原 `.xloom` 和 `xloom.json` 到用户目录：先阻止与旧控制器同时写入，通过 SQLite backup 包含 WAL 数据，再校验证据大小、SHA-256 和引用，最后原子启用新目录。旧文件保留，迁移失败不启用半成品，重试不会覆盖已导入的数据。原根黑板／headless 任务兼容保存在对应 `projects/<哈希>/` 根部；新 `/run` 使用独立任务目录。运行输入和私有日志保留历史原文，可能含旧位置；恢复使用新黑板和证据位置，不自动重放旧工具。

使用新版本后请将旧项目数据当作备份；旧版程序对它的后续修改不会自动同步。备份时退出相应 Xloom 进程后复制用户数据目录。

## 内置方法库

研究流程内置 13 张精简方法卡。Decide 从一句话目录选择可选
`Step.methodIds`（每步最多 3 张），Execute 按需接收测试和判断要点，Decide /
元认知读取相关复核要点。方法与任务证据分开保存；原有系统提示词、Agent 和工具
集合保持不变，普通聊天不加载方法库，无需 Skills 或 hook。资源随安装包发布。

## 模型与配置

Execute 的 `powershell` 工具支持结构化 `http` 请求：自动保存原始请求/响应及证据引用，同一 run 内按目标和身份请求头复用连接。明确独立的 GET/HEAD 请求可在一次调用内最多四路并发；普通命令、写入及修改状态的 HTTP 请求保持顺序。PowerShell 命令在同一进程内完成语法预检与执行。脚本循环仍可使用内置 HTTP helper，并复用已完成前置步骤的 artifacts。使用方式见 [执行效率与 HTTP helper](resources/runtime/execution.md)。

模型目录、供应商适配和认证直接使用依赖 Pi 的 `ModelRuntime`，不维护独立的模型白名单。`models.chat`、`models.decide`、`models.execute` 可配置不同模型；元认知始终复用 decide。

```json
{
  "provider": "my-endpoint",
  "model": "your-model-id",
  "api": "openai-completions",
  "baseUrl": "https://your-endpoint.example/v1",
  "apiKeyEnv": "XLOOM_MODEL_KEY",
  "thinking": "max"
}
```

项目配置不接受明文 Key。Pi 的模型运行时与登录服务均显式使用 Xloom 用户目录中的 `auth.json`、`models.json` 和模型缓存，支持环境认证、API Key 与 OAuth 登录 / 刷新。默认用户目录首次使用时只导入一次已有 Pi 配置，不覆盖已有 Xloom 文件，不删除 Pi 原件，登出后也不会再次导入旧认证。设置 `XLOOM_HOME` 时默认隔离，不自动读取旧 Pi 认证；需要导入时执行 `xloom migrate --pi-dir "旧 Pi agent 目录的绝对路径"`。默认不设置运行时间、回合数或 token 硬上限，用户可随时 `/pause` 或 `/stop`。

思考默认选择该模型在 Pi 目录中支持的最高档位（配置 `thinking: "max"`，或省略）；例如仅支持 `high` 时实际使用 `high`。显式 `off` 仍关闭思考。自定义内联端点默认启用推理能力；不支持推理的端点设置 `reasoning: false`，已知模型优先保留目录能力。`reasoning` 表示能力，`thinking` 表示本次设置，两者独立。该设置也用于 Chat 和上下文压缩。最高档位可能增加响应时间，不代表供应商支持无限推理预算。

## 明确的边界


这是上下文隔离，不是操作系统沙箱。普通聊天和 Execute 的原生文件及 PowerShell 工具拥有当前用户权限，Decide / 元认知使用 `read` 读取资料及 `submit` 提交提案。提示词禁止读取其他 run 的聊天 / 日志和凭据，但不声称能用提示词阻止越权读文件。

引用、文件哈希与 JSON 校验只能保证结构和证据完整性，**不能独立证明请求确实发生或漏洞成立**。真实性、可复现性、实际影响和缺失条件的判断仍依赖模型对原始证据的审查及用户复核。

本版通过固定 Chrome 适配层复用已有浏览器会话，没有网络代理、扫描器插件、通用 MCP／Skills 加载、任意工具注册、第三 Agent、跨任务长程记忆或多任务并发。`demo` 与单元测试中的合成证据仅验证软件闭环，不能作为真实漏洞研究结果。

## 使用边界

本仓库仅用于以下场景：

- 明确授权的漏洞赏金和 SRC 测试范围。
- 用户自有系统、测试环境、实验室或本地搭建的开源项目。
- CTF、靶场、安全课程和防御性研究。
- 经授权的代码审计、接口测试和漏洞复现。

禁止用于：

- 未经授权扫描、探测、入侵或利用第三方系统。
- DoS、DDoS、持续压测、资源耗尽或影响业务可用性的行为。
- 删除、破坏或不可逆修改真实业务数据。
- 建立 WebShell、后门、计划任务、反向 Shell 或其他持久化访问。
- 横向移动、攻击无关资产、窃取凭证、钓鱼、撞库或社会工程。
- 违反适用法律、平台规则或目标方明确限制的行为。

## 免责声明

本项目仅用于合法授权的安全研究、教育和测试环境。

使用者必须自行确认其拥有充分授权，并对目标范围、测试方法、工具配置、数据处理、证据保存和后续影响承担全部责任。作者不对任何未经授权的使用、错误配置、数据丢失、业务中断、法律责任或其他直接或间接损失承担责任。

本项目不保证能够发现漏洞，也不保证发现数量、严重程度或 AI 输出的正确性与完整性。任何结论都应由具备资质的测试人员进行独立验证。

## License

本项目采用 [MIT License](LICENSE)。
