<h1 align="center">Xloom</h1>

<p align="center"><strong>Xloom</strong> is an AI security research assistant that runs in your local terminal.</p>
<p align="center">Chat · Two-agent collaboration · Evidence archiving</p>

[简体中文](README.md) | **English** | [한국어](README.ko.md)

Type a message to chat, or use `/run <goal>` to start a separate research task. **Decide** plans and reviews the work; **Execute** investigates using file, PowerShell, and Chrome tools. They share a blackboard that stores facts, progress, and evidence.

---

## Quick start

### Install and run Xloom

Requires **Windows, Git, Node.js 24+, and PowerShell 7**. Make sure `pwsh.exe` is on your PATH. Windows Terminal is recommended.

Install from source in PowerShell:

```powershell
git clone https://github.com/do-whilefor/Xloom.git
Set-Location Xloom
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

After installation, run this in your working directory:

```powershell
xloom
```

<details>
<summary>Run from source and check the build</summary>

You can also start Xloom directly from the repository directory:

```powershell
npm start
```

After editing the source, rebuild to update the linked `xloom` command:

```powershell
npm run build
```

Run type checking and the build:

```powershell
npm run check
```

</details>

### Start researching

Enter your goal, authorized scope, and completion criteria in the interactive interface:

```text
/run Check server-side authorization boundaries in the authorized project, preserve the original evidence, and produce a findings report. Stop when complete.
```

A proposed task completion receives an independent review. While a task is running, use `/hint <text>` to add information, `/pause` to pause, or `/stop` to stop. Committed evidence and progress are preserved.

Each launch starts a new chat. To resume a previous research task, list tasks with `/tasks`, select one with `/open <task-id>`, then enter `/start`. Use `/help` to see all commands and shortcuts.

Run `xloom status` in your terminal to inspect saved task status, or `xloom report` to output a Markdown report.

## Resources

- [**Global configuration example**](settings.example.json)
- [**Tool execution and HTTP requests**](resources/runtime/execution.md)
- [**PDF document**](refer/papers/arxiv.pdf)

Xloom is intended only for authorized security research. Tools run with your current user's system permissions. Verify research findings against the original evidence.

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
