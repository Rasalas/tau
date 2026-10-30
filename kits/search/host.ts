import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { deviceReadPaths, hasFullFileAccess, type DeviceReadPaths } from "../_filesystem/device-read-paths.js";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { commandInvocation, THREAD_TEXTS_COMMAND } from "tau/host-extension";
import { rankFuzzy } from "./fuzzy.js";
import { parseRipgrepLine, projectPath, ripgrepArgs, ripgrepError, ripgrepFileArgs } from "./ripgrep.js";
import { MessageIndexControl } from "./index-control.js";
import { RuntimeThreadIndex } from "./runtime-threads.js";
import { ConversationThreadIndex } from "./conversation-threads.js";
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
  type ThreadSearchPage,
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
const candidateIds = (value: unknown): Set<string> | undefined =>
  Array.isArray(value) ? new Set(value.filter((id): id is string => typeof id === "string")) : undefined;

/** A search that runs longer than this answers with what it found. */
const CONTENT_BUDGET_MS = 15_000;
/** A project's file list is read again after this long even without a change reported. */
const FILE_LIST_TTL_MS = 5 * 60_000;
const RECENT_THREAD_FILES = 400;
const RECENT_QUERY_BYTES = 32_000_000;

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
  /** Legacy memory-index option; persistent host searches retain every export on disk. */
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
    activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      let ripgrep: Promise<string | undefined> | undefined;
      const findRipgrep = () => (ripgrep ??= Promise.resolve().then(() => services.findCommand("rg")).catch(() => undefined));
      /** The search each channel is running, so the next one can stop it. */
      const running = new Map<string, () => void>();
      const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();
      const sessionIndex = new SessionTextIndex({ list: () => services.sessions.list(), now });
      const indexControl = new MessageIndexControl({
        stateDir: services.stateDir,
        now,
        sessions: () => services.sessions.list(),
        conversations: services.conversations,
        ask: (source, input) => context.invokeHostExtension(source, THREAD_TEXTS_COMMAND, input),
        publish: status => context.emit("index-status", status),
      });
      const recentConversations = new ConversationThreadIndex(services.conversations, { budgetChars: options.runtimeBudgetChars });
      const recentRuntime = new RuntimeThreadIndex({
        sources: THREAD_TEXT_SOURCES,
        ignore: id => recentConversations.suppresses(id),
        ignoreRevision: () => recentConversations.revision,
        ask: (source, input) => context.invokeHostExtension(source, THREAD_TEXTS_COMMAND, input),
        now,
        ...(options.runtimeBudgetChars !== undefined ? { budgetChars: options.runtimeBudgetChars } : {}),
      });
      type SearchJob = { id: string; key: string; matches: ThreadMatch[]; complete: boolean; cancel: boolean; task: Promise<void>; at: number; failure?: string; truncated?: boolean; error?: string };
      const jobs = new Map<string, SearchJob>();
      let disposed = false;
      const invalidateSessions = () => { sessionIndex.invalidate(); indexControl.refresh(true); };
      const observers = [
        services.registerThreadLifecycle({ threadDeleted: invalidateSessions, afterFork: invalidateSessions, sweep: invalidateSessions }),
        services.registerTurnObserver({ ended: invalidateSessions, reset: invalidateSessions, closed: invalidateSessions }),
      ];
      const stopJobs = () => { for (const job of jobs.values()) job.cancel = true; jobs.clear(); };
      context.registerCommand("index-status", async () => { await indexControl.ready; return indexControl.snapshot(); }, { access: "read" });
      context.registerCommand("index-configure", async raw => {
        const enabled = record(raw).enabled;
        if (typeof enabled !== "boolean") throw refuse("Index message text must be on or off.");
        stopJobs();
        return indexControl.configure(enabled);
      }, { long: true });
      context.registerCommand("index-rebuild", () => indexControl.rebuild(), { long: true });

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

      const searchThreads = async (fields: Record<string, unknown>, fallback: boolean, cancelled: () => boolean, publish?: (matches: ThreadMatch[]) => void, budget: { bytesRead: number; matches?: ThreadMatch[] } = { bytesRead: 0 }): Promise<ThreadSearchResult> => {
        const generation = fallback ? undefined : indexControl.active;
        const conversations = generation?.conversations ?? recentConversations;
        const work = async () => {
          const previousRevision = conversations.revision;
          await conversations.sync();
          if (previousRevision !== conversations.revision) await (generation?.runtime ?? recentRuntime).sync();
          const state = indexControl.snapshot().state;
          const result: ThreadSearchResult = { matches: [], truncated: Boolean(generation && state === "indexing" || state === "error" || state === "unavailable") };
          if (cancelled()) return { ...result, cancelled: true };
          const query = text(fields.query);
          const tokens = queryTokens(query);
          if (tokens.length === 0) return result;
          const phrase = tokens.join(" ");
          const limit = count(fields.limit, 20, 100);
          const candidates = candidateIds(fields.sessionIds);
          if (candidates?.size === 0) return result;
          const metadata = generation ? undefined : await sessionIndex.sessions();
          const sessions = metadata?.entries ?? await services.sessions.list();
          if (metadata?.incomplete) { result.truncated = true; result.error = "Some thread files could not be read."; }

          const archived = candidateIds(fields.archivedSessionIds) ?? new Set<string>();
          const matches: Array<{ match: ThreadMatch; modifiedAt: number }> = [];
          const compare = (a: typeof matches[number], b: typeof matches[number]) =>
            Number(archived.has(a.match.sessionId)) - Number(archived.has(b.match.sessionId)) || (b.match.quality ?? 0) - (a.match.quality ?? 0) || b.modifiedAt - a.modifiedAt;
          const offer = (entry: typeof matches[number]) => {
            // One result per durable thread; active data has already won before
            // disk candidates arrive. Only the best `limit` snippets stay in RAM.
            if (matches.some((held) => held.match.sessionId === entry.match.sessionId)) return;
            matches.push(entry);
            matches.sort(compare);
            if (matches.length > limit) { matches.pop(); result.truncated = true; }
            if (!cancelled()) publish?.(matches.map(item => item.match));
          };
          const active = text(fields.activeSessionId);
          let readActive = false;
          // A live transcript includes the middle of a large Pi file, and the
          // turns beyond another runtime's exported text prefix. It is also
          // authoritative when a streaming thread's file has not caught up yet.
          if (active && (!candidates || candidates.has(active))) {
            try {
              const texts = (await services.transcript(active))
                .filter((message) => message.role === "user" || message.role === "assistant")
                .map((message) => ({ role: message.role as ThreadText["role"], text: message.text }));
              const found = findInThread(texts, tokens, phrase);
              // Attached Pi can have a session file without an open HostThread;
              // the worker facade returns [] in that case instead of throwing.
              readActive = texts.length > 0 || Boolean(await services.thread(active));
              if (found) offer({ match: { sessionId: active, path: sessions.find((session) => session.sessionId === active)?.path ?? "", ...found }, modifiedAt: Number.POSITIVE_INFINITY });
            } catch {
              result.truncated = true;
              result.error = "The open thread could not be searched.";
            }
          }
          // A runtime refresh may repeat the cold pass after its I/O budget was
          // spent. Keep file hits already found even if their cache was evicted.
          if (!generation) for (const match of budget.matches ?? []) {
            if (readActive && match.sessionId === active) continue;
            if (conversations.suppresses(match.sessionId)) continue;
            const dated = metadata!.entries.find(session => session.sessionId === match.sessionId);
            if (dated) offer({ match, modifiedAt: dated.mtimeMs });
          }
          // Every admitted candidate is considered before limiting results. A
          // sparse older hit must not vanish behind 400 newer unrelated files.
          const admitted = sessions.filter(session => !conversations.suppresses(session.sessionId) && (!candidates || candidates.has(session.sessionId)));
          const searched = generation ? admitted : admitted.slice(0, RECENT_THREAD_FILES);
          result.truncated ||= admitted.length > searched.length;
          for (const session of searched) {
            if ((readActive && session.sessionId === active) || (candidates && !candidates.has(session.sessionId))) continue;
            if (cancelled()) break;
            if (generation) {
              const identity = { source: "pi", id: session.sessionId, path: session.path };
              const found = indexControl.snapshot().state === "indexing"
                ? await generation.index.searchCommittedPi(identity, tokens).catch(() => { result.truncated = true; result.error = "Some thread files could not be read."; return undefined; })
                : await generation.index.searchPi(identity, tokens);
              if (found) offer({ match: { sessionId: session.sessionId, path: session.path, ...found.match }, modifiedAt: found.updatedAt });
            } else {
              if (budget.bytesRead >= RECENT_QUERY_BYTES) { result.truncated = true; break; }
              const dated = metadata!.entries.find(entry => entry.path === session.path)!;
              const read = await sessionIndex.texts(dated, cancelled, RECENT_QUERY_BYTES - budget.bytesRead);
              budget.bytesRead += read.bytesRead;
              result.truncated ||= read.truncated;
              if (read.error) result.error = read.error;
              const found = findInThread(read.texts, tokens, phrase);
              if (found) offer({ match: { sessionId: session.sessionId, path: session.path, ...found }, modifiedAt: dated.mtimeMs });
            }
          }
          for await (const conversation of conversations.search(tokens, candidates, readActive ? active : undefined)) {
            if (cancelled()) break;
            offer({ match: { sessionId: conversation.sessionId, path: conversation.path, ...conversation.match }, modifiedAt: conversation.modifiedAt });
          }
          result.truncated ||= conversations.truncated;
          if (conversations.truncated) result.error = "Some conversation messages could not be searched.";
          if (generation) {
            for await (const thread of generation.runtime.search(tokens, candidates, readActive ? active : undefined)) {
              if (cancelled()) break;
              if (conversations.suppresses(thread.threadId)) continue;
              offer({ match: { sessionId: thread.threadId, path: "", ...thread.match }, modifiedAt: thread.updatedAt });
            }
            result.truncated ||= generation.runtime.truncated;
            if (generation.runtime.coverage().some(source => source.reason === "export-failed" || source.reason === "catalog-stalled")) result.error = "Some runtime messages could not be searched.";
          } else {
            // Memory fallback exports are refreshed separately. Never persist them while disabled.
            const unavailable = new Set(recentRuntime.coverage().filter(source => source.state === "unavailable").map(source => source.source));
            for (const thread of recentRuntime.entries()) {
              if (conversations.suppresses(thread.threadId)) continue;
              if (unavailable.has(thread.source)) continue;
              if (cancelled()) break;
              if ((readActive && thread.threadId === active) || candidates && !candidates.has(thread.threadId)) continue;
              const found = findInThread(thread.texts, tokens, phrase);
              if (found) offer({ match: { sessionId: thread.threadId, path: "", ...found }, modifiedAt: thread.updatedAt });
            }
            result.truncated ||= recentRuntime.truncated;
          }
          result.matches = cancelled() ? [] : matches.map(({ match }) => match);
          if (!generation) budget.matches = result.matches;
          if (cancelled()) result.cancelled = true;
          return result;

        };
        return generation ? generation.index.exclusive(work) : work();
      };
      context.registerCommand("threads", async (raw): Promise<ThreadMatch[] | ThreadSearchResult> => {
        const fields = record(raw);
        const key = text(fields.channel) ? `threads:${text(fields.channel)}` : undefined;
        if (key) running.get(key)?.();
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        if (key) running.set(key, cancel);
        const answer = (result: ThreadSearchResult) => {
          if (cancelled || disposed) { result.matches = []; result.cancelled = true; }
          return fields.includeStatus === true ? result : result.matches;
        };
        try {
          if (!queryTokens(text(fields.query)).length) return answer({ matches: [], truncated: false });
          await indexControl.settled();
          if (cancelled || disposed) return answer({ matches: [], truncated: false });
          const status = indexControl.snapshot();
          const generation = status.enabled && status.state !== "error" && status.state !== "unavailable" ? indexControl.active : undefined;
          if (generation) await generation.index.exclusive(() => generation.runtime.sync());
          else await recentRuntime.sync();
          return answer(await searchThreads(fields, !generation, () => cancelled || disposed));
        } finally { if (key && running.get(key) === cancel) running.delete(key); }
      }, { access: "read", long: true });

      context.registerCommand("thread-search-cancel", raw => {
        const channel = text(record(raw).channel);
        const job = jobs.get(channel);
        if (job) { job.cancel = true; jobs.delete(channel); }
      }, { access: "read" });
      context.registerCommand("thread-search", async (raw): Promise<ThreadSearchPage> => {
        await indexControl.ready;
        const fields = record(raw);
        const channel = text(fields.channel) || "default";
        const key = JSON.stringify([fields.query, fields.sessionIds, fields.activeSessionId, fields.archivedSessionIds, fields.limit]);
        // Expire abandoned jobs and bound the per-window job registry.
        for (const [held, job] of jobs) if (Date.now() - job.at > 30_000 || jobs.size > 32) { job.cancel = true; jobs.delete(held); }
        let job = jobs.get(channel);
        if (!job || job.id !== fields.continuation || job.key !== key) {
          if (job) job.cancel = true;
          job = { id: `${Date.now()}-${Math.random()}`, key, matches: [], complete: false, cancel: false, task: Promise.resolve(), at: Date.now() };
          jobs.set(channel, job);
          const next = job;
          const cancelled = () => next.cancel || disposed;
          const budget = { bytesRead: 0 };
          const search = async (fallback: boolean) => {
            const result = await searchThreads(fields, fallback, cancelled, matches => { next.matches = matches; }, budget);
            next.matches = result.matches;
            next.truncated = result.truncated;
            next.error = result.error;
          };
          next.task = (async () => {
            const status = indexControl.snapshot();
            if (!indexControl.active || status.state === "disabled" || status.state === "error" || status.state === "unavailable") {
              const syncing = recentRuntime.sync().catch(() => undefined);
              await search(true);
              await syncing;
              if (!cancelled()) await search(true);
              if (cancelled()) return;
              if (!status.enabled || status.state === "error" || status.state === "unavailable") { next.complete = true; return; }
              await indexControl.settled();
            }
            if (cancelled()) return;
            await search(!indexControl.active);
            next.complete = true;
            indexControl.refresh();
          })().catch(error => {
            next.complete = true;
            next.failure = error instanceof Error ? error.message : String(error);
          });
        }
        job.at = Date.now();
        // Yield useful partial answers promptly, even for a huge cold library.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([job.task, new Promise<void>(resolve => { timer = setTimeout(resolve, 80); })]);
        if (timer) clearTimeout(timer);
        return { matches: job.cancel ? [] : job.matches, complete: job.complete, truncated: Boolean(job.truncated || !job.complete || job.cancel || job.failure), ...(job.failure || job.error ? { error: job.failure ?? job.error } : {}), status: job.failure ? { ...indexControl.snapshot(), state: "unavailable", error: job.failure } : indexControl.snapshot(), ...(!job.complete && !job.cancel ? { continuation: job.id } : {}) };
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
          throw refuse(`The thread could not be searched: ${error instanceof Error ? error.message : String(error)}`);
        }
        return findMessages(messages, query, fields.mode === "all-words" ? "all-words" : undefined);
      }, { access: "read", long: true });

      context.registerCommand("thread-requests", async (raw): Promise<ThreadRequestMatch[]> => {
        const fields = record(raw);
        const query = text(fields.query).trim();
        if (!query) return [];
        const candidates = candidateIds(fields.sessionIds);
        if (candidates?.size === 0) return [];
        let answer: unknown;
        try {
          answer = await context.invokeHostExtension(REVIEW_KIT_ID, "thread-request-links", { query });
        } catch {
          // No Review Kit, or one that does not know the command: a thread has no request to find it by.
          return [];
        }
        return Object.entries(record(answer))
          .filter(([sessionId]) => !candidates || candidates.has(sessionId))
          .flatMap(([sessionId, links]) => Array.isArray(links) && links.length > 0 ? [{ sessionId, requests: links as ThreadRequestMatch["requests"] }] : [])
          .slice(0, count(fields.limit, 20, 100));
      }, { access: "read", long: true });

      return async () => {
        for (const cancel of running.values()) cancel();
        running.clear();
        disposed = true;
        for (const observer of observers) (await observer)();
        const pending = [...jobs.values()].map(job => job.task);
        stopJobs();
        await indexControl.dispose();
        await Promise.all(pending);

      };
    },
  };
}

export default createSearchHostExtension;
