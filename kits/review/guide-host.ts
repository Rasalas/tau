import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HostCommandError, PARENT_LINK_ENTRY, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import { Type } from "typebox";
import { decodeGuideStops, guideChangeOf, normalizeGuide } from "./guide-normalize.js";
import { renderChangeList, renderFileDiff } from "./guide-diff.js";
import {
  GUIDE_AGENT, GUIDE_DIFF_TOOL, GUIDE_ENABLED_OPTION, GUIDE_EFFORT_VALUE, GUIDE_EVENT, GUIDE_GET_COMMAND, GUIDE_INSTRUCTIONS_VALUE, GUIDE_MAX_REQUESTS, GUIDE_MODEL_VALUE,
  GUIDE_SUBMIT_TOOL, GUIDE_WRITE_COMMAND, guideKey,
  type GuideEvent, type GuideResult, type GuideRun, type GuideWriteResult,
} from "./guide-protocol.js";
import { buildGuidePrompt, GUIDE_DEFINITION } from "./guide-prompt.js";
import { modelEffort } from "./model-effort.js";
import { GuideStore } from "./guide-store.js";
import { projectRepository } from "./pull-request-list-host.js";
import type { PullRequestReads } from "./pull-request-host.js";
import type { SourceControl } from "./provider-registry.js";
import type { PullRequestRef } from "./protocol.js";

const AGENTS_KIT_ID = "tau.agents";
const PUSH_KIT_ID = "tau.push";
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

/** Brings a pull request's head commit into a checkout so a worktree can start from it. */
export type GuideFetch = (root: string, remote: string, sha: string, number: number) => Promise<void>;

const gitFetch: GuideFetch = async (root, remote, sha, number) => {
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    execFile("git", ["fetch", "--quiet", "--no-tags", remote, ...args], { cwd: root, timeout: 5 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, _out, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message)); else resolve();
    });
  });
  // A fork's head is not on a branch of the remote, but a pull ref names it on GitHub.
  await run([sha]).catch(() => run([`refs/pull/${number}/head`]));
};

export interface GuideOptions {
  fetchHead?: GuideFetch;
  now?: () => number;
  runId?: () => string;
  /** The pause between two tries to remove a worktree; a timer unless a test hands in its own. */
  wait?: (ms: number) => Promise<void>;
}

interface Active {
  runId: string;
  key: string;
  ref: PullRequestRef;
  headSha: string;
  startedAt: string;
  parentThreadId: string;
  title: string;
  threadId?: string;
}

export interface Guides {
  dispose(): void;
}

const CLEANUP_ATTEMPTS = 4;
const CLEANUP_WAIT_MS = 3_000;
const GUIDE_TOOLS: ReadonlySet<string> = new Set([GUIDE_DIFF_TOOL, GUIDE_SUBMIT_TOOL]);

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value };
}

/** Whether a session's own link entry says it was started as the guide agent. */
export function isGuideSession(entries: readonly unknown[]): boolean {
  for (const entry of entries) {
    const item = record(entry);
    if (item.type !== "custom" || item.customType !== PARENT_LINK_ENTRY) continue;
    return record(record(item.data).persona).name === GUIDE_AGENT;
  }
  return false;
}

/**
 * Guided reviews (ADR 0034): the store, the runs, the commands the window uses, the tools for agents
 * and the two tools only the guide agent sees. A run is a visible read-only sub-agent in a throwaway
 * worktree of the request's head; it hands the guide in through `submit_pull_request_guide`.
 */
export function registerGuides(
  context: HostExtensionContext,
  sources: SourceControl,
  reads: PullRequestReads,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  options: GuideOptions = {},
): Guides {
  const { services } = context;
  const store = new GuideStore(services.stateDir);
  const now = options.now ?? Date.now;
  const fetchHead = options.fetchHead ?? gitFetch;
  const newRunId = options.runId ?? randomUUID;
  /** The run in progress, or the last failure, per request. */
  const runs = new Map<string, GuideRun>();
  const active = new Map<string, Active>();
  /** Every thread a run started, until it ended: a superseded run's thread still has a worktree to remove. */
  const threads = new Map<string, Active>();

  const settings = async (cwd?: string) => {
    const read = await services.settings?.(cwd).catch(() => undefined);
    return {
      enabled: read?.options[GUIDE_ENABLED_OPTION] === true,
      model: read?.values[GUIDE_MODEL_VALUE]?.trim() ?? "",
      effort: read?.values[GUIDE_EFFORT_VALUE]?.trim() ?? "",
      instructions: read?.values[GUIDE_INSTRUCTIONS_VALUE]?.trim() ?? "",
    };
  };

  const emit = (run: Active | { ref: PullRequestRef; title?: string; parentThreadId?: string }, kind: GuideEvent["kind"]) => {
    const event: GuideEvent = { url: run.ref.url, number: run.ref.number, kind, ...(run.title ? { title: run.title } : {}), ...(run.parentThreadId ? { parentThreadId: run.parentThreadId } : {}) };
    context.emit(GUIDE_EVENT, event);
  };

  const resolveRef = async (reference: Record<string, unknown>, cwd: string | undefined): Promise<PullRequestRef> => {
    const url = text(reference.url);
    if (url) {
      const found = sources.forUrl(url);
      if (!found) throw new HostCommandError("This is not a pull or merge request URL. Pass the repository and number instead.");
      return found.ref;
    }
    const number = reference.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new HostCommandError("Pass a pull request URL, or its number.");
    const project = await projectRepository(workspace, sources, cwd);
    const host = text(reference.host)?.toLowerCase() ?? project.host;
    const repo = text(reference.repository) ?? project.repo;
    const found = sources.forUrl(project.provider.requestUrl({ host, repo }, number));
    if (!found) throw new HostCommandError(`${host}/${repo} #${number} names no request.`);
    return found.ref;
  };

  const resultFor = async (ref: PullRequestRef, cwd?: string): Promise<GuideResult> => {
    const key = guideKey(ref);
    const [guide, detail, config] = await Promise.all([store.get(key), reads.detail(ref, false).catch(() => undefined), settings(cwd)]);
    return { guide, run: runs.get(key) ?? null, currentHeadSha: detail?.headSha ?? null, enabled: config.enabled };
  };

  const agentCall = (command: string, input: unknown) => context.invokeHostExtension(AGENTS_KIT_ID, command, input);
  /** The worktree goes when the thread is done with it; a guide agent changes nothing worth keeping. */
  const cleanUp = async (threadId: string) => {
    // The run can end a moment before Agents Kit sees its thread as done, and it refuses a busy one.
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts follow one another
        await agentCall("discard-changes", { threadId });
        return;
      } catch (error) {
        services.log("review.guide-cleanup", `${message(error)}${attempt < CLEANUP_ATTEMPTS ? " · again soon" : ""}`);
        // oxlint-disable-next-line no-await-in-loop
        if (attempt < CLEANUP_ATTEMPTS) await (options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); })))(CLEANUP_WAIT_MS);
      }
    }
  };

  const fail = (run: Active, detail: string) => {
    if (active.get(run.key)?.runId !== run.runId) return;
    active.delete(run.key);
    runs.set(run.key, { state: "failed", headSha: run.headSha, failedAt: new Date(now()).toISOString(), detail });
    services.log("review.guide-failed", `${run.ref.repo}#${run.ref.number} · ${detail}`);
    emit(run, "failed");
  };

  const settledReview = async (ref: PullRequestRef): Promise<string> => {
    const provider = sources.get(ref.service);
    if (!provider.info.capabilities.conversations) return "";
    const conversations = await provider.threads(ref, false).catch(() => []);
    return conversations.filter((thread) => thread.resolved)
      .map((thread) => `${thread.path}${thread.line ? `:${thread.line}` : ""}: ${(thread.comments[0]?.body ?? "").replace(/\s+/gu, " ").slice(0, 300)}`)
      .join("\n");
  };

  /** Starts a run, or says why not; never waits for the guide. */
  const start = async (ref: PullRequestRef, via: { parentThreadId: string; cwd?: string }): Promise<GuideWriteResult> => {
    const asked = async (outcome: GuideWriteResult["outcome"], detail?: string): Promise<GuideWriteResult> =>
      ({ outcome, ...(detail ? { detail } : {}), ...(await resultFor(ref, via.cwd)) });
    const key = guideKey(ref);
    try {
      const parent = services.thread(via.parentThreadId);
      if (!parent) return asked("failed", "Open a thread in a checkout of this repository, then write the guide from it.");
      const cwd = via.cwd ?? parent.cwd;
      const config = await settings(cwd);
      if (!config.enabled) return asked("failed", "Review guides are off. Turn them on in Settings → Source control.");
      if (ref.service !== "github") return asked("failed", "Guides are written for GitHub pull requests so far.");
      const project = await projectRepository(workspace, sources, cwd);
      if (project.host.toLowerCase() !== ref.host.toLowerCase() || project.repo.toLowerCase() !== ref.repo.toLowerCase()) {
        return asked("failed", `A guide is written from a checkout of ${ref.host}/${ref.repo}, and this thread's project is ${project.host}/${project.repo}. Write it from a thread in a checkout of that repository.`);
      }
      // A press asks for the head as it is now, not for a read from the last minute.
      const detail = await reads.detail(ref, true);
      if (!detail.headSha) return asked("failed", "This host did not report the pull request's head commit.");
      const running = active.get(key);
      if (running?.headSha === detail.headSha) return asked("running", undefined);
      const run: Active = { runId: newRunId(), key, ref, headSha: detail.headSha, startedAt: new Date(now()).toISOString(), parentThreadId: via.parentThreadId, title: detail.title };
      // A newer head replaces a run still reading the old one; its result would be for a commit already moved past.
      if (running) {
        active.delete(key);
        if (running.threadId) void agentCall("stop-agent", { threadId: running.threadId }).catch(() => undefined);
      }
      active.set(key, run);
      runs.set(key, { state: "running", headSha: run.headSha, startedAt: run.startedAt });
      emit(run, "running");
      try {
        await fetchHead(project.git.root, project.git.remote?.name ?? "origin", run.headSha, ref.number);
        const [changes, review, stack] = await Promise.all([
          reads.files(ref, true),
          settledReview(ref),
          reads.stackOf ? reads.stackOf(ref).catch(() => undefined) : Promise.resolve(undefined),
        ]);
        if (changes.files.length === 0) throw new Error("This pull request has no changed files.");
        if (active.get(key)?.runId !== run.runId) return asked("running");
        const prompt = buildGuidePrompt({
          runId: run.runId, number: ref.number, title: detail.title, description: detail.body, baseRef: detail.baseRef, headSha: run.headSha,
          settledReview: review, instructions: config.instructions,
          ...(stack && stack.size > 1 ? { stack: { position: stack.number, size: stack.size } } : {}),
        });
        const effort = await modelEffort(services, config.model, config.effort, cwd);
        const started = await agentCall("spawn", {
          parentThreadId: via.parentThreadId, prompt, title: `Review guide for #${ref.number}`, startAt: run.headSha,
          ...(config.model ? { model: config.model } : {}), ...(effort ? { thinkingLevel: effort } : {}), source: "tau.review", definition: GUIDE_DEFINITION,
        }) as { threadId: string; status?: string; error?: string };
        if (started.error) throw new Error(started.error);
        // A queued agent has no thread yet; its first tool call says which thread it is.
        if (started.status !== "pending") { run.threadId = started.threadId; threads.set(started.threadId, run); }
        const live = runs.get(key);
        if (live?.state === "running") runs.set(key, { ...live, ...(run.threadId ? { threadId: run.threadId } : {}) });
        services.log("review.guide-started", `${ref.repo}#${ref.number} · ${run.headSha.slice(0, 9)}`);
        return { outcome: "started", ...(await resultFor(ref, cwd)), ...(run.threadId ? { threadId: run.threadId } : {}) };
      } catch (error) {
        fail(run, message(error));
        return asked("failed", message(error));
      }
    } catch (error) {
      return asked("failed", message(error));
    }
  };

  const guideThreadOf = (session: RuntimeSessionInfo, runId: string): Active => {
    const run = [...active.values()].find((candidate) => candidate.runId === runId);
    if (!run) throw new Error("This run is over or was replaced by a newer one. Stop; there is nothing more to submit.");
    if (run.threadId && run.threadId !== session.sessionId) throw new Error("This run belongs to another thread.");
    if (!run.threadId) { run.threadId = session.sessionId; threads.set(session.sessionId, run); }
    return run;
  };

  const submit = async (session: RuntimeSessionInfo, params: unknown) => {
    const fields = record(params);
    const run = guideThreadOf(session, text(fields.runId) ?? "");
    const stops = decodeGuideStops(fields);
    if (!stops.some((stop) => stop.title)) throw new Error("Submit at least one stop with a title.");
    const changes = await reads.files(run.ref, false);
    const normalized = normalizeGuide(stops, guideChangeOf(changes));
    const placed = normalized.filter((stop) => stop.title !== "Other files" || stop.excerpts.length > 0 || normalized.length === 1);
    if (placed.length === 0) throw new Error("None of your stops survived: check that the paths are changed files of this pull request.");
    if (active.get(run.key)?.runId !== run.runId) throw new Error("This run was replaced by a newer one.");
    const model = services.thread(session.sessionId)?.model;
    await store.put(run.key, { headSha: run.headSha, generatedAt: new Date(now()).toISOString(), model: model ? `${model.provider}/${model.id}` : null, stops: normalized });
    active.delete(run.key);
    runs.delete(run.key);
    services.log("review.guide-stored", `${run.ref.repo}#${run.ref.number} · ${normalized.length} stops`);
    emit(run, "ready");
    void context.invokeHostExtension(PUSH_KIT_ID, "notify", { threadId: run.parentThreadId, kind: "completed", text: `Review guide ready for #${run.ref.number}` }).catch(() => undefined);
    return `Stored a guide with ${normalized.length} stops for #${run.ref.number}. You are done; end your turn.`;
  };

  const diffTool = async (session: RuntimeSessionInfo, params: unknown) => {
    const fields = record(params);
    const run = guideThreadOf(session, text(fields.runId) ?? "");
    const [changes, detail] = await Promise.all([reads.files(run.ref, false), reads.detail(run.ref, false)]);
    const path = text(fields.path);
    return path ? renderFileDiff(changes, path) : renderChangeList(changes, detail.commits);
  };

  const guideTools = (session: RuntimeSessionInfo): HostMcpTool[] => [
    {
      name: GUIDE_DIFF_TOOL,
      label: "Read pull request diff",
      description: "Only for the guide agent. Without a path: the pull request's changed files with their counts and its commits. With a path: that file's diff, every line numbered on its own side.",
      promptSnippet: `${GUIDE_DIFF_TOOL}: the changed files, or one file's diff with line numbers`,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({ runId: Type.String({ description: "The run id from your task." }), path: Type.Optional(Type.String({ description: "A changed file's path; leave out for the list of changed files." })) }),
      execute: async (_id: string, params: unknown) => toolResult(await diffTool(session, params)),
    },
    {
      // Publishing the guide result changes no project or remote state.
      annotations: { readOnlyHint: true },
      name: GUIDE_SUBMIT_TOOL,
      label: "Submit pull request guide",
      description: "Only for the guide agent. Hands in the finished tour; call it once. The stops are held to the change: excerpts to changed lines, notes to excerpts.",
      promptSnippet: `${GUIDE_SUBMIT_TOOL}: hand in the guide`,
      parameters: Type.Object({
        runId: Type.String({ description: "The run id from your task." }),
        stops: Type.Array(Type.Object({
          title: Type.String(),
          summary: Type.String(),
          attention: Type.Optional(Type.Union([Type.Null(), Type.Object({ kind: Type.String({ description: "tradeoff, contract, product, risk or accessibility" }), note: Type.String() })])),
          excerpts: Type.Optional(Type.Array(Type.Object({ path: Type.String(), side: Type.Optional(Type.String({ description: "new or old" })), start: Type.Number(), end: Type.Number(), caption: Type.Optional(Type.String()) }))),
          files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) }))),
          notes: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), title: Type.String(), body: Type.Optional(Type.String()) }))),
          questions: Type.Optional(Type.Array(Type.String())),
        })),
      }),
      execute: async (_id: string, params: unknown) => toolResult(await submit(session, params)),
    },
  ];

  const targetSchema = Type.Object({
    url: Type.Optional(Type.String({ description: "The pull request's web URL, e.g. https://github.com/owner/repo/pull/123. Preferred when you have it." })),
    repository: Type.Optional(Type.String({ description: "Repository path below the host, e.g. owner/repo; this thread's project's repository when left out." })),
    number: Type.Optional(Type.Number({ description: "The pull request's number; required when url is left out." })),
    host: Type.Optional(Type.String({ description: "Host of the repository, e.g. github.com; this thread's project's host when left out." })),
  });

  const agentTools = (session: RuntimeSessionInfo): HostMcpTool[] => [
    {
      name: "write_pull_request_guides",
      label: "Write pull request guides",
      description: `Start a review guide for each of 1 to ${GUIDE_MAX_REQUESTS} GitHub pull requests of this thread's repository: a tour of the change for the maintainer deciding whether it lands. A read-only agent writes each in the background and shows in the Agents panel; this call does not wait for it. Answers per request: started, running (a run for the same head is already under way) or failed with a detail. Off unless the user turned review guides on in Settings.`,
      promptSnippet: "write_pull_request_guides: start review guides for pull requests",
      annotations: { readOnlyHint: false },
      parameters: Type.Object({ pullRequests: Type.Array(targetSchema, { minItems: 1, maxItems: GUIDE_MAX_REQUESTS }) }),
      execute: async (_id: string, params: unknown) => {
        const list = Array.isArray(record(params).pullRequests) ? record(params).pullRequests as unknown[] : [];
        if (list.length === 0 || list.length > GUIDE_MAX_REQUESTS) throw new Error(`Name 1 to ${GUIDE_MAX_REQUESTS} pull requests.`);
        // One after the other: each run fetches into the same repository.
        const answers: unknown[] = [];
        for (const entry of list) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- runs fetch into one repository
            const ref = await resolveRef(record(entry), session.cwd);
            // oxlint-disable-next-line no-await-in-loop
            const result = await start(ref, { parentThreadId: session.sessionId, cwd: session.cwd });
            answers.push({ url: ref.url, number: ref.number, outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}), ...(result.threadId ? { threadId: result.threadId } : {}) });
          } catch (error) {
            answers.push({ outcome: "failed", detail: message(error), ...record(entry) });
          }
        }
        return toolResult({ pullRequests: answers });
      },
    },
    {
      name: "read_pull_request_guide",
      label: "Read pull request guide",
      description: "Read a pull request's review guide: the stops (title, summary, the call to make, excerpts, notes, questions) in reading order, the run in progress or last failure, the request's current head and whether the guide is stale, written before a push. Never starts a run.",
      promptSnippet: "read_pull_request_guide: read a pull request's review guide",
      annotations: { readOnlyHint: true },
      parameters: targetSchema,
      execute: async (_id: string, params: unknown) => {
        const ref = await resolveRef(record(params), session.cwd);
        const result = await resultFor(ref, session.cwd);
        if (!result.enabled) throw new Error("Review guides are off. Turn them on in Settings → Source control.");
        const stale = result.guide !== null && result.currentHeadSha !== null && result.guide.headSha !== result.currentHeadSha;
        return toolResult({ url: ref.url, guide: result.guide, run: result.run, currentHeadSha: result.currentHeadSha, stale });
      },
    },
  ];

  context.registerCommand(GUIDE_GET_COMMAND, async (input) => resultFor((await resolveRef(record(input), text(record(input).cwd))), text(record(input).cwd)), { access: "read", long: true });
  context.registerCommand(GUIDE_WRITE_COMMAND, async (input) => {
    const fields = record(input);
    const threadId = text(fields.threadId);
    if (!threadId) throw new HostCommandError("Open a thread, then write the guide from it.");
    const cwd = text(fields.cwd);
    return start(await resolveRef(fields, cwd), { parentThreadId: threadId, ...(cwd ? { cwd } : {}) });
  }, { long: true, audit: { label: "started a review guide" } });

  const disposers = [
    services.mcp.registerTools(agentTools),
    services.registerRuntimeExtension("tau-review-guides", (pi, session) => {
      for (const tool of agentTools(session)) pi.registerTool(tool);
      // Only a guide agent lists the two tools of the run; they are registered on sub-agents so persona tool lists can name them.
      if (!session.parentThreadId) return;
      for (const tool of guideTools(session)) pi.registerTool(tool);
      const sync = (entries: readonly unknown[]) => {
        if (isGuideSession(entries)) return;
        const current = pi.getActiveTools();
        if (current.some((name) => GUIDE_TOOLS.has(name))) pi.setActiveTools(current.filter((name) => !GUIDE_TOOLS.has(name)));
      };
      pi.on("session_start", (_event, ctx) => { sync(ctx.sessionManager.getEntries()); });
      pi.on("before_agent_start", (_event, ctx) => { sync(ctx.sessionManager.getEntries()); });
    }),
    services.registerTurnObserver({
      runEnded: (sessionId, outcome) => {
        const run = threads.get(sessionId);
        if (!run) return;
        threads.delete(sessionId);
        // A guide stored by now cleared the run; an end without one is a failure the reader should hear.
        if (active.get(run.key)?.runId === run.runId) fail(run, outcome === "failed" ? "The guide agent failed before it submitted a guide. Open it in the Agents panel to see why." : "The guide agent finished without submitting a guide. Open it in the Agents panel to see why.");
        void cleanUp(sessionId);
      },
    }),
  ];

  return { dispose: () => { for (const dispose of disposers.reverse()) dispose(); void store.idle(); } };
}
