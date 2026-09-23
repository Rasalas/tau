import { Type } from "typebox";
import { HostCommandError, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import { THREAD_LINKS_EVENT, type PullRequestRef, type ThreadPullRequestLink } from "./protocol.js";
import { requestUrlFor } from "./pull-request-hosting.js";
import type { PullRequestReads } from "./pull-request-host.js";
import { projectRepository } from "./pull-request-list-host.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { linkKey, ThreadLinkStore } from "./thread-links.js";

/** A linked request's state is asked again at most this often; a merged one only on request. */
const REFRESH_MS = 5 * 60_000;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

const REGISTER_EVERY_PR = "Register every pull or merge request you open or work on for this thread, each layer of a stack included, right after creating it.";

export interface ThreadLinks {
  /** Links a request to a thread; the Changes panel calls this after creating one. */
  link(threadId: string, url: string, source: ThreadPullRequestLink["source"]): Promise<void>;
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
  reads: PullRequestReads,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
): ThreadLinks {
  const { services } = context;
  const store = new ThreadLinkStore(services.stateDir);
  const changed = (threadId: string) => context.emit(THREAD_LINKS_EVENT, { threadId });

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
    const project = await projectRepository(workspace, (name) => services.findCommand(name), cwd);
    const host = reference.host?.toLowerCase() ?? project.host;
    const repo = reference.repository ?? project.repo;
    const ref = parseRequestUrl(requestUrlFor(project.service, host, repo, reference.number));
    if (!ref) throw new HostCommandError(`${host}/${repo} #${reference.number} names no request.`);
    return ref;
  };

  /** Parses "https://…", "#12" or "12" as the dialog takes them. */
  const parseTyped = (typed: string): { url?: string; number?: number } | undefined => {
    const value = typed.trim();
    if (/^https?:\/\//iu.test(value)) return { url: value };
    const number = /^#?(\d+)$/u.exec(value)?.[1];
    return number ? { number: Number(number) } : undefined;
  };

  const snapshotOf = async (ref: PullRequestRef, fresh: boolean): Promise<Pick<ThreadPullRequestLink, "title" | "state" | "draft" | "headRef" | "baseRef"> | undefined> => {
    try {
      const detail = await reads.detail(ref, fresh);
      return { title: detail.title, state: detail.state, draft: detail.draft, ...(detail.headRef ? { headRef: detail.headRef } : {}), baseRef: detail.baseRef };
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

  const refresh = async (threadId: string, force: boolean) => {
    const links = await store.list(threadId);
    const due = links.filter((entry) => force || ((entry.state !== "merged" && entry.state !== "closed") && Date.now() - (entry.refreshedAt ?? 0) > REFRESH_MS));
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
    return store.list(threadId);
  }, { long: true });

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
      name: "link_pull_request",
      label: "Link pull request",
      description: `${REGISTER_EVERY_PR} Links a pull or merge request to this thread so Tau shows it beside the thread and tracks its state. Pass the URL, or the number (with repository for another repository). Linking one that is already linked succeeds with alreadyLinked=true.`,
      promptSnippet: "link_pull_request: register a pull request you opened or work on with this thread",
      parameters: targetParameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const ref = await resolve(decodeTarget(params), session.cwd);
        const result = await link(session.sessionId, ref, "agent");
        return toolResult({ host: ref.host, repository: ref.repo, number: ref.number, url: ref.url, alreadyLinked: result.alreadyLinked });
      },
    },
    {
      name: "unlink_pull_request",
      label: "Unlink pull request",
      description: "Remove a pull or merge request from this thread, e.g. one opened by mistake. Pass the URL, or the number. Unlinking one that is not linked succeeds with wasLinked=false.",
      parameters: targetParameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const ref = await resolve(decodeTarget(params), session.cwd);
        const wasLinked = await store.unlink(session.sessionId, ref);
        if (wasLinked) changed(session.sessionId);
        return toolResult({ host: ref.host, repository: ref.repo, number: ref.number, wasLinked });
      },
    },
    {
      name: "list_thread_pull_requests",
      label: "List thread pull requests",
      description: `List the pull or merge requests linked to this thread with their last known state. ${REGISTER_EVERY_PR}`,
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
    }),
    services.mcp.registerTools(tools),
    services.registerThreadLifecycle({
      threadDeleted: async (sessionId) => { await store.forget(sessionId); },
    }),
  ];

  return {
    link: async (threadId, url, source) => {
      const ref = parseRequestUrl(url);
      if (ref) await link(threadId, ref, source);
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose(); },
  };
}
