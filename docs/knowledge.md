# 原生能力与链路

Xloom 将 Webounty 的能力供需、组合前提和来源复核思想接入既有研究 task。
实现位于 `src/knowledge/`，使用原 SQLite、Execute 最终输出和 checkpoint；没有
引入 Webounty 会话引擎、第二份 state.json、Python 依赖、新 Agent 或新工具。

## 记录与来源

`BoardSnapshot.capabilities/chains` 是可选集合；旧任务无需数据库结构迁移，打开
后按已有资料重建投影，不推断缺少的能力。Execute 按需阅读安装资源
[编写说明](../resources/knowledge/authoring.md)，提交带稳定 ID 的完整记录。
同批 Fact 局部 ref 由 Store 映射；跨任务或缺少原始证据的来源被拒绝。

能力记录 provides、needs、身份/范围/环境/会话代次、来源和反证 Fact。
链记录拓扑顺序、端口连接、各边实际消费依据、共同条件和最终结果 Fact。
未知条件统一为 `null`；空白、`unknown`、`unspecified`、`not_recorded`、`未知`、
`未记录`、`未确认` 等占位表达也按未知处理，包括读取旧记录时。两端未知不代表
匹配；不适用标签不是通配符，真实身份、路径和版本仍区分大小写。
变更保留原声明、来源签名与历史；普通聊天、私有 run 消息不成为知识来源。
非法提交回滚整批状态、用量和事件，之前的 checkpoint 保留；证据归档行为沿用
原流程，拒绝的批次可能留下未引用文件，不自动删除原件。

## 候选发现与复核

每次研究调用新增 `knowledge` 结构化上下文，包含记录摘要、Wiki 路径、待复核
信息和候选组合。角色 system prompt、工具列表及完成条件保持原设计。
类型/显式 aliases 经 Unicode 规范化与小写处理后精确匹配，不进行词面模糊配对。
所有 needs 为 AND；一个输入的提供者为 OR。搜索递归补齐提供者的前提，并在
分支之间回溯检查共同条件，处理共享输入与循环；各输入分别有提供者仍可能无整链方案。

条件值按原文精确比较；null 是未知，不当作已知兼容。当前模型较保守，不能表达
任意身份转换、时间区间重叠、范围包含关系或推断环境等价。可用性由作者依据新
观察显式更新，程序不会因当前时间自动认定凭据过期。

`requirementsCovered` 仅表示找到一个声明前提被覆盖的代表方案；须同时查看
未知条件、未验证能力和 `actualConsumption: not_assessed`。候选输出固定
`evidence:false`，不能直接归档为原始证据、改变评级或完成 Goal。

自动上下文选择最近六个消费者，每个输入先显示六个备选；搜索仍考虑其全部提供者。
记录与组合按完整条目装入 12,000 字符预算，延后项保留页面入口。提示、路径、
省略清单和 JSON 容器开销不在该条目预算内，它不是模型 token 上限。
候选搜索默认最多 2000 个展开状态、64 层依赖，达到限制会标记 searchTruncated；
无方案不证明不存在可行路径。现有 powershell 可运行本地 `discover` 命令取得
全部消费者与备选，但同样有搜索状态限制；该模块不访问目标或修改任务。

来源 Fact 修订会沿显式依赖影响能力、链和 Wiki，显示待复核而保留历史声明。
读取、重启或通过完整性审计不会表示已复核；重新确认后显式提交当前来源。
Controller 在 Execute 结算后检测能力/链变化，并请求 fresh Decide 元认知；原来的
受阻、技术命中和事实修正触发优先。仅修订知识文字不增加研究进展计数。

## 验证与使用

能力和链自动生成 Wiki 页面，并参与原词法 RAG 的完整来源包。`organize`、`audit`
也报告它们的待复核状态。`search --kind capability --id C-...` 或 `--kind chain
--id CH-...` 精确补查；`discover --task ... --workspace ...` 为只读候选发现。

Decide、Execute 和元认知也可直接 `read("xloom://discover?consumerId=C-...")`。
`knowledge.discoveryReading` 提供入口，每个能力摘要附带 discoverReadPath。
consumerId 精确选择一个当前任务消费者，仍使用全部任务能力寻找提供者；省略时
默认返回最近三个消费者，未显示的消费者 ID 保留在结果中。候选计划与完整来源包
一起交付，保留未知条件、来源变化、未验证能力和搜索限制。没有声明 needs 的能力
返回空候选及自身来源，不视为已验证结果。使用说明见 [原生查询](retrieval.md#原生主动查询)。

验证覆盖事务回滚、同批引用、checkpoint 幂等、SQLite 重开、来源变化、Wiki/RAG
传播、AND/OR 回溯、共同条件、未知/循环/缺失前提，以及真实 Controller + Pi
文件工具的跨角色交接。供应商响应使用合成流，不代表真实模型会正确选取能力、
发现漏洞或验证链路，也未完成大规模语料性能评测。

本阶段参考本地 Webounty 的 `references/retrieval.md`、`references/storage.md`
和能力发现/组合脚本的设计，围绕 Xloom 数据模型重新实现；不运行原脚本。全文
原文索引、增量缓存、CVSS 及[观察比较器](observation-comparison.md)已原生接入。
