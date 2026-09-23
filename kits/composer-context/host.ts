import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostCommandError, commandInvocation, gitExecutable, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import {
  COMPOSER_CONTEXT_ID,
  EMBED_TEXT_BYTES,
  MAX_FILE_BYTES,
  type DescribedAttachment,
  type PullRequestSummary,
  type ReadFileRequest,
  type ReadFileResult,
} from "./protocol.js";

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const line = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** The folder a draft's attachments go to: the thread id, or the draft's id before the thread exists. */
export function attachmentFolder(scope: string): string {
  const session = /^session:(.+)$/u.exec(scope)?.[1];
  const draft = /^new:.*:([^:]+)$/u.exec(scope)?.[1];
  const segment = (session ?? draft ?? scope).replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return segment || "draft";
}

export function safeFileName(name: string): string {
  const cleaned = basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/^[.\s-]+/u, "").slice(0, 120);
  return cleaned || "attachment";
}

/** A path under `root`, or `undefined` when it would leave it. */
export function inside(root: string, path: string): string | undefined {
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? target : undefined;
}

/** Reads at most `limit` bytes of a text file; a NUL byte in them makes it binary. */
async function readText(path: string, limit: number): Promise<{ text?: string; truncated?: boolean; error?: string }> {
  const info = await stat(path);
  if (!info.isFile()) return { error: "not a file" };
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { error: "binary" };
    return { text: bytes.toString("utf8"), ...(info.size > limit ? { truncated: true } : {}) };
  } finally {
    await handle.close();
  }
}

export function sliceLines(content: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined) return content;
  const all = content.split(/\r?\n/u);
  return all.slice(startLine - 1, Math.max(startLine, endLine ?? startLine)).join("\n");
}

/** Best matches first: a file name that starts with the query, then a path that contains it. */
export function rankFiles(files: readonly string[], query: string, limit = 30): string[] {
  const needle = query.toLowerCase();
  if (!needle) return files.slice(0, limit);
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (score >= 0) scored.push({ file, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length).slice(0, limit).map((entry) => entry.file);
}

const run = (command: string, args: readonly string[], cwd: string) => new Promise<string>((resolveRun, reject) => {
  const invocation = commandInvocation(command, args);
  execFile(invocation.command, invocation.args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (error, stdout) => {
    if (error) reject(error);
    else resolveRun(stdout);
  });
});

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "target", ".venv"]);

async function walk(root: string, limit = 20_000): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift()!;
    let entries;
    try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) queue.push(rel); } else if (entry.isFile()) files.push(rel);
    }
  }
  return files;
}

export function parsePullRequests(tool: "gh" | "glab", output: string): PullRequestSummary[] {
  const rows = JSON.parse(output) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): PullRequestSummary[] => {
    const row = record(raw);
    const number = tool === "gh" ? row.number : row.iid;
    const url = tool === "gh" ? row.url : row.web_url;
    const branch = tool === "gh" ? row.headRefName : row.source_branch;
    const draft = tool === "gh" ? row.isDraft : row.draft;
    if (typeof number !== "number" || typeof url !== "string") return [];
    return [{ number, title: text(row.title), url, ...(typeof branch === "string" ? { branch } : {}), ...(draft === true ? { draft: true } : {}) }];
  });
}

/** Composer Context's host half: stores attachments, reads what chips point at, lists files and pull requests. */
export function createComposerContextHostExtension(): HostExtension {
  return {
    id: COMPOSER_CONTEXT_ID,
    name: "Composer Context",
    activate(context: HostExtensionContext) {
      const { services } = context;
      const attachmentsRoot = join(services.stateDir, "attachments");
      const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();
      const pullRequests = new Map<string, { at: number; list: Promise<PullRequestSummary[]> }>();

      const workspace = (input: Record<string, unknown>) => {
        const cwd = text(input.cwd) || services.cwd();
        if (!isAbsolute(cwd)) throw new HostCommandError("The project path must be absolute.");
        return cwd;
      };

      context.registerCommand("store-attachment", async (input) => {
        const fields = record(input);
        const data = text(fields.data);
        const bytes = Buffer.from(data, "base64");
        if (bytes.length === 0) throw new HostCommandError("The attachment is empty.");
        const tooLarge = () => new HostCommandError(`Attachments must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`);
        if (bytes.length > MAX_FILE_BYTES) throw tooLarge();
        const into = text(fields.into);
        if (into) {
          // Only a file this kit started itself takes more chunks.
          const target = resolve(into);
          if (!isAbsolute(into) || !target.startsWith(attachmentsRoot + sep)) throw new HostCommandError("The attachment to continue is not this kit's.");
          const before = (await stat(target)).size;
          if (before + bytes.length > MAX_FILE_BYTES) {
            await rm(target, { force: true });
            throw tooLarge();
          }
          await appendFile(target, bytes);
          return { path: target, size: before + bytes.length };
        }
        const folder = join(attachmentsRoot, attachmentFolder(text(fields.scope)));
        await mkdir(folder, { recursive: true });
        const path = join(folder, `${randomUUID().slice(0, 8)}-${safeFileName(text(fields.name))}`);
        await writeFile(path, bytes, { mode: 0o600 });
        services.log("composer-context.stored", `${bytes.length} bytes`);
        return { path, size: bytes.length };
      }, { long: true });

      context.registerCommand("read-files", async (input) => {
        const fields = record(input);
        const cwd = workspace(fields);
        const requests = Array.isArray(fields.files) ? fields.files.map(record) : [];
        return Promise.all(requests.map(async (request): Promise<ReadFileResult> => {
          const wanted: ReadFileRequest = { path: text(request.path), startLine: line(request.startLine), endLine: line(request.endLine) };
          const target = inside(cwd, wanted.path);
          if (!target) return { path: wanted.path, error: "outside the project" };
          try {
            // A range may start deep in a file, so read the whole of it before slicing.
            const read = await readText(target, wanted.startLine === undefined ? EMBED_TEXT_BYTES : MAX_FILE_BYTES);
            if (read.text === undefined) return { path: wanted.path, error: read.error ?? "unreadable" };
            const sliced = sliceLines(read.text, wanted.startLine, wanted.endLine);
            const truncated = Buffer.byteLength(sliced) > EMBED_TEXT_BYTES;
            return {
              path: wanted.path,
              text: truncated ? Buffer.from(sliced).subarray(0, EMBED_TEXT_BYTES).toString("utf8") : sliced,
              ...(truncated || (read.truncated && wanted.startLine === undefined) ? { truncated: true } : {}),
            };
          } catch (error) {
            return { path: wanted.path, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : "unreadable" };
          }
        }));
      });

      context.registerCommand("describe-attachments", async (input) => {
        const paths = Array.isArray(record(input).paths) ? (record(input).paths as unknown[]).map(text) : [];
        return Promise.all(paths.map(async (path): Promise<DescribedAttachment> => {
          // Only what this kit stored itself is read back.
          const target = resolve(path);
          if (!isAbsolute(path) || !target.startsWith(attachmentsRoot + sep)) return { path };
          try {
            const read = await readText(target, EMBED_TEXT_BYTES);
            return read.text === undefined ? { path } : { path, text: read.text, ...(read.truncated ? { truncated: true } : {}) };
          } catch {
            return { path };
          }
        }));
      });

      context.registerCommand("list-files", async (input) => {
        const fields = record(input);
        const cwd = workspace(fields);
        const cached = fileLists.get(cwd);
        let files = cached && Date.now() - cached.at < 15_000 ? cached.files : undefined;
        if (!files) {
          files = run(gitExecutable(), ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd)
            .then((out) => out.split("\0").filter(Boolean))
            .catch(() => walk(cwd));
          fileLists.set(cwd, { at: Date.now(), files });
        }
        return rankFiles(await files, text(fields.query));
      });

      context.registerCommand("list-pull-requests", async (input) => {
        const cwd = workspace(record(input));
        const cached = pullRequests.get(cwd);
        if (cached && Date.now() - cached.at < 30_000) return cached.list;
        const list = (async () => {
          const gh = services.findCommand("gh");
          if (gh) {
            try {
              return parsePullRequests("gh", await run(gh, ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,url,headRefName,isDraft"], cwd));
            } catch { /* not a GitHub remote, or not signed in: try GitLab */ }
          }
          const glab = services.findCommand("glab");
          if (glab) {
            try { return parsePullRequests("glab", await run(glab, ["mr", "list", "--output", "json"], cwd)); } catch { /* fall through */ }
          }
          throw new HostCommandError(gh || glab ? "The pull requests of this project could not be listed." : "Install gh or glab to list pull requests.");
        })();
        pullRequests.set(cwd, { at: Date.now(), list });
        list.catch(() => pullRequests.delete(cwd));
        return list;
      });
    },
  };
}

export default createComposerContextHostExtension;
