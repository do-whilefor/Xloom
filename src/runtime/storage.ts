import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { atomicJson, xloomHome } from "../paths.js";
import { FileLock } from "../lock.js";

/** Import once, never overwrite Xloom credentials or resurrect a logged-out account. */
export function importPiSettings(source = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent")): void {
  const home = xloomHome();
  const marker = path.join(home, "pi-import.json");
  if (existsSync(marker)) return;
  const lock = new FileLock(path.join(home, "locks", "pi-import.lock"));
  try {
    if (existsSync(marker)) return;
    const copied: string[] = [];
    for (const [name, destination] of [["auth.json", path.join(home, "auth.json")], ["models.json", path.join(home, "models.json")],
      ["models-store.json", path.join(home, "cache", "models-store.json")]]) {
      const original = path.join(source, name);
      if (!existsSync(original) || existsSync(destination)) continue;
      try { JSON.parse(readFileSync(original, "utf8")); }
      catch { throw new Error(`Xloom could not import ${name}: invalid JSON. Original files were retained.`); }
      mkdirSync(path.dirname(destination), { recursive: true });
      try { copyFileSync(original, destination, constants.COPYFILE_EXCL); copied.push(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    atomicJson(marker, { version: 1, source: path.resolve(source), copied });
  } finally { lock.close(); }
}

export function modelRuntimePaths(): { authPath: string; modelsPath: string; modelsStorePath: string } {
  // An explicitly isolated home must never silently import the real user's credentials.
  if (process.env.XLOOM_HOME === undefined) importPiSettings();
  const home = xloomHome();
  mkdirSync(path.join(home, "cache"), { recursive: true });
  return { authPath: path.join(home, "auth.json"), modelsPath: path.join(home, "models.json"), modelsStorePath: path.join(home, "cache", "models-store.json") };
}
