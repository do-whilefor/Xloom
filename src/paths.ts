import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Evidence } from "./types.js";

export function xloomHome(): string {
  const configured = process.env.XLOOM_HOME;
  if (configured === undefined) return path.join(homedir(), ".xloom");
  if (!configured.trim() || !path.isAbsolute(configured)) throw new Error("XLOOM_HOME must be an absolute directory path.");
  return path.normalize(configured);
}

export function workspaceIdentity(workspace: string): { id: string; workspace: string } {
  const canonical = realpathSync(workspace);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return { id: createHash("sha256").update(identity).digest("hex"), workspace: canonical };
}

export function projectDirectory(workspace: string): string {
  return path.join(xloomHome(), "projects", workspaceIdentity(workspace).id);
}

export function workspaceLockPath(workspace: string): string {
  return path.join(xloomHome(), "locks", `${workspaceIdentity(workspace).id}.lock`);
}

export function projectConfigPath(workspace: string): string { return path.join(projectDirectory(workspace), "settings.json"); }
export function globalConfigPath(): string { return path.join(xloomHome(), "settings.json"); }

export function ensureProject(workspace: string): string {
  const identity = workspaceIdentity(workspace);
  const directory = projectDirectory(workspace);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "project.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.version !== 1 || saved.id !== identity.id || workspaceIdentity(saved.workspace).id !== identity.id) {
      throw new Error(`Workspace registry mismatch: ${file}`);
    }
  } else {
    atomicJson(file, { version: 1, ...identity, name: path.basename(identity.workspace) });
  }
  return directory;
}

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}

/** Stored archive paths are task-relative. Legacy fixtures retain their workspace base. */
export function evidencePath(evidence: Evidence, dataDir: string, workspace: string): string {
  return path.resolve(evidence.pathBase === "task" ? dataDir : workspace, evidence.path);
}
