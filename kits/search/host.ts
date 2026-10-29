import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { deviceReadPaths, hasFullFileAccess, type DeviceReadPaths } from "../_filesystem/device-read-paths.js";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { commandInvocation, THREAD_TEXTS_COMMAND } from "tau/host-extension";
import { rankFuzzy } from "./fuzzy.js";
import { parseRipgrepLine, projectPath, ripgrepArgs, ripgrepError, ripgrepFileArgs } from "./ripgrep.js";
import { RuntimeThreadIndex } from "./runtime-threads.js";
import { SessionTextIndex } from "./session-index.js";
import { findInThread, findMessages, queryTokens, type ThreadText } from "./threads.js";
import { contentPattern, searchWalkedFiles, walkProject } from "./walker.js";
import {
  CONTENT_LIMIT,
  FILE_LIMIT,
  REVIEW_KIT_ID,
  SEARCH_KIT_ID,
  THREAD_TEXT_SOURCES,
  type ContentMatch,
  type ContentSearchInput,
  type ContentSearchResult,
  type FileSearchResult,
  type ThreadFindResult,
  type ThreadMatch,
  type ThreadRequestMatch,
  type ThreadSearchResult,
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
  const invocation = commandInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
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
  /** Characters the index of other runtimes' threads keeps; see `RuntimeThreadIndex`. */
  runtimeBudgetChars?: number;
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
    async activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      let ripgrep: Promise<string | undefined> | undefined;
      const findRipgrep = () => (ripgrep ??= Promise.resolve().then(() => services.findCommand("rg")).catch(() => undefined));
      /** The search each channel is running, so the next one can stop it. */
      const running = new Map<string, () => void>();
      const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();
      const sessionIndex = new SessionTextIndex({ list: () => services.sessions.list(), now });
      const runtimeThreads = new RuntimeThreadIndex({
        sources: THREAD_TEXT_SOURCES,
        ask: (source, input) => context.invokeHostExtension(source, THREAD_TEXTS_COMMAND, input),
        now,
        ...(options.runtimeBudgetChars !== undefined ? { budgetChars: options.runtimeBudgetChars } : {}),
      });

      const projectRoot = async (value: unknown): Promise<string> => {
        const cwd = text(value) || await services.cwd();
        if (!isAbsolute(cwd)) throw refuse("The project path must be absolute.");
        return cwd;
      };

      const readFileList = async (cwd: string, paths?: DeviceReadPaths): Promise<string[]> => {
        const rg = await findRipgrep();
        if (!rg || paths?.containsHome) return (await walkProject(cwd, { readPath: paths?.resolve })).files.sort();
        await services.noteSubprocess();
        const files: string[] = [];
        const listing = streamLines(rg, ripgrepFileArgs(Boolean(paths)), cwd, (line) => {
          if (line) files.push(projectPath(line));
          return files.length < FILE_LIMIT;
        });
        await listing.done;
        return files.sort();
      };

      const projectFiles = (cwd: string, paths?: DeviceReadPaths): Promise<string[]> => {
        const key = paths ? `${cwd}\0device` : cwd;
        const cached = fileLists.get(key);
        if (cached && now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
        const files = readFileList(cwd, paths);
        fileLists.set(key, { at: now(), files });
        files.catch(() => { if (fileLists.get(key)?.files === files) fileLists.delete(key); });
        return files;
      };

      context.registerCommand("content", async (raw, call): Promise<ContentSearchResult> => {
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
          const available = await findRipgrep();
          if (!input.query) return { matches: [], truncated: false, engine: available ? "ripgrep" : "walker" };
          const cwd = await projectRoot(fields.cwd);
          const paths = hasFullFileAccess(call) ? undefined : await deviceReadPaths(cwd);
          // The walker can skip protected Home ignore files before opening them.
          const rg = paths?.containsHome ? undefined : available;
          const engine = rg ? "ripgrep" : "walker";
          if (cancelled) return { matches: [], truncated: false, engine, cancelled: true };
          if (rg) {
            await services.noteSubprocess();
            const matches: ContentMatch[] = [];
            let truncated = false;
            const search = streamLines(rg, ripgrepArgs(input, Boolean(paths)), cwd, (line) => {
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
            const allowed: ContentMatch[] = [];
            for (const match of matches) if (!paths || await paths.resolve(join(cwd, match.path))) allowed.push(match);
            return { matches: allowed, truncated, engine };
          }
          let pattern: RegExp;
          try {
            pattern = contentPattern(input);
          } catch (error) {
            return { matches: [], truncated: false, engine, error: `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` };
          }
          const files = await projectFiles(cwd, paths);
          const found = await searchWalkedFiles(cwd, files, pattern, { limit, readPath: paths?.resolve, cancelled: () => cancelled || now() > deadline });
          if (cancelled) return { matches: [], truncated: false, engine, cancelled: true };
          return { ...found, engine };
        } finally {
          if (running.get(channel) === cancel) running.delete(channel);
        }
      }, { access: "read", long: true });

      context.registerCommand("files", async (raw, call): Promise<FileSearchResult> => {
        const fields = record(raw);
        const cwd = await projectRoot(fields.cwd);
        const paths = hasFullFileAccess(call) ? undefined : await deviceReadPaths(cwd);
        const listed = await projectFiles(cwd, paths);
        const files: string[] = [];
        for (const path of listed) if (!paths || await paths.resolve(join(cwd, path))) files.push(path);
        return { files: rankFuzzy(files, text(fields.query), count(fields.limit, 50, 200)), total: files.length };
      }, { access: "read", long: true });

      context.registerCommand("invalidate", async (raw) => {
        const cwd = text(record(raw).cwd);
        if (cwd) { fileLists.delete(cwd); fileLists.delete(`${cwd}\0device`); }
        else fileLists.clear();
        sessionIndex.invalidate();
      }, { access: "read" });

      context.registerCommand("threads", async (raw): Promise<ThreadMatch[] | ThreadSearchResult> => {
        const fields = record(raw);
        const key = text(fields.channel) ? `threads:${text(fields.channel)}` : undefined;
        if (key) running.get(key)?.();
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        if (key) running.set(key, cancel);
        const result: ThreadSearchResult = { matches: [], truncated: false };
        const answer = () => {
          if (cancelled) { result.matches = []; result.cancelled = true; }
          return fields.includeStatus === true ? result : result.matches;
        };
        try {
          const query = text(fields.query);
          const tokens = queryTokens(query);
          if (tokens.length === 0) return answer();
          const phrase = tokens.join(" ");
          const limit = count(fields.limit, 20, 100);
          const [metadata] = await Promise.all([sessionIndex.sessions(), runtimeThreads.sync()]);
          if (cancelled) return answer();
          const sessions = metadata.entries;
          const newest = sessions.slice(0, THREAD_FILES);
          result.truncated = metadata.incomplete || sessions.length > newest.length || runtimeThreads.truncated;
          if (metadata.incomplete) result.error = "Some thread files could not be read.";

          const matches = result.matches;
          const active = text(fields.activeSessionId);
          const activeElsewhere = Boolean(active) && !sessions.some((session) => session.sessionId === active);
          // A thread of another runtime has no session file; the one on screen is read from its runtime.
          if (activeElsewhere) {
            try {
              const texts = (await services.transcript(active))
                .filter((message) => message.role === "user" || message.role === "assistant")
                .map((message) => ({ role: message.role as ThreadText["role"], text: message.text }));
              const found = findInThread(texts, tokens, phrase);
              if (found) matches.push({ sessionId: active, path: "", ...found });
            } catch {
              result.truncated = true;
              result.error = "The open thread could not be searched.";
            }
          }
          // Pi's session files and the other runtimes' threads, newest first, until the limit.
          const runtime = runtimeThreads.entries().filter((thread) => !(activeElsewhere && thread.threadId === active));
          let fileAt = 0;
          let runtimeAt = 0;
          let bytesRead = 0;
          while (!cancelled && matches.length < limit && (fileAt < newest.length || runtimeAt < runtime.length)) {
            const session = newest[fileAt];
            const thread = runtime[runtimeAt];
            if (session && (!thread || session.mtimeMs >= thread.updatedAt)) {
              fileAt += 1;
              // Bound cold-query I/O as well as each file; cached text costs no read bytes.
              if (bytesRead >= 32_000_000) { result.truncated = true; break; }
              const read = await sessionIndex.texts(session, () => cancelled, 32_000_000 - bytesRead);
              bytesRead += read.bytesRead;
              result.truncated ||= read.truncated;
              if (read.error) result.error = read.error;
              const found = findInThread(read.texts, tokens, phrase);
              if (found) matches.push({ sessionId: session.sessionId, path: session.path, ...found });
            } else if (thread) {
              runtimeAt += 1;
              const found = findInThread(thread.texts, tokens, phrase);
              if (found) matches.push({ sessionId: thread.threadId, path: "", ...found });
            }
          }
          result.truncated ||= fileAt < newest.length || runtimeAt < runtime.length;
          return answer();
        } finally { if (key && running.get(key) === cancel) running.delete(key); }
      }, { access: "read", long: true });

      context.registerCommand("find-in-thread", async (raw): Promise<ThreadFindResult> => {
        const fields = record(raw);
        const sessionId = text(fields.sessionId);
        const query = text(fields.query);
        if (!sessionId || !query.trim()) return { messageIds: [], truncated: false };
        // The runtime holds the thread's whole transcript under the ids the client draws; a thread it has closed has none.
        let messages: Awaited<ReturnType<typeof services.transcript>>;
        try { messages = await services.transcript(sessionId); }
        catch (error) {
          // A runtime read failure should reach Retry without counting as a broken search extension.
          throw refuse(`The thread could not be searched: ${error instanceof Error ? error.message : String(error)}`);
        }
        return findMessages(messages, query);
      }, { access: "read", long: true });

      context.registerCommand("thread-requests", async (raw): Promise<ThreadRequestMatch[]> => {
        const fields = record(raw);
        const query = text(fields.query).trim();
        if (!query) return [];
        let answer: unknown;
        try {
          answer = await context.invokeHostExtension(REVIEW_KIT_ID, "thread-request-links", { query });
        } catch {
          // No Review Kit, or one that does not know the command: a thread has no request to find it by.
          return [];
        }
        return Object.entries(record(answer))
          .flatMap(([sessionId, links]) => Array.isArray(links) && links.length > 0 ? [{ sessionId, requests: links as ThreadRequestMatch["requests"] }] : [])
          .slice(0, count(fields.limit, 20, 100));
      }, { access: "read", long: true });

      const invalidateSessions = () => sessionIndex.invalidate();
      const stopTurns = await services.registerTurnObserver({ ended: invalidateSessions, reset: invalidateSessions });
      const stopLifecycle = await services.registerThreadLifecycle({ threadDeleted: invalidateSessions, afterFork: invalidateSessions });
      return () => {
        stopTurns();
        stopLifecycle();
        for (const cancel of running.values()) cancel();
        running.clear();
      };
    },
  };
}

export default createSearchHostExtension;
