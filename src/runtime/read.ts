import { constants } from "node:fs";
import { access, opendir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createReadTool, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { createTaskReader, type TaskReadContext } from "../wiki/read.js";
import { retrievalFeedback } from "../wiki/feedback.js";
import { assertWikiProjectionReady } from "../wiki/projection.js";
import { createSemanticTaskReader } from "../wiki/semantic.js";

const maxDirectoryEntries = 200;
const maxDirectoryBytes = 16 * 1024;
const artifactPrefix = "artifact://";

function artifactReadPath(path: string, artifactsDirectory: string): string {
  const suffix = path.slice(artifactPrefix.length).replaceAll("\\", "/");
  if (suffix.startsWith("/") || suffix.includes(":") || suffix.split("/").includes("..")) {
    throw new Error("artifact:// requires a relative path inside this run's artifacts directory; parent traversal and absolute paths are not supported.");
  }
  // This is an explicit prefix, never a fallback for a missing workspace path.
  // Names are literal: no URL decoding, fuzzy matching or cross-run searching.
  return resolve(artifactsDirectory, suffix);
}

class DirectoryRead extends Error {
  constructor(readonly path: string) { super("Directory read"); }
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Operation aborted");
}

async function nearestExistingParent(path: string, signal?: AbortSignal): Promise<string | undefined> {
  let parent = dirname(path);
  while (true) {
    checkAbort(signal);
    try {
      const info = await stat(parent);
      checkAbort(signal);
      if (info.isDirectory()) return parent;
    } catch (error) {
      checkAbort(signal);
      // An inaccessible ancestor cannot establish which parent exists. Keep
      // the original read failure instead of replacing it with this diagnostic.
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code))) return;
    }
    const ancestor = dirname(parent);
    if (ancestor === parent) return;
    parent = ancestor;
  }
}

async function listDirectory(path: string, offset = 1, limit = maxDirectoryEntries, signal?: AbortSignal) {
  checkAbort(signal);
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Directory offset and limit must be positive integers (offset is 1-indexed).");
  }
  const pageSize = Math.min(limit, maxDirectoryEntries);
  const lines: string[] = [];
  let seen = 0;
  let bytes = 0;
  let hasMore = false;
  const directory = await opendir(path);
  try {
    while (true) {
      checkAbort(signal);
      const entry = await directory.read();
      checkAbort(signal);
      if (!entry) break;
      seen++;
      if (seen < offset) continue;
      // Dirent types require no stat of children, so linked directories are not followed.
      const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      const line = `[${kind}] ${JSON.stringify(entry.name)}`;
      const size = Buffer.byteLength(line, "utf8") + 1;
      // Reserve room for the header and continuation/evidence notices.
      if (lines.length >= pageSize || bytes + size > maxDirectoryBytes - 512) {
        if (lines.length === 0) throw new Error("Directory entry exceeds the listing byte limit.");
        hasMore = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    await directory.close();
  }
  checkAbort(signal);
  if (seen > 0 && offset > seen) throw new Error(`Offset ${offset} is beyond end of directory (${seen} entries total).`);
  if (seen === 0 && offset > 1) throw new Error(`Offset ${offset} is beyond end of directory (0 entries total).`);
  const nextOffset = offset + lines.length;
  const notice = seen === 0 ? "(empty directory)"
    : hasMore ? `[Truncated: showing entries ${offset}-${nextOffset - 1}. Use offset=${nextOffset} to continue.]`
    : `[Showing entries ${offset}-${nextOffset - 1}; end of directory.]`;
  return {
    content: [{ type: "text" as const, text: [
      "Directory entries (non-recursive; filesystem order; names are JSON strings):",
      ...lines,
      notice,
      "This listing does not establish that planned artifacts were created; read the exact artifact files.",
    ].join("\n") }],
    details: { directory: true, offset, entries: lines.length, truncated: hasMore, ...(hasMore ? { nextOffset } : {}) },
  };
}

/** Keep Pi's path resolution and file/image handling; add discovery for read-only stages. */
export function createWorkspaceReadTool(workspace: string, artifactsDirectory?: string, task?: TaskReadContext) {
  const tool = createReadTool(workspace, { operations: {
    readFile,
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
    async access(path) {
      await access(path, constants.R_OK);
      if ((await stat(path)).isDirectory()) throw new DirectoryRead(path);
    },
  } });
  const execute = tool.execute;
  const readTask = task && createTaskReader(workspace, task);
  const readSemantic = task && readTask && createSemanticTaskReader(workspace, task, readTask);
  tool.description = "Read text/images or list immediate directory entries. Files: 2000 lines/50KB. Directories: 200 entries/16KB; no recursion. Use 1-indexed offset/limit to page lines or entries. Verify exact paths; planned files may not exist.";
  if (artifactsDirectory) tool.description += " For this run's artifacts, prefer artifact://<exact relative filename>; artifact:// lists them. This prefix is read-only; writes and evidence submissions use filesystem paths.";
  if (readTask) tool.description += " Read xloom://materials/history/record/question/search/original/discover paths from task context. search?mode=wiki|originals|combined&query=<encoded query>; discover?consumerId=<ID>. compare?left=<Evidence ID>&right=<Evidence ID>&fields=<encoded JSON dot-path array> compares verified JSON originals; differences are not verdicts. URI parameters control retrieval; offset/limit here apply to filesystem reads only. Wiki files are derived. Follow evidence.originalReadPath and nextReadPath for archive bytes; reading tracks remaining bytes. Delivery is not review.";
  if (task?.semantic) tool.description += " Add strategy=semantic to search/question for model query expansion and source reranking; plain searches stay lexical. Fallback is reported.";
  tool.execute = async (id, params, signal, onUpdate) => {
    checkAbort(signal);
    if (params.path.startsWith("xloom://")) {
      if (!readTask) throw new Error("Task original retrieval is unavailable outside a research task");
      if (params.offset !== undefined || params.limit !== undefined) throw new Error("Use the xloom URI parameters for retrieval, not filesystem offset/limit");
      const result = await readSemantic!(params.path, signal); checkAbort(signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { nativeRetrieval: true, retrievalFeedback: retrievalFeedback(result) } };
    }
    if (artifactsDirectory && params.path.startsWith(artifactPrefix)) {
      params = { ...params, path: artifactReadPath(params.path, artifactsDirectory) };
    }
    if (task) {
      const rel = relative(resolve(task.dataDir, "wiki"), resolve(workspace, params.path));
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) assertWikiProjectionReady(task.snapshot(), task.dataDir);
    }
    try {
      return await execute(id, params, signal, onUpdate);
    } catch (error) {
      if (error instanceof DirectoryRead) {
        try {
          return await listDirectory(error.path, params.offset, params.limit, signal);
        } catch (listingError) {
          error = listingError;
        }
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        checkAbort(signal);
        // Native filesystem errors retain the exact path Pi already resolved.
        // Use that call's error, not shared state or another path resolver.
        const failedPath = (error as NodeJS.ErrnoException).path;
        const parent = typeof failedPath === "string" && isAbsolute(failedPath) ? await nearestExistingParent(failedPath, signal) : undefined;
        error.message += parent
          ? `\nNearest existing parent directory: ${JSON.stringify(parent)}. Read this directory to discover exact names; do not guess or retry the same missing path.`
          : "\nRead an existing parent directory to discover exact names; a planned artifact may not have been written yet. Do not guess or retry the same missing path.";
        if (artifactsDirectory) error.message += '\nFor this run\'s artifacts, read path="artifact://" to discover exact filenames, then read path="artifact://<filename>". Do not reconstruct task/run IDs; no alternative file was read.';
      }
      throw error;
    }
  };
  return tool;
}
