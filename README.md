<h1 align="center">Xloom</h1>

<p align="center"><strong>Xloom</strong> 是一个在本地终端运行的 AI 安全研究助手。</p>
<p align="center">普通聊天 · 双 Agent 协作 · 证据归档</p>

直接输入文字即可聊天，使用 `/run 目标` 启动独立的研究任务。**Decide** 负责规划和复核，**Execute** 使用文件、PowerShell 和 Chrome 工具完成调查，通过共享黑板保存事实、进度和证据。

---

## 快速开始

### 安装并运行 Xloom

需要 **Windows、Git、Node.js 24+ 和 PowerShell 7**。请确保 `pwsh.exe` 在 PATH 中，推荐使用 Windows Terminal。

在 PowerShell 中从源码安装：

```powershell
git clone https://github.com/do-whilefor/Xloom.git
Set-Location Xloom
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

安装后，在你的工作目录中运行：

```powershell
xloom
```

<details>
<summary>直接从源码运行与开发检查</summary>

在仓库目录中，也可以直接启动：

```powershell
npm start
```

修改源码后，重新构建即可更新已链接的 `xloom` 命令：

```powershell
npm run build
```

运行类型检查和构建：

```powershell
npm run check
```

</details>

### 配置模型

认证沿用当前 Pi 的原生模式：输入 `/login`，先选择账号登录或 API Key，再选择供应商；也可以使用 `/login <供应商 ID 或名称>` 直接进入该供应商的接入流程。供应商列表中按 Esc 返回接入方式。接入后使用 `/model` 选择模型，默认统一设置聊天、Decide 和 Execute；也可以通过 `/model chat`、`/model decide`、`/model execute` 分别配置。

例如 `/login openai-codex` 使用 ChatGPT 账号授权，`/login openai` 配置独立计费的 OpenAI API；`/login kimi-coding` 可选择账号登录或 key，智谱国内 Coding Plan 使用 `/login zai-coding-cn`。实际可用权益由供应商账号和接入政策决定。登录窗口支持复制授权链接、设备码和手动回调，凭据不进入聊天和命令历史。

每个供应商只保存一份当前凭据。新 key 保存成功后立即替换该供应商的旧 key 或登录凭据，后续请求使用新凭据，不保留旧 key 的历史或备份；其他供应商不受影响。新凭据写入成功前不会先删除旧凭据。输入 `/logout` 后选择供应商即可移除其本地凭据，环境变量和 models.json 中的配置不受此操作影响。Xloom 不再提供独立的 `/apikey` 命令，认证输入和凭据解析交给 Pi 的供应商实现处理。

API Key 按供应商分别保存。例如 `opencode-go`（OpenCode Go）、`opencode`（OpenCode Zen）、`deepseek`（DeepSeek）是不同的接入入口；保存某一家的 key 不会自动配置其他入口。保存成功表示已写入本地凭据存储，实际可调用的模型和额度仍由该供应商的账户权限决定。

配置与运行数据默认保存在用户目录的 `~/.xloom/` 中。使用 `/paths` 查看实际位置，或将环境变量 `XLOOM_HOME` 设为其他数据目录的绝对路径。

### 开始研究

在交互界面中输入目标、授权范围和完成条件：

```text
/run 检查已授权项目的服务端权限边界，保留原始证据并生成结论报告；完成后停止。
```

任务的完成提议会经过独立复核。运行中可使用 `/hint 文字` 补充信息、`/pause` 暂停或 `/stop` 停止，已提交的证据和进度会保留。

每次启动进入新的聊天。要继续历史研究任务，先用 `/tasks` 查看任务，再用 `/open 任务ID` 选择，最后输入 `/start`。使用 `/help` 查看全部命令与快捷键。

在终端中运行 `xloom status` 查看已保存的任务状态，运行 `xloom report` 输出 Markdown 报告。

## 资料

- [**配置示例**](xloom.example.json)
- [**工具执行与 HTTP 请求**](resources/runtime/execution.md)
- [**PDF 文档**](refer/papers/arxiv.pdf)

Xloom 仅用于已授权的安全研究。工具以当前用户的系统权限执行，研究结论需要结合原始证据复核。

本项目采用 [MIT License](LICENSE)。
