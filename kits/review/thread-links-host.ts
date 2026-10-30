import { Type } from "typebox";
import { HostCommandError, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import { SEARCH_EXTENSION_ID, THREAD_LINKS_EVENT, THREAD_RAIL_EXTENSION_ID, type BranchReviewRequest, type PullRequestDetail, type PullRequestRef, type ThreadPullRequestLink, type ThreadRequestLink, type ReviewRequestContext } from "./protocol.js";
import { LOCAL_REVIEWS_EVENT } from "./local-reviews.js";
import type { SourceControl } from "./provider-registry.js";
import type { PullRequestReads } from "./pull-request-host.js";
import { projectRepository } from "./pull-request-list-host.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { linkKey, linkMatchesQuery, ThreadLinkStore } from "./thread-links.js";

/** An open linked request's state is asked again at most this often; a merged one only on request. */
const REFRESH_MS = 60_000;
/** An unchanged branch with an open link still checks for additional requests periodically. */
const LINKED_DISCOVERY_MS = 5 * 60_000;
/** A closed one is asked about now and then, so reopening it on the host is noticed. */
const CLOSED_REFRESH_MS = 30 * 60_000;
/** Linked requests read at once when Thread Rail asks about many threads. */
const SETTLE_READS = 4;

/** What a provider read says about a linked request; its stack is read on its own. */
const LINK_FIELDS = ["title", "state", "draft", "headRef", "headSha", "baseRef", "endedAt"] as const;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The section every runtime's system prompt gets, so linking does not hang on the model reading a tool description. */
export const LINKING_INSTRUCTIONS = `<pull_request_linking>
Tau keeps the pull and merge requests each thread works on. Whenever you open a pull or merge request, or start working on an existing one, call the link_pull_request tool with its full URL right away; for a stack, call it for every layer. Opening or updating a request through gh, glab, another CLI or the host's API does not register it with this thread. Linking one that is already linked is harmless. Before you finish work on requests, call list_thread_pull_requests and link any of yours that is missing. Do not link requests you only mention as background. If linking fails, say so instead of claiming the request is linked.
</pull_request_linking>`;

/**
 * How an agent puts pictures in a request: GitHub CLI 2.99 uploads them with
 * `--attach` (https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/);
 * before it GitHub had no upload an agent could reach. The fallback links files
 * by commit on a ref of their own, as Review Kit's own evidence upload does.
 */
export const MEDIA_INSTRUCTIONS = `<pull_request_media>
To show a screenshot or recording in a GitHub pull request, write its local path where it belongs in the Markdown, as in ![The login error](./login.png), and pass the same path to --attach on gh pr create, gh pr edit or gh pr comment; repeat the flag for each file. gh uploads each file and puts its URL in place of the path; a file the text does not mention is added at the end. A video plays only when its path stands alone in its paragraph. This needs GitHub CLI 2.99 or later (check gh --version), push access, and github.com: PNG, JPEG, GIF, WebP, SVG, MP4, MOV or WebM, images up to 10 MB. Images the user sent you are saved as files too: their paths come with the message, under "Attached files" or as file links. With an older gh or on GitHub Enterprise Server there is no upload: in a public repository, push the files on a ref of their own such as refs/tau/evidence/<branch>, never on the request's branch, and link https://github.com/OWNER/REPO/raw/COMMIT/PATH; in a private one, name the files for the user to drag into the description. Do not say a picture is attached unless gh reported the upload.
</pull_request_media>`;

/** What every thread's agent reads about pull requests, in Pi's system prompt and over MCP. */
export const PULL_REQUEST_INSTRUCTIONS = `${LINKING_INSTRUCTIONS}\n\n${MEDIA_INSTRUCTIONS}`;

export interface ThreadLinks {
  /** Links a request to a thread; the Changes panel calls this after creating one. */
  link(threadId: string, url: string, source: ThreadPullRequestLink["source"]): Promise<void>;
  /** The cached request's destination and submitted tip; asks no provider. */
  review(threadIds: readonly string[], branch: string, tip: string): Promise<BranchReviewRequest | undefined>;
  /** A provider's answer about a request, recorded in every thread that links it. */
  observe(ref: PullRequestRef, detail: PullRequestDetail): Promise<void>;
  /** Reads the request afresh, e.g. after a watch saw it merge; the read lands through `observe`. */
  reread(url: string): Promise<void>;
  dispose(): void;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/**
 * Pull requests linked to a thread: the store, the commands the window uses,
 * and the same three tools for the agent — in Pi as a runtime extension, in
 * every other runtime over Tau's MCP endpoint (ADR 0022).
 */
export function registerThreadLinks(
  context: HostExtensionContext,
  reads: Pick<PullRequestReads, "detail" | "stackOf">,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  sources: SourceControl,
): ThreadLinks {
  const { services } = context;
  const store = new ThreadLinkStore(services.stateDir);
  const changed = (threadId: string) => {
    context.emit(THREAD_LINKS_EVENT, { threadId });
    context.emit(LOCAL_REVIEWS_EVENT, {});
    // Host-side settlement also works with no window watching these events.
    void context.invokeHostExtension(THREAD_RAIL_EXTENSION_ID, "requests-changed", { threadId }).catch(() => undefined);
  };

  /** A URL names its own repository; a bare number means the thread's project's. */
  const resolve = async (reference: { url?: string; repository?: string; number?: number; host?: string }, cwd: string | undefined): Promise<PullRequestRef> => {
    if (reference.url) {
      const ref = parseRequestUrl(reference.url);
      if (!ref) throw new HostCommandError("This is not a pull or merge request URL. Pass the repository and number instead.");
      return ref;
    }
    if (reference.number === undefined || !Number.isInteger(reference.number) || reference.number < 1) {
      throw new HostCommandError("Pass a pull request URL, or its number.");
    }
    const project = await projectRepository(workspace, sources, cwd);
    const host = reference.host?.toLowerCase() ?? project.host;
    const repo = reference.repository ?? project.repo;
    const ref = parseRequestUrl(project.provider.requestUrl({ host, repo }, reference.number));
    if (!ref) throw new HostCommandError(`${host}/${repo} #${reference.number} names no request.`);
    return ref;
  };

  /** Parses "https://…", "#12", "!12" or "12" as the dialog takes them. */
  const parseTyped = (typed: string): { url?: string; number?: number } | undefined => {
    const value = typed.trim();
    if (/^https?:\/\//iu.test(value)) return { url: value };
    const number = /^[#!]?(\d+)$/u.exec(value)?.[1];
    return number ? { number: Number(number) } : undefined;
  };

  const fieldsOf = (detail: PullRequestDetail): Pick<ThreadPullRequestLink, (typeof LINK_FIELDS)[number]> => {
    const endedAt = detail.state === "open" ? undefined : Date.parse((detail.state === "merged" ? detail.mergedAt : detail.closedAt) ?? "");
    return {
      title: detail.title, state: detail.state, draft: detail.draft, ...(detail.headRef ? { headRef: detail.headRef } : {}), ...(detail.headSha ? { headSha: detail.headSha } : {}), baseRef: detail.baseRef,
      ...(endedAt !== undefined && Number.isFinite(endedAt) ? { endedAt } : {}),
    };
  };

  const snapshotOf = async (ref: PullRequestRef, fresh: boolean): Promise<Pick<ThreadPullRequestLink, (typeof LINK_FIELDS)[number] | "stack"> | undefined> => {
    try {
      const detail = await reads.detail(ref, fresh);
      // The stack a rail row counts; a stack that cannot be read counts as none.
      const stack = reads.stackOf ? await reads.stackOf(ref).catch(() => undefined) : undefined;
      return { ...fieldsOf(detail), ...(stack ? { stack: { number: stack.number, size: stack.size } } : {}) };
    } catch {
      return undefined;
    }
  };

  const link = async (threadId: string, ref: PullRequestRef, source: ThreadPullRequestLink["source"]) => {
    const snapshot = await snapshotOf(ref, false);
    const result = await store.link(threadId, ref, source, snapshot ? { ...snapshot, refreshedAt: Date.now() } : {});
    if (!result.alreadyLinked) {
      changed(threadId);
      services.log("request.linked", `${threadId.slice(0, 8)} · ${ref.repo}#${ref.number} · ${source}`);
    }
    return result;
  };

  const discoveredAt = new Map<string, number>();
  const currentAt = new Map<string, { key: string; at: number }>();
  const discoveries = new Map<string, { force: boolean; value: Promise<void> }>();
  const discover = (threadId: string, force = false): Promise<void> => {
    const pending = discoveries.get(threadId);
    if (pending) return force && !pending.force ? pending.value.then(() => discover(threadId, true)) : pending.value;
    const at = discoveredAt.get(threadId);
    if (!force && at !== undefined && Date.now() - at < REFRESH_MS) return Promise.resolve();
    discoveredAt.set(threadId, Date.now());
    const value = runDiscovery(threadId, force).finally(() => {
      if (discoveries.get(threadId)?.value === value) discoveries.delete(threadId);
    });
    discoveries.set(threadId, { force, value });
    return value;
  };
  const runDiscovery = async (threadId: string, force: boolean) => {
    try {
      const sessions = await services.sessions.list();
      const thread = sessions.find((entry) => entry.sessionId === threadId);
      // A shared checkout does not tell us which conversation owns its PR.
      if (!thread || thread.parentThreadId || sessions.filter((entry) => !entry.parentThreadId && entry.cwd === thread.cwd).length !== 1) return;
      const git = await workspace("review-request-context", { workspace: thread.cwd, discovery: true }) as ReviewRequestContext;
      if (!git?.branch || !git.remote || git.branch === git.base) return;
      const service = await sources.detect(git.remote.url);
      const provider = sources.get(service);
      const target = provider.repository(git.remote.url);
      if (!target || provider.missing()) return;
      // Refresh already tracks this open request's state. Keep checking Git so
      // another branch or remote still starts discovery on the next poll.
      const links = await store.list(threadId);
      const key = JSON.stringify([service, target.host, target.repo, git.root, git.branch]);
      const checked = currentAt.get(threadId);
      if (!force && checked?.key === key && Date.now() - checked.at < LINKED_DISCOVERY_MS
        && links.some((entry) => entry.service === service && entry.host === target.host && entry.repo === target.repo
          && entry.headRef === git.branch && entry.state === "open")) return;
      const request = await provider.current({ ...target, cwd: git.root, branch: git.branch, fresh: force });
      currentAt.set(threadId, { key, at: Date.now() });
      // Never adopt an old merged request merely because its branch name was reused.
      if (!request || request.state !== "open" || request.headRef !== git.branch) return;
      const ref = parseRequestUrl(request.url);
      if (!ref || !await store.allowsDiscovery(threadId, ref)) return;
      const result = await store.link(threadId, ref, "discovered", {
        title: request.title, state: request.state, draft: request.draft, headRef: request.headRef,
        baseRef: request.baseRef, refreshedAt: Date.now(),
      });
      if (!result.alreadyLinked) changed(threadId);
    } catch { /* Discovery is optional; explicit links remain available offline. */ }
  };

  const stale = (entry: ThreadPullRequestLink) => {
    // A merge recorded before links kept its time is read once more for it.
    if (entry.state === "merged" && entry.headSha && entry.endedAt !== undefined) return false;
    return Date.now() - (entry.refreshedAt ?? 0) > (entry.state === "closed" ? CLOSED_REFRESH_MS : REFRESH_MS);
  };

  const refreshes = new Map<string, { force: boolean; value: Promise<void> }>();
  const refresh = (threadId: string, force: boolean): Promise<void> => {
    const pending = refreshes.get(threadId);
    if (pending) return force && !pending.force ? pending.value.then(() => refresh(threadId, true)) : pending.value;
    const value = runRefresh(threadId, force).finally(() => {
      if (refreshes.get(threadId)?.value === value) refreshes.delete(threadId);
    });
    refreshes.set(threadId, { force, value });
    return value;
  };
  const runRefresh = async (threadId: string, force: boolean) => {
    await discover(threadId, force);
    const links = await store.list(threadId);
    const due = links.filter((entry) => force || stale(entry));
    const results = await Promise.all(due.map(async (entry) => {
      const ref = parseRequestUrl(entry.url);
      const snapshot = ref ? await snapshotOf(ref, force) : undefined;
      return snapshot ? store.update(threadId, linkKey(entry), snapshot) : false;
    }));
    if (results.some(Boolean)) changed(threadId);
  };

  const threadOf = (input: unknown): string => {
    const threadId = text(record(input).threadId);
    if (!threadId) throw new HostCommandError("Name the thread.");
    return threadId;
  };

  context.registerCommand("thread-links", async (input) => {
    const threadId = threadOf(input);
    const mode = record(input).refresh;
    if (mode === true || mode === "force") await refresh(threadId, mode === "force");
    else await discover(threadId);
    return store.list(threadId);
  }, { access: "read", long: true });

  // The threads that link a request, for "linked from" in its view.
  context.registerCommand("pr-linked-threads", async (input) => {
    const ref = parseRequestUrl(text(record(input).url) ?? "");
    if (!ref) throw new HostCommandError("Name the request by its URL.");
    return store.threadsLinking(ref);
  }, { access: "read" });

  /**
   * Thread Rail's question before it settles threads: each named thread's
   * linked requests with their state, refreshed where stale. A link whose
   * state is unknown stays unknown, which keeps its thread active.
   */
  context.registerCommand("thread-requests", async (input) => {
    const ids = Array.isArray(record(input).threadIds) ? (record(input).threadIds as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    const queue = [...new Set(ids)];
    const answer: Record<string, Array<{ url: string; state?: ThreadPullRequestLink["state"]; baseRef?: string; linkedAt: number; endedAt?: number }>> = {};
    const worker = async () => {
      for (let threadId = queue.shift(); threadId !== undefined; threadId = queue.shift()) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time: each may ask a host
        await refresh(threadId, record(input).refresh === true).catch(() => undefined);
        // oxlint-disable-next-line no-await-in-loop
        const links = await store.list(threadId);
        if (links.length > 0) answer[threadId] = links.map((entry) => ({
          url: entry.url, ...(entry.state ? { state: entry.state } : {}), ...(entry.baseRef ? { baseRef: entry.baseRef } : {}),
          linkedAt: entry.linkedAt, ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
        }));
      }
    };
    await Promise.all(Array.from({ length: SETTLE_READS }, worker));
    return answer;
  }, { access: "read", long: true, callers: [THREAD_RAIL_EXTENSION_ID] });

  /**
   * Which threads keep which requests, from the stored links alone (no provider is asked):
   * the named threads', else every thread's, and with `query` only the links that match it
   * (`#95`, `owner/repo#95`, a request URL, words of its title or its head branch).
   * Thread Rail adds them to its thread list, Search finds threads by them.
   */
  context.registerCommand("thread-request-links", async (input) => {
    const fields = record(input);
    const ids = Array.isArray(fields.threadIds) ? new Set(fields.threadIds.filter((id): id is string => typeof id === "string" && id.length > 0)) : undefined;
    const query = text(fields.query) ?? "";
    const answer: Record<string, ThreadRequestLink[]> = {};
    for (const [threadId, links] of await store.all()) {
      if (ids && !ids.has(threadId)) continue;
      const kept = query ? links.filter((entry) => linkMatchesQuery(entry, query)) : links;
      if (kept.length > 0) answer[threadId] = kept.map((entry) => ({
        url: entry.url, repository: entry.repo, number: entry.number, state: entry.state ?? null, title: entry.title ?? null, headBranch: entry.headRef ?? null,
      }));
    }
    return answer;
  }, { access: "read", callers: [THREAD_RAIL_EXTENSION_ID, SEARCH_EXTENSION_ID] });

  context.registerCommand("link-pr", async (input) => {
    const threadId = threadOf(input);
    const typed = parseTyped(text(record(input).reference) ?? "");
    if (!typed) throw new HostCommandError("Use a pull request URL, 123 or #123.");
    const cwd = text(record(input).cwd) ?? services.thread(threadId)?.cwd;
    return link(threadId, await resolve(typed, cwd), "user");
  }, { long: true });

  context.registerCommand("unlink-pr", async (input) => {
    const threadId = threadOf(input);
    const ref = parseRequestUrl(text(record(input).url) ?? "");
    if (!ref) throw new HostCommandError("Name the request by its URL.");
    const wasLinked = await store.unlink(threadId, ref);
    if (wasLinked) {
      changed(threadId);
      services.log("request.unlinked", `${threadId.slice(0, 8)} · ${ref.repo}#${ref.number}`);
    }
    return { wasLinked };
  });

  const targetParameters = Type.Object({
    url: Type.Optional(Type.String({ description: "The request's web URL, e.g. https://github.com/owner/repo/pull/123. Preferred when you have it." })),
    repository: Type.Optional(Type.String({ description: "Repository path below the host, e.g. owner/repo; this thread's project's repository when left out." })),
    number: Type.Optional(Type.Number({ description: "The request's number; required when url is left out." })),
    host: Type.Optional(Type.String({ description: "Host of the repository, e.g. github.com; this thread's project's host when left out." })),
  });
  const decodeTarget = (params: unknown) => {
    const fields = record(params);
    return {
      ...(text(fields.url) ? { url: text(fields.url) } : {}),
      ...(text(fields.repository) ? { repository: text(fields.repository) } : {}),
      ...(typeof fields.number === "number" ? { number: fields.number } : {}),
      ...(text(fields.host) ? { host: text(fields.host) } : {}),
    };
  };

  const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [
    {
      annotations: { readOnlyHint: false },
      name: "link_pull_request",
      label: "Link pull request",
      description: "Track a pull or merge request worked on in this thread and show its status beside the conversation. Does not create the request.",
      promptSnippet: "link_pull_request: track a pull or merge request in this thread",
      parameters: targetParameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const ref = await resolve(decodeTarget(params), session.cwd);
        const result = await link(session.sessionId, ref, "agent");
        return toolResult({ host: ref.host, repository: ref.repo, number: ref.number, url: ref.url, alreadyLinked: result.alreadyLinked });
      },
    },
    {
      annotations: { readOnlyHint: false },
      name: "unlink_pull_request",
      label: "Unlink pull request",
      description: "Remove an incorrect pull or merge request association from this thread. Does not close or delete the request.",
      promptSnippet: "unlink_pull_request: remove an incorrect request association",
      parameters: targetParameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const ref = await resolve(decodeTarget(params), session.cwd);
        const wasLinked = await store.unlink(session.sessionId, ref);
        if (wasLinked) changed(session.sessionId);
        return toolResult({ host: ref.host, repository: ref.repo, number: ref.number, wasLinked });
      },
    },
    {
      annotations: { readOnlyHint: true },
      name: "list_thread_pull_requests",
      label: "List thread pull requests",
      description: "Check which pull or merge requests this thread tracks and their last known state.",
      promptSnippet: "list_thread_pull_requests: check tracked requests and their state",
      parameters: Type.Object({}),
      execute: async () => {
        await refresh(session.sessionId, false);
        const links = await store.list(session.sessionId);
        return toolResult({
          pullRequests: links.map((entry) => ({
            url: entry.url, host: entry.host, repository: entry.repo, number: entry.number, source: entry.source,
            state: entry.state ?? null, title: entry.title ?? null, headBranch: entry.headRef ?? null, baseBranch: entry.baseRef ?? null, isDraft: entry.draft ?? null,
          })),
        });
      },
    },
  ];

  const disposers = [
    services.registerRuntimeExtension("tau-pull-requests", (pi, session) => {
      for (const tool of tools(session)) pi.registerTool(tool);
      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${PULL_REQUEST_INSTRUCTIONS}` }));
    }),
    services.mcp.registerTools(tools),
    // Runtimes other than Pi read it from the MCP endpoint's instructions.
    services.mcp.registerInstructions?.(() => PULL_REQUEST_INSTRUCTIONS) ?? (() => undefined),
    services.registerThreadLifecycle({
      threadDeleted: async (sessionId) => { discoveredAt.delete(sessionId); currentAt.delete(sessionId); await store.forget(sessionId); },
    }),
  ];

  return {
    link: async (threadId, url, source) => {
      const ref = parseRequestUrl(url);
      if (ref) await link(threadId, ref, source);
    },
    review: async (threadIds, branch, tip) => {
      const candidates = (await Promise.all(threadIds.map((id) => store.list(id)))).flat()
        .filter((entry) => entry.headRef === branch && entry.baseRef && entry.state !== "closed")
        .sort((left, right) => Number(right.headSha === tip) - Number(left.headSha === tip) || right.linkedAt - left.linkedAt);
      const entry = candidates[0];
      return entry ? { target: entry.baseRef!, tip: entry.headSha, merged: entry.state === "merged", url: entry.url, number: entry.number } : undefined;
    },
    observe: async (ref, detail) => {
      const fields = fieldsOf(detail);
      for (const threadId of await store.threadsLinking(ref)) {
        // oxlint-disable-next-line no-await-in-loop -- one thread's file write after another
        const known = (await store.list(threadId)).find((entry) => linkKey(entry) === linkKey(ref));
        if (!known || LINK_FIELDS.every((field) => known[field] === fields[field])) continue;
        // oxlint-disable-next-line no-await-in-loop
        if (await store.update(threadId, linkKey(ref), { ...fields, ...(known.stack ? { stack: known.stack } : {}) })) changed(threadId);
      }
    },
    reread: async (url) => {
      const ref = parseRequestUrl(url);
      if (ref) await reads.detail(ref, true).catch(() => undefined);
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose(); },
  };
}
