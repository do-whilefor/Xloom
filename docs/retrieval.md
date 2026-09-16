# 任务内 RAG 与本地整理／审计

Xloom 复用当前研究任务的 SQLite 和 Wiki，通过 `materials` 交接资料变化，
通过 `rag` 提供问题入口和检索结果。检索继续使用原有 `read / powershell`；Chat 和 Execute 另有 [Chrome 工具](chrome.md)，Decide／元认知仍只有
`read`。默认词法检索不调用模型；显式语义检索复用当前角色的配置模型，
没有新增 Agent、工具注册、hook、Python 依赖或外部向量服务。

## 检索范围与相关性

精确 record 读取区分来源缺失与来源包超预算；超预算时返回 `nextReadPath`，
可直接使用同一 read 扩大至 64,000 字符。首次未交付和相同失败请求的重复读取
分别标记 `resolve_incomplete_retrieval` 与 `stop_repeating_incomplete_query`。
提示展示所读记录 ID 和补读入口，不把空来源包误报为原件不存在。资料导航中
尚未交付的条目继续保留；只有完成交付才更新相应记录的提示基线。

当 record 来源包超过最大预算时，返回 `source_page`，以完整记录分批交付。
`nextReadPath` 带来源包签名与 `sourceOffset`；同一读取实例交付全部来源且没有缺失
引用后才报告 `complete=true`。新角色跳过前页不会误报完整，来源变化会拒绝旧游标。
每条正文、条件、反证和显式依赖保留原样；交付计数不等于理解、复核或当前上下文仍
保有全文。压缩后可重新读取前页。单条记录超过最大预算时提供文件入口，不截断判断。
搜索排序仍采用完整来源包装包；延后项可沿精确 record 入口使用上述分页。

索引单位是完整作者判断块或一个公开记录。中文使用二元切词，英文保留接口标识、
camelCase、下划线及路径组成词，统一 Unicode 字宽；标题权重为正文的三倍，
词频／逆文档频率和长度归一化参与排名。精确的带类型 ID 优先，截短 ID 不作为
精确引用；引用字段、文件路径、哈希和运行字段不参与普通词法排名。

索引覆盖当前 Wiki 正文、页面／块的检索提示、祖先标题路径及公开事实、条件化尝试、Finding、计划和证据描述／元数据。
这个元数据索引不包含原始响应正文。原始正文由下述问题检索与原文入口按需读取；
旧作者版本、私有聊天／日志、其他任务和原 `webounty/` 不在检索范围内。
词法检索没有语义向量或跨语言翻译；另有基于显式类型与条件的 [原生链路发现](knowledge.md)。“未命中”不表示资料不存在或该边界已覆盖。
证据原件路径保留在结果中，使用原来的 read 精读；搜索本身不检查原件哈希。

存在活动缺口时，Decide／元认知优先使用具体缺口及其 needs；Execute 优先使用
当前 Step 自身或 revisits 指向的缺口。没有对应缺口时，Execute 使用当前 Step、
successSignal、缺失条件和 from；规划角色使用 Goal、触发原因及近期 Finding。
结果不会替换原来的公开黑板或自动给 Step 选方法。每个命中展开明确来源闭包，
保留事实替代、作者来源变化、身份／状态条件和相关 refutes 尝试。相关不等于支持，
来源未变化不等于仍然适用，Finding 评级和最终结论仍由原流程处理。

Execute 的自动检索上下文最多三个命中；`hits + records` 的 JSON 最多 8,000 字符。预算不足时
整体延后一个判断及其来源包，返回 `deferredCount` 和最多六个引用入口，不截掉
完整判断中的条件、否定或未知部分。通知、查询和路径字段在预算之外；这些是检索
上下文的装包限制，不修改模型 token／运行预算，也不是完整请求大小保证。
引用闭包很大时可以没有正文交付，应从精确引用或 Wiki 页面继续阅读。

## Wiki 表达、必要解释与目录

Execute 的原生 `wikiPages`（最终结果或 checkpoint）支持以下字段，示例与长度限制
见 [作者写入协议](../resources/wiki/authoring.md)。无需安装 Skill 或启动 Webounty。

| 字段 | 用途 | 事实与复核边界 |
| --- | --- | --- |
| 页面／块 `summary`, `questions`, `keywords`, `aliases` | 补充实际提问、关键词和别名，参与正文权重的词法排名 | 只帮助定位；问题不是答案，也不是缺口已解决 |
| 页面 `parentPageId` | 同任务父页面，`null` 为根；同批前向引用可用 | 目录只做导航；不继承父页结论，不把父页正文作为来源 |
| 块 `requiredBlockRefs: [{pageId, blockId}]` | 显式必要解释，检索时连同传递依赖及其完整来源装包 | 解释变化、删除或其来源待复核，会传递到依赖方；正文保持原样 |
| 省略 `blocks`，可带 `blockMetadata` | 只改页面／块标题、目录和检索提示 | 保留正文、sources、依赖及全部来源基线，不清除复核提示 |

父页面和必要块引用不能形成循环。新的完整判断必须引用存在的块；已有依赖方可在
目标块被删除后保留为待复核。精确读取和主动搜索在必要解释缺失时返回
`complete=false`，预算不足仍整体延后；不得把剩余来源包解释为已完整交付。

每个完整提交的块保存事实来源签名，以及传递必要解释的正文／来源／依赖签名。
标题和检索提示不进入事实签名。只有作者读取资料并重交完整页面才更新相应基线；
重交依赖方本身不能清掉被依赖解释未处理的来源变化。一个批次内先构建最终页面
集合再封存依赖，因此前后顺序不影响复核基线。完整页面更新保留省略的页面元数据，
但替换全部块；块内需要保留的检索字段和必要引用须一起传入。

页面与块 ID、文件路径保持稳定。祖先改名／移动会更新后代的导航、词项和资料提示，
不改后代作者修订及事实基线。目录、检索提示、依赖和旧版本保存在当前任务 SQLite；
Markdown、manifest、organization 与检索缓存均可重建。普通聊天继续与研究资料隔离。

本批验证与真实配置模型回放见 [Wiki 结构验证记录](wiki-structure-validation.md)。
观察对比已接入，见 [观察与复核](observation-comparison.md)。跨轮交接支持新增／变更
导航，并持久记录 removed／inactive 提示回执。本轮缓存、恢复和语义检索的验证见
[Wiki 与 RAG 优化验证](wiki-rag-optimization-validation.md)。

## 多前提查询与 Wiki 维护

存在显式 needs 时，默认缺口查询为每个输入建立独立检索组：type、已声明 aliases
和 description 分别作为备选表达，另保留 missing 的整体问题查询。各组取最好的
表达匹配，不累加同一输入的多个别名分数；精确记录引用优先，其余候选按输入组
交错合并并去重。各前提仍为 AND；表达候选只是检索入口，不改变能力组合条件。

自动 Execute RAG、question 原件／Wiki 检索及新原件关联缺口共用分组。显式传入
question 的 query 会覆盖自动分组，普通 wiki/originals/combined 搜索继续按用户
给定查询执行。接口不根据自然语言猜测模式，不自动生成别名。question 现在也能
召回仅在 Wiki 解释中存在的输入描述；普通 top-k 省略不再冒充缺失来源。
来源包因预算延后时返回 source_package_deferred；预算尚可增加时提供保留原 query
和 limit 的 nextReadPath。达到最大预算仍不完整时保留诊断，不能把再查同一请求
当成补全来源。原生精读入口继续核验完整原件，普通文件读取不计作原生校验。

命中 matches 标明 groupId、表达和 full_expression／partial_expression，Wiki
还区分 alias、title、metadata、body 或 combined_fields。full_expression 仅表示
该表达的全部词项被覆盖，不是语义等价、条件兼容或输入已满足。queryGroups 的
计数只报告候选交付，不能代替原件阅读和复核。原件 matchedTerms 只列实际返回
片段中的词项；全角标识与 UTF-8 原文定位仍返回准确的归档字节范围。

organization.json 增加 optional maintenance 导航：检索提示／问题缺失、长度超过
8,000 字符的判断、完全相同的正文，以及没有目录或必要解释连接的根页。每项附
精确 readPath；这些是可选写作建议，不是错误、缺失证据或可自动合并的结论。
目录独立可能合理，长判断不得为了缩短而丢失条件。元数据维护继续保留来源基线。
作者说明提供问题、观察、别名之间的边界。评测及模型验证见
[检索质量记录](retrieval-quality.md)。

## 围绕缺口检索原文

`gaps.items[].readPath` 和 `rag.questions[].readPath` 是当前任务的原生 read 入口，
例如 `xloom://question?stepId=S-...&gapId=gap-download`。Decide 只有 read 也能使用。
默认查询取自这个缺口的 missing、needs 类型、描述和 aliases，不拼入整个 Goal。
可在 URI 追加 URL 编码的 `query`，围绕一个尚缺输入补检索。

结果保留原问题、声明条件、候选材料、旧来源和命中文本的明确来源闭包，包括更正、
反证和适用状态；`answerSupport` 始终是 `not_assessed`。正文索引覆盖当前任务已
登记的归档原件：新增或变化时按 UTF-8 窗口流式读取并校验，未变化时复用词项；
交付命中片段前再次完整校验原件 SHA-256 和大小。不会只搜索摘要
或文件开头，也不会递归搜其他任务和运行日志。原文窗口以词项覆盖排名，与 Wiki
完整判断的词频索引分别处理；不宣称语义召回或保证命中所有等义表述。

命中附带原件 ID、原件哈希、字节起点／长度和 `xloom://original?...` 精读入口。
通过 read 读取该入口会再次校验完整原件，再返回原样文本及范围哈希。定位范围
最多 8 KiB，返回 omittedBefore/omittedAfter；按原件路径继续阅读上下文时保留原件
ID 和条件，不能把局部窗口当全文。正文是资料，不是新的系统指令。

原文命中同时附带 `contextReadPath`，在精确命中范围的前后各展开最多 1,024 字节，
用于检查片段附近的前提、身份／版本和否定条件。可在 original URI 中指定
`contextBytes=0–2048`（每侧上限），总范围不得超过 8,192 字节；默认不展开。
扩展边缘向内对齐 UTF-8 字符，保留完整命中；显式命中范围本身切断字符仍会报错。
`focusLocator` 保留原命中范围，`locator`、范围哈希和 `reading` 覆盖均对应实际交付
的扩展字节。CLI 对应 `read-original --context-bytes 1024`。每次仍校验完整原件，
不增加持久正文副本。邻近窗口可能遗漏远处的条件，仍需查看省略范围与来源包；
扩展会增加交付字节，不能据此宣称判断更准确。

Wiki／精确记录／能力发现返回的证据元数据现在同时提供 `originalReadPath`，可直接
精读已登记归档；`path` 仍是派生 Wiki 页面，`bodyIncluded=false` 表示本包没有原件
正文。省略 `byteLength` 时，原件入口从 `byteOffset`（默认 0）读取最多 4,096 字节，
自动适配短文件并在 UTF-8 字符边界结束；显式给出的定位范围仍严格校验，绝不悄悄
改写。`nextReadPath` 连续读取后文，`startReadPath` 返回前面省略的内容；
`sourceContextReadPath` 用于补取尚未交付的来源条件／更正。每次精读仍完整核对
哈希、大小与文件状态，包括重复范围。命中片段与默认首段均不能冒充整份证据。

空 stdout／stderr 或响应体允许按 0 字节原样归档。读取空原件时使用 `byteOffset=0`，
省略 `byteLength` 或设为 0；返回空正文、完整性校验结果且不产生下一页。空正文只表示
未输出字节，应结合原始命令、退出码或响应状态判断，不自动表示任务成功。

同一个原生 read 实例的 `reading` 提示跨 search／record／question／discover 的
资料重叠：`newRecords`、`repeatedRecords` 表示本角色实际收到的公开记录版本，
与检索词是否相同无关；仅黑板修订号变化不会令相同记录算作新资料。
`originalsWithUnreadBytes` 和 `nextOriginalReadPath` 指向本轮已见相关证据中尚未
通过 original 入口交付的字节。`fullyDeliveredOriginals` 只表示相应哈希版本的全部
字节曾交付，`repeatedOriginalRange` 表示本次范围曾交付；都不是已理解／已复核。
检索片段、文件路径、元数据与不完整来源包不计入原件精读覆盖。

这些提示只存在于本角色内，未写入 SQLite 或跨角色共享。正文仍完整返回，以支持
主动复查与上下文压缩后的补读；新角色重新读取自己的来源。提示在字符预算不足时
省略，不能挤掉必要来源。优化目标是让模型直接检查原件、避免换视图确认同一资料，
不是跳过完整性检查或强制禁止重复读取。真实 Chat／Run 回放见
[精读与模式验证记录](reading-modes-validation.md)。

缺失、二进制或非 UTF-8 原件、篡改、读取期间变化和链接越界均报告不完整，不返回
该原件的候选正文。显示预算不足时明确返回 budget_exhausted 或来源延后说明，
不能把空结果解释成不存在。相同 read 实例内，重复查询和相同资料会提示
stop_repeating_query；先精读、缩小缺口或取得新观察。该记忆只存在本轮内，
不阻止调用，也不自动解决缺口。跨轮资料提示记录与本轮重复查询提示分别保存。

读完后仍由 Decide 创建带 revisits 的有界 Step，或写 gapReviews；resolve 仍需
可校验原件支撑的 Facts。检索本身不改变旧 Step、Finding 级别和 Goal 状态。

无需已记录缺口的查询使用 `xloom://search?query=<URL编码查询>`。命令行同样支持：

```powershell
node dist/wiki/local.js question --task '<任务目录>' --workspace '<项目目录>' --step 'S-...' --gap 'gap-download'
node dist/wiki/local.js search-originals --task '<任务目录>' --workspace '<项目目录>' --query 'downloadGrant'
node dist/wiki/local.js read-original --task '<任务目录>' --workspace '<项目目录>' --evidence 'E-...' --sha256 '<原件哈希>' --byte-offset 0 --byte-length 1024
```

## 原生主动查询

所有研究角色都可用现有 read 主动查询，无需 PowerShell 或新工具。`rag.search`
给出可编辑的查询入口，`knowledge.discoveryReading` 和能力摘要提供发现入口：

```text
xloom://search?mode=wiki&query=BridgeNote
xloom://search?mode=originals&query=downloadGrant
xloom://search?mode=combined&query=downloadGrant&budgetChars=64000
xloom://discover?consumerId=C-download&budgetChars=64000
```

查询内容须 URL 编码。mode 必须显式选为 wiki、originals 或 combined，不根据
关键词猜模式。wiki 搜索当前作者判断和公开记录；originals 搜原件并附当前来源
与更正；combined 同时提供两者，保留各自的排名，不混加两种分数。均返回
`answerSupport: not_assessed`。无 mode 且无 budgetChars 的旧 search URI 继续
保持原来的 original_search 返回格式；仅提供 budgetChars 时使用 originals 模式。

原生新入口 limit 默认 3、范围 1–20；它限制原文窗口及额外 Wiki 命中数，必要来源
不计为额外命中。query 为 1–2048 字符。discover 的 consumerId 精确选择消费者，
提供者仍从全任务查找；省略时按 limit 返回最近消费者。maxAlternatives 默认 6、
范围 1–20，只限制展示的备选，求解仍检查其全部提供者。底层搜索沿用 2000 状态、
64 层限制，searchTruncated 不表示没有可行方案。

budgetChars 默认 16000、范围 1024–64000，按完整紧凑 JSON（含重复查询提示）
计算；工具详情的缩进展示、工具定义及消息封装不计在内。判断／候选与来源包一起
交付；装不下时返回 budget_exhausted，不先交付无来源的原件命中或候选结论。
可缩小 query、limit、consumerId，或增加 budgetChars 后继续。
预算失败包按剩余空间保留最多三个 deferredRefs 供 record／Wiki 文件导航；单个
来源闭包超过最大预算时，沿 record 的 nextReadPath 分批补读，不能原样重查。
底层 Wiki 结果中的 budgetDeferredCount
区分来源包预算不足；deferredCount 还包括超过命中条数的结果。完整交付选中的
材料可以 complete=true，同时仍有 top-k 省略；这不是全库穷尽、来源真实性或答案正确的声明。

Wiki 元数据检索与能力发现不校验全部原件；已声明的来源变化照常保留，精读原件
仍需 original 入口。原文搜索独立校验命中原件，篡改及缺失会报告 complete=false。
新入口沿用本轮重复查询提示，新的角色仍可重新读取同一资料；搜索和发现不推进
跨轮资料交接记录、不复核作者解释、不解决缺口，也不改变 Finding 或 Goal。

本批的真实模型回放、失败修正及重跑命令见 [原生入口验证记录](native-retrieval-validation.md)。

## 本地模块入口

每轮 Execute 的 `rag.local` 提供本机 Node、安装目录脚本、任务目录和按需说明：
[模块使用说明](../resources/wiki/local.md)。现有 powershell 可以运行：

```powershell
& '<nodeExecutable>' '<scriptFile>' search --task '<taskDirectory>' --workspace '<workspace>' --query '当前问题'
& '<nodeExecutable>' '<scriptFile>' search --task '<taskDirectory>' --workspace '<workspace>' --kind block --page 'WK-page' --id 'B-block'
& '<nodeExecutable>' '<scriptFile>' organize --task '<taskDirectory>' --workspace '<workspace>'
& '<nodeExecutable>' '<scriptFile>' audit --task '<taskDirectory>' --workspace '<workspace>'
```

脚本实际位于安装包 `dist/wiki/local.js`，不依赖启动终端所在目录。`search` 默认
最多六个命中，无字符上限，可显式指定 `--limit` 和 `--budget-chars`。长 JSON 输出
可通过现有 PowerShell 写到本轮 artifacts，再用 read 阅读。命令直接以只读方式打开
SQLite，不实例化 Controller，不抢锁、恢复运行或写研究状态；操作结束前检查黑板
是否变化，变化时拒绝发布结果。查询内容是资料，不是新指令。

## 整理、缓存与审计

Store 在已有投影步骤中生成 `wiki/search-index.json`、`wiki/organization.json`，
页面／索引先写，manifest 最后写，文件哈希随 manifest 发布。整理提供主题导航、
待复核块、缺失来源、替代事实、相同全文及未关联证据 ID；它不会按相似度合并、
删除材料或把作者旧来源标为已复核。作者修订仍通过原 `wikiPages`／checkpoint 提交。

任务目录 `cache/retrieval.sqlite` 保存可重建的词项缓存。元数据按记录签名复用分词，
新建／变化记录重新分词，移除的记录清理；正文按登记哈希、大小、路径和文件指纹
复用窗口词项，通过倒排表查询。缓存保存词项和位置，不保存原文副本或可信验证结论。
查询返回的公开记录、条件和更正始终从当前权威黑板构建；命中文本从当前原件读取。

`index` 反馈新增、重建、复用、移除、索引字节数与交付前原件校验数。缓存按任务及
工作目录隔离，损坏、不识别、版本不兼容或无法写入时保留原文件并退回内存计算。
缓存可在任务停止后移除并重建，不会删除资料交接记录。原文入口 `refresh=true`
或 CLI `search-originals/question --refresh` 强制重新扫描；元数据 CLI `search --refresh`
强制重新分词。热缓存未命中不是当次完整性审计，也不是“原文不存在该信息”的证明。

`wiki/search-index.json` 仍是公开投影，不作为查询的权威输入。投影生成复用元数据分词，
审计独立从权威数据重算。完整来源读取和大量命中仍需扫描原件，未宣称恒定查询成本。

`audit` 根据 SQLite 重新生成期望内容，核对 Wiki 页面、manifest、检索与整理文件，
流式校验已登记证据的完整 SHA-256／大小；不递归扫描未知目录，也不读私有运行日志。
文件／投影目录链接、原件越出登记归档目录、缺失和不一致会报告不可用。检查期间
比较文件状态和最后的黑板内容；这是当时的检查，不保证报告后文件不再变化。

状态为 `consistent` 时只表示文件／引用一致；`review_required` 表示作者来源需复核；
`unavailable` 表示缺失或不一致。脚本在前两者返回退出码 0，在 `unavailable` 返回 2，
运行失败或黑板变化返回 1。审计不修复原件、不改状态、不重放执行操作。

检索、整理和审计输出有 `generator: xloom-wiki-v1`、`evidence: false` 标记。保留
标记的副本不能提交为原始证据；该识别不能证明其他文件真实性或识别任意改写的叙述。

## 来源与验证边界

参考本地 Webounty 的 `search_index.py`、`rag.py`、`wiki.py` 及检索／Wiki 说明，
围绕 Xloom 数据模型重新实现；来源哈希见安装资源 `resources/wiki/provenance.json`。
另外参考 `evidence_io.py`、`question_context.py`、`context_views.py`、
`retrieval_index.py`、`metadata_cache.py` 和问题级检索说明，接入原文搜索、定位精读、
资料交接与增量词项索引。没有直接执行 Webounty Python，也没有移植独立会话系统；
本地 discover 提供候选组合，CVSS 已通过独立的原生评分模块接入，见 [CVSS](cvss.md)。
测试验证检索排序、完整来源包、隔离、投影、篡改检测及真实 Pi 工具交接；未评测
真实漏洞召回率、模型理解质量或大规模语料的性能。

## 新资料如何交给 Decide

每轮 Decide／元认知的 `materials` 只列出自上次成功规划以来未提示的资料版本，
包括事实、原件、能力、链路、Wiki 判断块和活动缺口。缺口、相关资料及修订优先。
导航标题最多 200 字符、每项最多三个关联问题入口；完整条件与判断从 `readPath`
读取，`relatedGapCount` 标明更多关联。原文候选关联最多检查三个未解决缺口，
每个缺口最多采用 20 个命中窗口；无关联标签不表示没有关联，应继续读问题入口。

交接默认按完整 JSON 的 6,000 字符预算装包，未交付项计入 `deferredCount`。
`read("xloom://materials?budgetChars=64000")` 继续装包；同轮已提示版本不重复返回，
`refresh=true` 可重新查看全部导航。单次预算范围 1,024–64,000 字符。
Decide 的 `rag` 在此模式下只给问题导航，避免再附上一份重复的自动检索正文。

卡片的 `xloom://record?kind=...&id=...` 读取当前完整记录及明确来源闭包；Wiki 块
还带 `page`。原件记录会连同引用它的事实、更正一起返回。记录读取默认预算 16,000，
可增加到 64,000；仍放不下时按完整记录分批交付，通过 `nextReadPath` 继续读取。
单条完整记录超限时再使用原件或 Wiki 文件入口，不能把空包当作已读取。

`blackboard.sqlite` 的 `material_receipts` 保存键和资料签名，并与成功的规划决定
在同一事务提交。提示未装入、读取未完整交付、规划失败或取消都不推进相应记录。
重新打开同一任务沿用记录；新任务独立。它只表示“成功规划轮次收到过导航”，
不表示读懂、复核或解决。每个新 Decide 仍须按需读取未变化的原文。
只有 `revisits`／`gapReviews` 和后续事实决定复核与选步。

终端以分段中文显示交接数量、关联问题入口、未交付项及索引／校验统计；原工具
结构化输出继续保留在工具详情和运行记录中。显示变化不改变模型收到的资料正文。

2026-09-14 使用已配置的 `opencode-go/deepseek-flash` 做过一次隔离的本地样本验证：
模型实际读取问题入口和原件定位入口，创建了带 revisits 的步骤，未提前宣布完成，
工具错误为 0。共 3 次模型请求，输入 19,725、输出 1,921 tokens。该单例验证接口
确实能被当前模型使用，不代表真实任务召回率或模型选择稳定性已得到评测。

同日新增资料交接后，使用同一配置模型验证四类入口：materials、record、question、
original。第一次把“验证接口”本身写成根目标，模型读完全部入口并创建 revisit，
但同时提出 conclusion，未通过“不结束任务”的断言。将根目标改为实际未完成的
本地下载验证后，第二次全部读取成功，生成 revisit 且无 conclusion，工具错误 0；
3 次请求，输入 24,015、输出 1,579 tokens。两次均为隔离的合成文件样本；这也说明
目标表述会影响选步，检索接通不能代替模型判断验证。普通 Decide 的结束建议仍受
既有 Controller 的新鲜元认知复核门控约束，不直接结束真实任务。

## 观察比较及当前检索优化

原有 read 支持 `xloom://compare?left=<Evidence ID>&right=<Evidence ID>`，可附 URL 编码
的 `fields` JSON 点路径数组。它完整校验所选 JSON 归档，返回差异和缺口，不生成结论。
Fact/Attempt/Finding 来源包保留相关冲突、更正和待复核信息。

元数据检索现在使用单次读取内的关系索引和批量缓存读取；完整查询词命中优先于局部
单词命中，精确 ID 仍优先。正文、反证、条件和遗漏语义保持完整。实现取舍、测量方法
及性能数据见[观察比较与复核](observation-comparison.md)。

## 持久缓存与进程内复用

检索缓存 v2 在原任务 `cache/retrieval.sqlite` 中启用 WAL、事务发布及按记录删除的
词项索引；属于当前任务的 v1 缓存自动升级，其他任务或损坏的文件保留并绕过。
原件扫描、校验和候选计算先完成，再短事务发布词项；热查询不预占 SQLite 写锁。
写入竞争或失败会回滚派生更新并从原始资料重算，不改变正式黑板。

元数据索引还复用按内容签名检查的进程内快照。每次查询检查来源内容与缓存文件／WAL
指纹，不仅依赖 boardRevision；原地修改快照、外部改动缓存、refresh 都会失效。
最多保留 4 个任务、估算序列化大小合计 32 MiB，单索引超过 16 MiB 不保留；实际堆内存
会高于序列化大小。返回的共享索引内部不可修改，原黑板保持可修改。重启后从持久词项
恢复，原件命中仍重新核验完整哈希，未缓存正文或完整性判定。

Wiki 的进程内页面缓存按记录内容、来源状态、必要解释和目录路径失效。未变化页面
复用渲染正文，但发布前仍检查实际文件，手改的生成页会被修复；审计始终独立完整重建
预期内容。页面缓存最多 4 个任务，序列化正文合计 32 MiB，重启后可完整重建。
`projection-state.json` 在写入前标记 building，所有文件与 manifest 发布完成后才标记
ready 并绑定修订和 manifest 哈希。文件使用临时文件刷新后替换；中断后下次打开／更新
会重建。任务中的普通 Wiki 文件读取拒绝未完成或过期投影，原生 search/record 继续
读取 SQLite。只移除旧 manifest 登记、路径合法且正文哈希未变的过期生成页。

资料交接还报告 removed 记录和 inactive 缺口。移除通知的签名沿用既有 SQLite
material_receipts 事务保存；已提示的移除不重复通知，重新出现的记录再次提示变化。
未装入预算或失败的规划仍不推进回执。removed/inactive 是导航状态，不代表已复核、
缺口已解决或证据文件已删除。

## 模型辅助语义检索

研究角色可在已有 `read` 的 search/question URI 上添加 `strategy=semantic`。
`rag.search.semanticReadPath` 和问题卡片的 `semanticReadPath` 提供入口；不带 strategy
或使用 `strategy=lexical` 保持本地词法检索。普通聊天不接入研究资料。

仅由已知记录 ID 或 Wiki 页/块 ID 组成的 `mode=wiki` 查询直接本地读取，返回
`semantic.status=exact_reference_local`，不扩展、不生成提示、不重排；混有问题正文时仍按请求策略处理。
其余语义入口先扩展每个原始查询组，再为当前 Wiki 判断生成中英文检索问题，并对候选
完整判断／来源闭包及已校验原件片段进行相关性评分。沿用原始表达和分组，不把 AND
前提改成 OR；精确 ID 优先，并为各显式前提保留候选。模型不能添加来源 ID、修改正文、
消除复核状态或宣布证据有效。最终正文由原有原生读取器交付，原件重新完整校验。
`semantic_hint` 区分由派生检索问题带来的命中；问题不是事实，重排分数不是可信度。
评分约定为无关内容或仅泛词重合记 0 分，1–100 分用于与问题直接相关的信息（包括反例）。
模型明确给 0 分的候选不再作为普通命中交付，`zeroScoreCandidates` 记录这类评分数量。
精确引用、问题自身的来源锚点及命中判断的必要来源／条件不受该过滤影响；未评分项仍可
按词法候选返回。没有相关候选不表示证据不存在，也不自动解决缺口。

每个判断的派生检索问题按模型身份和完整来源内容签名存入任务缓存 `semantic-doc`，
仅处理新增／变更项并清理已移除项。每次读取按当前查询候选优先补全，最多处理 8 个
未缓存判断，序列化索引输入不超过 48,000 字符；后续读取逐步补全其余项。查询改写和候选评分存入 `semantic`，最多保留
512 项；重排键包含模型身份、查询、语料签名和完整候选。缓存只保存检索问题与评分，
不保存原件正文、作者基线或证据有效性结论。取消前成功生成的派生项可供后续复用。

模型调用通过现有 Pi stream 完成，没有新会话或执行工具，实际用量和请求计数并入
当前研究轮次；已有显式运行上限仍生效，并保留最后一次提交请求。每次读取最多调用
一次扩展、一次索引、一次重排。重排最多 12 个候选，完整序列化输入不超过 48,000 字符。
完整来源闭包超限时整项延后，未打分项保留词法位置；不会截断条件或必要解释。
`deferredDocuments` / `deferredCandidates` 包括预算延后项，`oversizedDocuments` /
`oversizedCandidates` 单列无法装入一次请求的项。超模型容量、无模型、非法响应或调用失败时
报告词法降级；读取过程中来源变化也会废弃旧重排。扩展和重排完成不表示模型已阅读
或理解原件。首次语义索引／陌生查询会等待网络模型；缓存命中和普通词法延迟分开测量。

索引、改写和打分采用独立的 low 推理强度，由 Pi 映射到模型支持的级别；研究角色的
主请求继续使用项目配置。该选择用于缩短结构化处理的等待，模型身份缓存包含此配置。
每个辅助调用有 120 秒故障看门狗；用户取消立即传递，超时返回明确降级。这个时限不是
金额或 token 预算。semantic.requests 记录辅助调用尝试次数，实际 stream 用量另计入
研究运行统计。`semantic.stages` 分别列出 expand/index/rerank 的 requests、cacheHits、
inputChars、elapsedMs；字符数只计传给模型适配器的 JSON 数据，时长只计模型调用，
不等于实际计费 token、完整提示词长度或整个读取耗时。

冷热检索测量、真实配置模型回放及失败记录见
[Wiki 与 RAG 优化验证](wiki-rag-optimization-validation.md)。

## 历史导航与召回边界

`xloom://history?kind=fact` 和 `kind=attempt` 分页列出全部历史记录，每条携带精确
`readPath`。默认 limit=40（1–100），budgetChars=16000（1024–64000）。继续阅读时
使用返回的 nextReadPath，它含 offset 和内容 signature；导航变化会返回 history_changed
并要求从头读取。历史索引是导航，不推进资料复核或证据读取回执。

查询会排除 what/is/the/for 等常见英文虚词，同时保留否定、错误码、中文词和完整技术
标识。只有虚词的原件查询会提示无可检索词，应补充实体或条件；Wiki 查询以
`matchQuality=no_informative_match` 表示无有效候选，不能据此判定事实不存在。
`ignoredQueryTerms` 显示被忽略的词。

Step 所属 Goal 和 Goal 的父目录通过 navigation 表达，不因共享 Goal 就扩展其他 Fact。
明确引用 Goal 本身仍返回其声明的事实；真实因果输入、更正、反证、必要 Wiki 块继续
完整交付。缺失目录引用与缺失证据来源分别报告为 missingNavigation 和 missingSources。
本次离线回归和范围限制见 [上下文维护验证](context-maintenance-validation.md)。
