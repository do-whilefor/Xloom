# MVP 架构与后续接口

## 聊天与任务入口

`AppController` 负责应用级模式、模型设置和本次会话的任务选择。启动时不读取上次任务指针或黑板；只有显式 `/open` 才加载历史任务。普通文字只交给独立 `ChatSession`，使用 Pi Agent 的同次会话消息历史与五工具，自然语言回复，不使用红队 JSON 契约。`ChatArchive` 将上下文持久化为归档，但聊天选择绑定实例，不从磁盘指针恢复。重启、`/new`、切换模型或凭据均新建聊天，旧消息、摘要、工具结果及用量不进入新会话。详见 [会话与任务](sessions.md)。

`/run 目标` 创建 `.xloom/tasks/<id>` 下的新黑板，由原 `LoopController` 运行；不带入聊天、旧 Hint 或旧任务范围。`/start` 恢复当前选中任务。新任务不删除旧数据，工具 cwd 始终是用户项目目录。应用锁防止同一工作区并发开启聊天/任务应用；单个 App 中也不并发运行聊天、红队 Loop 与凭据变更。旧根黑板仍可恢复。

SettingsService 只复用 Pi ModelRuntime 的本地目录、持久 API Key 和 OAuth/订阅登录。TUI 使用搜索式选择器和临时认证弹窗，Key、登录码与认证 URL 不进主 Feed 或输入历史。配置仅保存非秘密模型参数，凭据写进 Pi 原 auth.json。模型、Key、登录、退出操作支持取消信号；已经提交的凭据变更不能由取消自动回滚。

## 两个角色，三个运行模式

`decide`、`execute`、`metacog` 是调用模式，不是三个 Agent。运行时将 `metacog` 映射到 Decide 的模型，加载简短的复核指令。每个新 run 创建新的 Pi Agent；同一次 run 可维护私有上下文并在模型瞬断后续接一次。不同 run / 角色之间没有共享 `messages`，也不让一个 Agent 总结另一方聊天。

Decide / 元认知仅挂载 `read`，负责读证据、制定计划、验证交接条件与审查。Execute 使用 `read / write / edit / powershell / chrome` 完成调查和状态变更，新增权威事实 / 证据由 Execute 提交。Decide 的私有阅读历史不作为共享聊天通道。所有运行收到当前任务公开黑板文件路径，只有 Execute 收到自己的可写 artifacts 路径；计划文件名不代表文件存在。`runtime/read.ts` 通过 Pi 的已解析路径和原生文件/图片操作扩展目录列表，同名同参数，不增加工具或修改依赖源码。

一次典型闭环：Decide 读取黑板并提交 Step → Controller 校验并 claim → Execute 调查，必要时阶段性提交证据 / 事实 / 条件尝试 → Controller 归档证据并事务提交 → Execute 继续或交回 fresh Decide。最终结果结算 Step；主动交回时 Step 保持“尚未完整验证”的 `blocked` 结果，fresh Decide 另提后续工作。达到触发条件时使用 fresh Decide 元认知；提议完成时再独立复核。

Pi 内层负责一次 Agent 调用中的模型响应、已挂载工具调用与继续执行，本版不修改 Pi 依赖源码。xloom 控制器负责组织黑板、校验阶段提交、选步、触发复核和判定是否接受完成提议。没有第三个审查 Agent，也没有两个共享会话的持久进程。

Loop 没有固定执行步数上限。连续无进展仅触发元认知：有可执行的新计划便继续。根 Goal 必须由 metacog 在同一次结果中标记 satisfied 并给出最终结论，引用支持全局完成判断的事实；正常 Decide 的根 Goal 更新或完成提议只触发独立复核，不提前关闭根目标。复核期间有新 Hint，则再次使用新黑板复核。

角色提示词保持短小。JSON 协议是控制器的数据接口描述，不把 Jase 全套文档灌进系统提示词。工作区文件与目标内容都是数据，不是可信指令。

## 模块边界

研究角色新增 `submit({output: object})` 提案通道：复用文本 JSON 的 schema、引用与证据关联校验；接受后结束当前 run 并阻止后续工具，仍由 Controller 事务提交和执行独立完成复核。普通聊天保留自然语言回复；工具不可用时研究角色仍可返回文本 JSON。两条通道的任务完成条件一致。

checkpoint 的事务事件保存本批 Fact/Evidence 引用到权威 ID 的映射，包括与旧记录去重的结果。回执只返回本批映射及涉及的记录；重复投递从已提交事件恢复同一映射，不重做请求或重复计费。历史事件/自定义回调缺少映射时兼容原全量回执。

`events.jsonl` 的完整消息和工具事件附带毫秒时间戳 `at`，并保存简短的消息开始事件；不记录流式消息的重复快照。可按工具 ID 计算时长，并区分模型响应与并发读取，避免将模型消息内的请求开始时间误当作工具开始时间。

| 模块 | 当前职责 | 可替换方向 |
| --- | --- | --- |
| `types.ts` / `schema.ts` | 版本化配置、FGS、运行与结果契约 | 迁移器、更多有类型的证据/关系 |
| `app.ts` / `workspace.ts` | 聊天/任务路由、任务指针、单工作区锁、非秘密模型设置 | 会话选择与任务管理，不共享历史 |
| `runtime/chat.ts` | 独立普通聊天 Pi Agent、五工具、取消与用量 | 可选聊天持久化，不注入红队黑板 |
| `runtime/chrome.ts` | Chat／Execute 共用的当前 Chrome 会话连接、能力发现、原件与图片归档 | 固定 MCP 能力目录＋上游 CLI 常驻连接，无浏览器启动回退 |
| `runtime/settings.ts` | Pi 目录、持久凭据与 OAuth callbacks | 复用 Pi 新增的供应商登录能力 |
| `loop/context.ts` | `ContextProjector`：事实索引、因果与修正闭包、组合条件、旧依赖复核 | 更细粒度的任务上下文策略 |
| `loop/attempts.ts` | 条件试验去重、兼容旧输出的进展标记 | 改善假设标识稳定性，不以新文件冒充进展 |
| `loop/policy.ts` | `LoopPolicy`：ready Step 选取、拒选旧依赖、执行后复核 | 调整排序与复核频率，不改变完成条件 |
| `runtime/prompts.ts` | 短角色指令、输出协议、序列化公开视图及触发原因 | 契约版本演进 |
| `runtime/pi-runner.ts` | fresh Pi Agent、按角色选工具、同次调用续接与协议修复、事件 / usage / 取消 | 不改变 `AgentRunner` 的其他执行后端 |
| `runtime/continuity.ts` | Pi token 估算与完整交互压缩、私有检查点保存和恢复校验 | 更稳健的容量估算与摘要验证 |
| `runtime/stage.ts` | 原生 write 的指定文件提交协议、公开引用返回、主动移交 | 不增设工具名 |
| `runtime/models.ts` | Pi ModelRuntime 模型目录、认证和流式适配 | 随 Pi 升级扩展供应商，不维护独立模型名单 |
| `store.ts` | SQLite 权威状态、关联检查、归档与可读投影 | 存储迁移、证据分层或远程存储 |
| `controller.ts` | 串行调度、预算、调用策略/投影、生命周期与完成复核不变量 | 构造参数注入策略；不增加 Agent 角色 |
| `ui/` | LoopEvent → TUI（含角色交接）；用户输入 → Hint/操作命令 | 其他终端或展示层 |
| `report.ts` | 已存状态的 Markdown 输出 | 报告模板与人工审阅流程 |
| `demo.ts` | 明确标注的离线协议 fixture | 端到端回归基准 |

当前不引入通用插件/Hook 框架；这些文件和 TypeScript 接口就是 MVP 的扩展接缝。

## 角色视图与外层复核

默认 `ContextProjector` 显式选取字段，不序列化模型配置、凭据、Step 的运行锁字段、Evidence 的 runId 或任何聊天历史。Decide / 元认知始终保留全部 Goal、ready/claimed Step、非 closed Finding 和全部 Hint；无关历史只取最近 8 个已结算 Step、12 个 Fact、8 个 closed Finding、8 份 Evidence。Execute 主要保留当前 Step、祖先 Goal 和直接相关 Finding。

自动注入的 `factIndex` 限制为 16,000 个紧凑 JSON 字符，优先保留当前已选事实的导航；Execute 的索引仅从已选事实中取项。`projection.omittedFactIndex` 报告省略数，`projection.history` 提供覆盖全部 Fact/Attempt 的 `xloom://history` 分页入口。对已选事实递归补齐 `Fact.stepId → 来源 Step.from → 前置 Facts`，并补齐证据及双向 supersedes 链；相关历史 Step 以 `stepOrigins` 提供。组合的已有前提和反证同样参与依赖闭包。Decide / 元认知保留相关尝试及最近 12 条尝试；Execute 保留与分配 / 来源 Step 或组合范围、环境版本相关的尝试；隐藏 run ID 和内部去重 key。

必需依赖不受历史尾部数量限制；单份证据片段最多 2,000 字符，截断有标记。`projection` 明确提供省略数量、不可用引用和阅读提示；缺失内容不是负面证据，关键细节不足时读取当前任务黑板 / 原始证据或安排 Execute 继续取证。投影不改写持久黑板，也不是硬 Token 预算或知识库。

当前角色选中的 Finding 另有 `findingContext` 导航：复用正式证据关联，列出明确引用关系产生的未关联候选、事实替代、声明反证、条件和相关尝试。补充索引按 ID 去重，不复制原始正文；省略项可通过现有 `blackboard.md` 的完整引用索引补查。它不自动关联证据、评定影响或保存第二份状态，详见 [Finding 证据视图](finding-context.md)。

任务 Wiki 从同一 SQLite 黑板生成自动记录页，Execute 可通过现有最终输出 / checkpoint 提交 `wikiPages` 作者解释。稳定页面与块 ID、来源签名及历史保存在原黑板中；来源变化只产生页面待复核标记。研究调用拿到 Wiki 首页、按需编写说明及任务内词法 `rag` 结果；普通聊天不加载。`wiki/catalog.ts` 生成公开记录倒排与整理投影，`wiki/retrieval.ts` 装包完整判断和来源，`wiki/audit.ts` 只读核对生成文件及原件；`wiki/local.ts` 可由原 powershell 调用。没有额外 Agent / 工具注册，角色 system prompt 不变。见 [Wiki 与来源关系](wiki.md) 和 [本地检索与审计](retrieval.md)。

原生 `knowledge/` 在同一 SQLite 内保存能力、前提、连接观察与最终结果来源。完整记录通过既有 Execute/checkpoint 提交；变更进入下一轮 `knowledge` 候选视图及 Wiki/RAG，必要时触发 `knowledge_change` 复核。供需匹配与来源变化不自动升级 Finding 或完成 Goal。见 [原生能力与链路](knowledge.md)。

`pendingStepReviews(snapshot)` 找出 ready Step 对已修正事实的直接或间接依赖，包括来源链和组合反证。公开 `projection.stepReviews` 给出旧事实与替代事实 ID；Policy 不选取这些旧计划，Controller 先交 fresh Decide 重新规划。若复核后仍只有失效计划，则保留未完成状态并暂停，不能因该队列为空而宣称 Goal 完成。

失败 Step 可带公开 `recovery`，只提供历史产物目录和 `evidenceStatus: unverified`，不暴露聊天日志入口。新 Decide 可将检查该目录作为新 Step；恢复引用本身不能充当证据。这样既保留写入后失败的检查路径，也不自动重放旧操作。

默认 `LoopPolicy` 按优先级降序、ID 顺序选择 ready Step。执行结果提交后，按受阻 → 新增/更新技术命中证据 → 新事实修正 → 停滞 → 周期复核的优先顺序选择触发原因，交给 fresh Decide 元认知；普通执行结果则进入 fresh Decide 规划。策略只调度，不能直接评级、关闭 Goal 或伪造完成。

手动 `/meta`、新 Hint、空计划和完成前复核由 Controller 保留为流程不变量。`LoopController` 第三个可选参数接收 `policy` 与 `projectContext`；默认行为无需配置。`handoff` 事件携带两个角色之一、运行模式、黑板版本、Step 和触发原因，供 TUI / headless 显示；触发原因也写入 `run_started` 审计。TUI 不增加常驻介绍或底部帮助行。

`result` 事件只在 Controller 成功提交结果 / 阶段结果后发出，携带已提交摘要，不把流式协议或普通工具返回当作已确认结果。TUI 将角色交接、工具摘要、聊天正文和协议细节分层渲染；`/details` / Ctrl+O 仅切换本地展示，不改变 Agent 上下文、证据归档或 Loop。`/` 候选使用 Pi Editor 的命令补全接口，仅有静态应用命令与模型角色，不扫描文件、不读取凭据；候选 Enter 在应用层映射为补全，下一次 Enter 才执行。

运行时 `thinking_start` / `thinking` / `thinking_end` 仅转发提供方实际公开的思考块，以调用、消息和内容块编号隔离，采用跨增量凭据过滤；不使用签名或 redacted 内容。仅在最终消息回放的块标记 `replayed`，展示层不宣称其推理耗时。UI 的工作尾行和思考块都只属于本地事件流，不注入任一角色的上下文；完成、失败、暂停、停止保持不同显示。内部 `xloom-thinking:` 标题链接复用 Pi 的点击/拖动识别，仅允许当前视图生成的 ID；不打开外部地址。重绘计时器在工作结束或退出时清理，Ctrl+T / Ctrl+O 提供键盘后备操作。

## 黑板不变量

1. Facts 追加而不是覆盖，修正通过 `supersedes` 指向旧 Fact；事实必须带已有原始证据引用。
2. Step 指向活动 Goal 和前置 Facts，claim 与运行 ID 绑定。每次只允许一个活动 run。中断不回到 ready，不自动重试可能产生副作用的操作。
3. Finding 以稳定 hypothesis key 合并，不按每个请求建一份。仅修改下一步建议不计新进展。
4. Finding 关联的所有 Fact 的证据必须完整关联到该 Finding；审查时重新验证归档文件大小和哈希。
5. Execute 只可提出 lead / technical_hit；Decide 才能审查为 impact_verified / closed。不是 impact_verified 时不得使用 info / P1 / P2 / P3。
6. 确认影响要求完整影响字段、原始证据与 PoC、审查说明。此处确定性验证的是结构与关联，不是取代动态证据审查。
7. 新 Hint 到达正在进行的规划时，完成结论暂缓，转入读取新黑板的元认知。
8. 数据库状态和审计事件同一事务提交。证据文件先归档；若后续验证失败，可能留下不被引用的归档文件，但图和 run 不会部分提交。暂不自动清理这些文件，以免误删研究材料。

## 阶段提交与累计用量

`RunRequest.onCheckpoint?: (checkpointId, output, cumulativeUsage) => BoardSnapshot | Promise<BoardSnapshot>` 是可选后端接口。默认 PiRunner 不增加工具名，而是包装 Execute 原生 `write`：只有写入提示中指定的绝对 `artifacts/checkpoint.json` 路径才触发提交。内容契约为：

```json
{
  "id": "checkpoint-1",
  "execution": {
    "summary": "保存已完成的观察，继续验证下一条件",
    "result": "done",
    "evidence": [{ "ref": "response", "path": "responses.txt", "description": "原始对照响应" }],
    "facts": [{ "ref": "observed", "description": "已观测到的具体差异", "evidenceRefs": ["response"] }]
  },
  "yieldToDecide": false
}
```

`execution` 使用同一 `executionSchema`。文件本身不代表已经提交；解析、引用及证据校验全部通过后才返回 `committed: true`、黑板 revision 和公开引用。后续批次用新 checkpoint ID；最终结果只提交尚未入库的增量，并用返回的真实 ID 引用已存材料。写其他文件保持 Pi 工具原语义；经 PowerShell / edit 改该文件不会触发此 write 提交通路。

`BlackboardStore.applyExecutionCheckpoint(runId, checkpointId, output, cumulativeUsage)` 与最终 `applyExecution` 共用数据校验和归档。SQLite 事务同时提交权威记录、`execution_checkpoint` 审计、检查点 ID / 内容哈希及本 run 已计用量。相同 ID / 内容重复投递幂等，不增加 revision、记录或用量；相同 ID 内容不同会被拒绝。后续失败或进程恢复仍保留已提交材料；未完成批次只保留原始 artifacts，不能自动变成事实。

checkpoint 不结束 run / Step，不增加 `completedSteps`。新支持 / 反证发现可即时清除停滞并记录该 run 已有实质进展；最终结算不会因仅提交一个空增量就把这次运行误判为无进展。`yieldToDecide: true` 使 PiRunner 停止后续工具并返回 `RunResult.yielded: true`，以 `blocked` 明确原 Step 尚未完整验证，Controller 强制 fresh Decide 接手；交接不是最终完成。

`run_progress` 保存累计已计入的 input / output / cost，checkpoint 要求累计值不下降。最终成功、失败或取消只追加尚未计入的差额；无法提供更完整用量时保留已知值，不能负向冲销。Runner 的预算基线固定为开始 run 时的用量，不能用 checkpoint 后的黑板累计值再次加上本 run 全量。UI 收到权威黑板更新后同样只保留未提交的实时用量。

## 组合与条件化尝试

`StepProposal` / `Step` 可带 `combination: { requires, missing, scope, stateVersion, expectedCapability, counterEvidence? }`。`requires` 与 `counterEvidence` 是已有 Fact ID，`requires` 还必须属于 `Step.from`；`missing` 是尚未验证的条件描述。多个 `from` 已表达组合来源，新增字段只说明这些事实能否在相同条件下成立以及下一步要补什么。环境版本等组合条件变化可提出同描述的新 Step，保留旧记录以供追溯。

`Execution.attempts?` 的每项为 `{ hypothesis, scope, identity, stateVersion, baseline, changedVariable, outcome, observation, evidenceRefs }`。`hypothesis` 是稳定标识，重复试验应复用；`outcome` 只允许 `supports | refutes | inconclusive | blocked`。每项必须引用至少一份经过大小 / SHA-256 校验的原始证据；该检查验证关联与完整性，无法代替对证据真实性、结论语义的审查。

Store 生成 `conditionKey = hash(hypothesis, scope, identity, stateVersion, baseline, changedVariable)` 和 `outcomeKey = hash(conditionKey, outcome)`。假设标识做空白 / 大小写规范化；实际范围、身份、环境与变量保留大小写以区分敏感路径 / 值。同条件同结论且观察文字相同才合并证据引用；不同观察文字分别保留。新的时间戳、不同 observation 措辞和新 Fact ID 不带来额外进展；原始事件、文件和事实仍归档。新的 `supports` / `refutes` 条件结论才算进展，`inconclusive` / `blocked` 留档但不单凭记录增加重置停滞。相同条件的支持与反证都保留，交由后续复核解释冲突。

旧输出未提交 attempts 时继续兼容，按规范化 Fact 描述 / 修正关系和有证据支持的 Finding 阶段新增判断。孤立 Evidence、未取证 lead、仅改 next 文案、仅重开 / 降级 Finding 不算进展。兼容模式不能识别任意语义改写；结构化模式也依赖稳定假设 ID 和真实条件描述，不能声称实现了通用语义去重。

## 当前 run 的上下文与失败续接

Execute 的 checkpoint 写入支持 `write({path: checkpointFile, content: {id, execution, yieldToDecide}})`。
优先传结构化对象，由运行时序列化；普通文件仍只接受字符串。旧 JSON 字符串仍严格
解析，语法错误不会猜测修复或覆盖文件。两种方式经过相同 Schema、证据及事务校验，
已提交 ID 重试继续幂等。数组中提前闭合 `]` 等错误应改用完整结构化对象重交。

`runtime/continuity.ts` 使用 Pi 的 token 估算、压缩判定和对话序列化工具。原生研究 Run 接近窗口时，先在连续只读片段内移除重复的完整原生读取批次，再从当前黑板重建任务核心：原文目标、范围、用户 Hint、更正、活动分支、当前 Step 和阅读入口。若已释放足够空间，不调用摘要模型。否则保留至少两个完整近期交互批次，并以最多 2,000 个估算 token 且不超过保留窗口 10% 的额度，原样保留较早的已校验原件读取，剩余旧交互才交给同角色模型摘要。源包未完整交付、普通文件读取、用户消息、带叙述的调用或写操作均不能按重复原生读取删除。不会拆开工具调用和对应结果，也不会重放工具。压缩后重置本轮重复查询、字节阅读覆盖和分页阅读回执，避免把已移出上下文的材料继续标为已读。

没有原生任务读取器的自定义 Run 保留初始任务。Chat 将首条也纳入摘要，并与其他历史用户原文共享保留预算，不会越过过大的较新更正而单独保留旧首条。摘要是有损会话记忆，不能提交为原始证据，工具和来源文本仍是数据。仅在变小且成功时替换消息；失败时保留原状。原文约束、活动分支或单个来源包过大时仍可能触及模型窗口。这些机制没有模型参数微调，离线度量见 [上下文维护验证](context-maintenance-validation.md)。

`continuation.json` 在消息边界以临时文件 + 原子替换保存身份、完成消息、未完成工具 ID 和累计用量；私有模型思考 / 签名不写入该检查点，已知模型凭据经过过滤。该文件不投影到另一角色。载入时核对版本、角色、当前 run、Step、工作区、模型与端点；未完成工具或不匹配的调用 / 结果拒绝自动恢复。

仅当前 PiRunner 调用中的已识别瞬断可从完整检查点续接一次：保留已完成工具结果，移除尾部失败模型响应，不自动重新执行工具。认证 / 配置 / 上下文容量错误、用户取消、损坏检查点或不确定工具副作用需要退出这次调用。最终 JSON 无效时可追加一次工具禁用的格式修复，请求只能整理已观察且未提交的增量。单次及累计运行时间默认均不限；用户取消及显式资源限制仍生效。摘要、失败响应、续接和修复的实际 token 全部计量，不设置默认累计 token / 回合上限。

这是同次运行内的私有连续性。失败 Step 保留在任务归档中，重启后须显式打开历史任务，再由 fresh Decide 检查公开记录和 artifacts；新 run 不自动载入前一 run 的私有会话，也不跨角色恢复它。普通 ChatSession 在同次会话内复用上下文压缩和一次瞬断续接，计入摘要 token；应用将 continuation 文件保留为归档，不跨启动恢复，也不使用研究结果 JSON 修复。

## 最终状态

除 `NEED_INPUT` 外，所有最终结论都要求根 Goal satisfied、支持该判断的证据事实、无 active 子目标和待执行步骤。根 Goal 不允许 abandoned。LLM 必须按照用户实际 Goal 判断是否已完成，而不是用“有一个结果”代替全局完成。

`VULN_FOUND` 额外要求至少一个已验证影响的 P1/P2/P3 Finding 和 PoC。若 Goal 只是验证某条假设，它不意味着所有攻击面测试完毕；若 Goal 要求广泛覆盖，不能发现第一条漏洞就停。遗留线索保留在黑板/报告中，并纳入完成语义复核。

`NOT_REPRODUCED` 要求至少完成一次 Execute，并对所有记录的假设有证据支持的关闭与重开条件；`LOW_ROI` 要求经过影响验证后只剩 info/已关闭项。一般空结果不能进入这两个结论。

`NEED_INPUT` 保留 lead / technical_hit 和 unrated，缺失条件写进 `next`；状态为 paused，可在补充 Hint 后恢复。系统无法仅靠非空字符串自动验证“确实缺少账号/对象”，这一语义由元认知承担。

Controller 在提交前检查 NEED_INPUT 的结构性前提（考虑本次 reviews 后是否仍有未解决的 lead / technical_hit 及非空 next）。不成立时只移除等待结论，保留计划供 Store 完整校验，按既有规则执行或复核后操作暂停，避免未执行工作的空产物把整个调用变成提交错误。合法 NEED_INPUT 仍经 fresh metacog 复核；普通完成提议、证据约束和 Store 的最终校验保持不变。

单次/累计运行时间、回合数、输入/输出 Token、费用预算默认 null，只在用户显式设置时作为资源暂停条件；旧 maxSteps 加载时丢弃。旧配置若仍显式填写 180 秒，则须删除或改为 null 并重启才能解除。资源耗尽、调用失败、取消和没有可执行计划是操作状态，不强行映射到研究结论。

`runtime/run-budget.ts` 为聊天及研究调用共享资源预算策略。`maxTurnsPerRun: null` 不限制请求，不禁用工具，也不强制进入收尾。显式有限值限制本次调用的应用层模型请求总数；正常生成、摘要、失败续接和协议修复经过同一个受限 stream 入口。最后一个请求保留给无工具报告，不能用于摘要；Pi `prepareNextTurnWithContext` 更新下一轮工具集合，Chat 恢复上下文后也重新检查剩余名额。配置为 1 时首轮就禁用工具。仍要求正常 stop 和既有结果契约，Chat 每次 send 重置工具和预算闭包。资源预算在整轮结束后和模型请求前检查。模型解析层未收到显式 `models.<role>.maxTokens` 时不追加请求级输出覆盖；Pi/供应商的有限容量约束仍存在。

`runtime/powershell.ts` 包装 Pi PowerShell operations：临时源码文件交给同解释器 AST parser，仅执行语法检查，通过后原始 command 执行一次。预检与执行共享取消信号及总工具超时，finally 清理临时源码。语法预检不是运行时成功保证，也不修改源码含义。TUI 使用同一模型消息的 messageId 关联正文、真实思考和进展叙述，活动聚合仅影响呈现；usage 事件更新即时 token，权威用量提交后清除待计部分。

旧库迁移只修复根 Goal 与任务完成状态的不一致：未完成却 inactive 的根 Goal 恢复 active；completed 但根 Goal 未 satisfied 的旧任务转 paused 等待复核。迁移有独立审计，不自动执行模型/步骤，不删除研究证据，也不改动已符合新条件的完成状态。

## Pi 模型复用

Chat 和 Execute 挂载 `runtime/chrome.ts` 的单一 `chrome` 工具，以 list／describe／call 按需发现固定 Chrome MCP 包的能力。目录临时读取后缓存，实际调用经 `runtime/chrome-daemon.ts` 复用上游 CLI 常驻进程。连接固定使用 autoConnect，复用当前登录态，拒绝隔离 context，不启动浏览器。同工作区与 XLOOM_HOME 共享一条连接，回复／运行结束、取消、聊天重置和应用重启均保留；只有显式 `/chrome disconnect` 停止进程并阻止工具重连，`/chrome connect` 解除手动断开标记。浏览器关闭或撤权仍可能断线。Chat 原件写入私有聊天 artifacts，Execute 原件写入 run artifacts 并按既有 Evidence／Fact 提交流程验证；MCP isError 转为 Pi 工具错误，取消只停止等待，失败不重放。详见 [Chrome](chrome.md)。

使用 Pi 公开 ModelRuntime，不复制供应商实现或限制自定义 API 为三种。读取 Pi 用户目录的 auth.json、models.json 及缓存目录，由 Pi 处理已有 OAuth 登录刷新、环境/API Key 认证、供应商特有 headers 和流式请求。`models` CLI 仅列本地内置/缓存/自定义目录；运行时按需发现动态目录，遵守 PI_OFFLINE。模型身份与凭据不进入共享黑板提示词；执行期间刷新产生的凭据也加入日志/流式文本过滤。

模型解析层不会加载 Pi CLI 聊天、扩展、Skills、用户 MCP 配置或任意工具。仅靠 JavaScript 扩展注册的第三方 provider 不在自动加载范围。兼容性随固定 Pi 依赖版本而定，真实账户与模型契约仍需实测。OpenCode Go 官方端点另合并 `x-opencode-session`，复用 Pi 会话 ID 或同一 resolver 的稳定备用 ID；不修改其他提供方、其他主机或 Pi 内层。

## 验证层次

Schema / Store 测试覆盖字段与图一致性、checkpoint 事务 / 幂等 / 失败保留 / 用量差额、条件变化与重复观察；App 测试覆盖模式隔离、多任务恢复、模型设置与取消；Controller 测试用合成 Runner 验证阶段交接、旧依赖复核、取消、预算和恢复；Context / Policy 测试覆盖递归因果闭包、事实索引、字段隔离与触发优先级；Runtime 测试覆盖真实 Pi API、Decide 只读 / Chat 与 Execute 五工具、上下文压缩、同次瞬断续接、协议修复、凭据过滤及 Windows 进程树终止；Settings/UI 测试使用隔离凭据存储、可控终端与模拟剪贴板检查设置、隐私、布局和生命周期；CLI 演示不访问真实目标。

外层集成测试串联真实 Controller、SQLite、Pi Agent 和原生 write/read 工具，只替换模型解析及供应商响应流：验证文件写入/读取、证据归档、黑板交接、fresh Decide 完成复核，以及写入后供应商失败时定位残留文件、安排新 Step 检查而不自动重放副作用。这证明软件组件的闭环与隔离，不代表真实 LLM 的协议遵从率或漏洞验证成功率。

下一阶段应优先补真实模型契约成功率、针对自有测试环境的动态端到端验收、大型活动黑板的预算控制和真实终端人工体验。只有这一步完成，才适合评价红队任务成功率，而不只评价软件能否走通 Loop。

## 观察比较的原生适配

`src/observations` 复用 Webounty 只读差异语义，对接现有 Attempt、Evidence、Fact、
Finding 与 Wiki；通过原有 read 和外层 Decide 复核运行。没有增加 Python、会话引擎、
Agent 或 hook。来源变化的待复核标记与 Execute 在同一 SQLite 事务提交，完成前必须
显式复核。数据映射和边界见[观察比较与复核](observation-comparison.md)。
