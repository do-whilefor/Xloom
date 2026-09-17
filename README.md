<h1 align="center">Xloom</h1>

<p align="center"><strong>Xloom</strong> 是一个在本地终端运行的 AI 安全研究助手。</p>
<p align="center">普通聊天 · 双 Agent 协作 · 证据归档</p>

**简体中文** | [English](README.en.md) | [한국어](README.ko.md)

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

### 开始研究

在交互界面中输入目标、授权范围和完成条件：

```text
/run 检查已授权项目的服务端权限边界，保留原始证据并生成结论报告；完成后停止。
```

任务的完成提议会经过独立复核。运行中可使用 `/hint 文字` 补充信息、`/pause` 暂停或 `/stop` 停止，已提交的证据和进度会保留。

每次启动进入新的聊天。要继续历史研究任务，先用 `/tasks` 查看任务，再用 `/open 任务ID` 选择，最后输入 `/start`。使用 `/help` 查看全部命令与快捷键。

在终端中运行 `xloom status` 查看已保存的任务状态，运行 `xloom report` 输出 Markdown 报告。

## 资料

- [**全局配置示例**](settings.example.json)
- [**工具执行与 HTTP 请求**](resources/runtime/execution.md)
- [**PDF 文档**](refer/papers/arxiv.pdf)

Xloom 仅用于已授权的安全研究。工具以当前用户的系统权限执行，研究结论需要结合原始证据复核。

本项目采用 [GNU Affero General Public License v3.0（AGPL-3.0）](LICENSE)。
