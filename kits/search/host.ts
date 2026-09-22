import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { rankFuzzy } from "./fuzzy.js";
import { parseRipgrepLine, projectPath, ripgrepArgs, ripgrepError, ripgrepFileArgs } from "./ripgrep.js";
import { findInThread, queryTokens, sessionText, type ThreadText } from "./threads.js";
import { contentPattern, searchWalkedFiles, walkProject } from "./walker.js";
import {
  CONTENT_LIMIT,
  FILE_LIMIT,
  SEARCH_KIT_ID,
  type ContentMatch,
  type ContentSearchInput,
  type ContentSearchResult,
  type FileSearchResult,
  type ThreadMatch,
} from "./protocol.js";

/** Bad input, not a broken command: it reaches the caller without counting against the kit. */
function refuse(message: string): Error {
  return Object.assign(new Error(message), { name: "HostCommandError", expected: true });
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;

/** A search that runs longer than this answers with what it found. */
const CONTENT_BUDGET_MS = 15_000;
/** A project's file list is read again after this long even without a change reported. */
const FILE_LIST_TTL_MS = 5 * 60_000;
/** The newest threads the palette searches through. */
const THREAD_FILES = 400;

interface Process {
  /** Resolves once the process exited, however it ended. */
  done: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

/** Runs a program and hands each stdout line over; `false` from `onLine` stops it. */
function streamLines(command: string, args: readonly string[], cwd: string, onLine: (line: string) => boolean): Process {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let rest = "";
  let stderr = "";
  let stopped = false;
  const kill = () => { if (!stopped) { stopped = true; child.kill(); } };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stopped) return;
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (!onLine(line)) { kill(); return; }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (error) => { stderr += error.message; resolve({ code: null, stderr }); });
    child.on("close", (code) => {
      if (!stopped && rest) onLine(rest);
      resolve({ code, stderr });
    });
  });
  return { done, kill };
}

export interface SearchHostOptions {
  now?(): number;
}

/**
 * Search Kit's host half, in a worker: content search with ripgrep (or its own
 * walker where ripgrep is not installed), the project's file list for the
 * picker, and the text of the threads for the palette.
 */
export function createSearchHostExtension(options: SearchHostOptions = {}): WorkerHostExtension & { permissions: string[] } {
  const now = options.now ?? Date.now;
  return {
    id: SEARCH_KIT_ID,
    name: "Search",
    permissions: ["workspace:read", "process", "sessions"],
    activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      let ripgrep: Promise<string | undefined> | undefined;
      const findRipgrep = () => (ripgrep ??= Promise.resolve().then(() => services.findCommand("rg")).catch(() => undefined));
      /** The search each channel is running, so the next one can stop it. */
      const running = new Map<string, () => void>();
      const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();
      const threadTexts = new Map<string, { mtimeMs: number; size: number; texts: ThreadText[] }>();

      const projectRoot = async (value: unknown): Promise<string> => {
        const cwd = text(value) || await services.cwd();
        if (!isAbsolute(cwd)) throw refuse("The project path must be absolute.");
        return cwd;
      };

      const readFileList = async (cwd: string): Promise<string[]> => {
        const rg = await findRipgrep();
        if (!rg) return (await walkProject(cwd)).files.sort();
        await services.noteSubprocess();
        const files: string[] = [];
        const listing = streamLines(rg, ripgrepFileArgs(), cwd, (line) => {
          if (line) files.push(projectPath(line));
          return files.length < FILE_LIMIT;
        });
        await listing.done;
        return files.sort();
      };

      const projectFiles = (cwd: string): Promise<string[]> => {
        const cached = fileLists.get(cwd);
        if (cached && now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
        const files = readFileList(cwd);
        fileLists.set(cwd, { at: now(), files });
        files.catch(() => { if (fileLists.get(cwd)?.files === files) fileLists.delete(cwd); });
        return files;
      };

      context.registerCommand("content", async (raw): Promise<ContentSearchResult> => {
        const fields = record(raw);
        const input: ContentSearchInput = {
          query: text(fields.query),
          regex: fields.regex === true,
          caseSensitive: fields.caseSensitive === true,
          wholeWord: fields.wholeWord === true,
        };
        const limit = count(fields.limit, CONTENT_LIMIT, CONTENT_LIMIT);
        const channel = text(fields.channel) || "default";
        // A new query always stops the one before it, even an empty one; the
        // handle is in place before the first await, so no two can overtake.
        running.get(channel)?.();
        let cancelled = false;
        let stopProcess: (() => void) | undefined;
        const cancel = () => { cancelled = true; stopProcess?.(); };
        running.set(channel, cancel);
        const deadline = now() + CONTENT_BUDGET_MS;
        try {
          const rg = await findRipgrep();
          const engine = rg ? "ripgrep" : "walker";
          if (!input.query) return { matches: [], truncated: false, engine };
          const cwd = await projectRoot(fields.cwd);
          if (cancelled) return { matches: [], truncated: false, engine, cancelled: true };
          if (rg) {
            await services.noteSubprocess();
            const matches: ContentMatch[] = [];
            let truncated = false;
            const search = streamLines(rg, ripgrepArgs(input), cwd, (line) => {
              const match = parseRipgrepLine(line);
              if (!match) return true;
              if (matches.length >= limit) { truncated = true; return false; }
              matches.push(match);
              return true;
            });
            stopProcess = search.kill;
            if (cancelled) search.kill();
            const timer = setTimeout(() => { truncated = true; search.kill(); }, CONTENT_BUDGET_MS);
            const { code, stderr } = await search.done.finally(() => clearTimeout(timer));
            if (cancelled) return { matches: [], truncated: false, engine, cancelled: true };
            if (code === 2 && matches.length === 0) return { matches: [], truncated: false, engine, error: ripgrepError(stderr) };
            return { matches, truncated, engine };
          }
          let pattern: RegExp;
          try {
            pattern = contentPattern(input);
          } catch (error) {
            return { matches: [], truncated: false, engine, error: `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` };
          }
          const files = await projectFiles(cwd);
          const found = await searchWalkedFiles(cwd, files, pattern, { limit, cancelled: () => cancelled || now() > deadline });
          if (cancelled) return { matches: [], truncated: false, engine, cancelled: true };
          return { ...found, engine };
        } finally {
          if (running.get(channel) === cancel) running.delete(channel);
        }
      }, { long: true });

      context.registerCommand("files", async (raw): Promise<FileSearchResult> => {
        const fields = record(raw);
        const cwd = await projectRoot(fields.cwd);
        const files = await projectFiles(cwd);
        return { files: rankFuzzy(files, text(fields.query), count(fields.limit, 50, 200)), total: files.length };
      }, { long: true });

      context.registerCommand("invalidate", async (raw) => {
        const cwd = text(record(raw).cwd);
        if (cwd) fileLists.delete(cwd);
        else fileLists.clear();
      });

      const textsOf = async (path: string, mtimeMs: number, size: number): Promise<ThreadText[]> => {
        const cached = threadTexts.get(path);
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.texts;
        let texts: ThreadText[] = [];
        try { texts = sessionText(await readFile(path, "utf8")); } catch { /* a thread deleted meanwhile has nothing to say */ }
        threadTexts.set(path, { mtimeMs, size, texts });
        return texts;
      };

      context.registerCommand("threads", async (raw): Promise<ThreadMatch[]> => {
        const fields = record(raw);
        const query = text(fields.query);
        const tokens = queryTokens(query);
        if (tokens.length === 0) return [];
        const phrase = tokens.join(" ");
        const limit = count(fields.limit, 20, 100);
        const sessions = await services.sessions.list();
        const dated = await Promise.all(sessions.map(async (session) => {
          try {
            const info = await stat(session.path);
            return { ...session, mtimeMs: info.mtimeMs, size: info.size };
          } catch {
            return undefined;
          }
        }));
        const newest = dated.filter((entry) => entry !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, THREAD_FILES);
        const listed = new Set(newest.map((entry) => entry.path));
        for (const path of threadTexts.keys()) if (!listed.has(path)) threadTexts.delete(path);

        const matches: ThreadMatch[] = [];
        const active = text(fields.activeSessionId);
        // A thread of another runtime has no session file; the one on screen is read from its runtime.
        if (active && !sessions.some((session) => session.sessionId === active)) {
          try {
            const texts = (await services.transcript(active))
              .filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => ({ role: message.role as ThreadText["role"], text: message.text }));
            const found = findInThread(texts, tokens, phrase);
            if (found) matches.push({ sessionId: active, path: "", ...found });
          } catch {
            // Nothing open under that id: the files are all there is.
          }
        }
        for (const session of newest) {
          if (matches.length >= limit) break;
          const found = findInThread(await textsOf(session.path, session.mtimeMs, session.size), tokens, phrase);
          if (found) matches.push({ sessionId: session.sessionId, path: session.path, ...found });
        }
        return matches;
      }, { long: true });

      return () => {
        for (const cancel of running.values()) cancel();
        running.clear();
      };
    },
  };
}

export default createSearchHostExtension;
