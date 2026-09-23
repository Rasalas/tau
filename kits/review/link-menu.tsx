import { GitPullRequest, Link } from "lucide-react";
import { errorMessage, type PaletteItem, type PaletteMenu, type WorkbenchActions } from "tau";
import { readLinkInput } from "./link-dialog.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestList } from "./protocol.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/** How long one project's open requests answer the level before `gh` or `glab` is asked again. */
const LIST_TTL_MS = 60_000;
const LIST_LIMIT = 50;

async function link(app: WorkbenchActions, client: PullRequestClient, rows: ThreadLinkRows, thread: { sessionId: string; cwd?: string }, reference: string): Promise<void> {
  const result = await client.link(thread.sessionId, reference, thread.cwd);
  void rows.load(thread.sessionId);
  app.notify(result.alreadyLinked ? `#${result.link.number} is already linked to this thread.` : `Linked #${result.link.number} to this thread.`);
}

/**
 * "Link pull request…" as a palette level: the project's open requests to
 * pick from, and whatever URL or number is typed, as the dialog takes it.
 */
export function linkPullRequestMenu(client: PullRequestClient, rows: ThreadLinkRows, now: () => number = Date.now): PaletteMenu {
  const lists = new Map<string, { at: number; list: Promise<PullRequestList> }>();
  const openRequests = (workspace: string) => {
    const held = lists.get(workspace);
    if (held && now() - held.at < LIST_TTL_MS) return held.list;
    const list = client.list({ workspace, state: "open", limit: LIST_LIMIT });
    lists.set(workspace, { at: now(), list });
    list.catch(() => { if (lists.get(workspace)?.list === list) lists.delete(workspace); });
    return list;
  };
  return {
    title: "Link pull request",
    placeholder: "Search open pull requests, or paste a URL or #123…",
    empty: "No open pull request matches. Paste its URL or enter #123.",
    items: async (query, { actions }) => {
      const active = actions.activeThread();
      if (!active?.sessionId) throw new Error("Open a thread first; a pull request is linked to a thread.");
      const thread = { sessionId: active.sessionId, ...(active.cwd ? { cwd: active.cwd } : {}) };
      const typed = readLinkInput(query);
      const found: PaletteItem[] = typed && typed.kind !== "invalid" ? [{
        id: "typed",
        label: `Link ${typed.label}`,
        icon: <Link size={14} aria-hidden />,
        // The raw text is what the filter compares; the label only names it.
        keywords: [query.trim()],
        run: (app) => link(app, client, rows, thread, query.trim()),
      }] : [];
      const workspace = active.workspaceId ?? active.cwd;
      if (!workspace) return found;
      let list: PullRequestList;
      try {
        list = await openRequests(workspace);
      } catch (error) {
        if (found.length) return found;
        throw new Error(`${errorMessage(error)} Paste a pull request URL or enter #123.`, { cause: error });
      }
      return [...found, ...list.entries.map((entry): PaletteItem => ({
        id: entry.ref.url,
        label: `#${entry.ref.number} ${entry.title}`,
        detail: entry.author ? `${entry.headRef} · ${entry.author.login}` : entry.headRef,
        icon: <GitPullRequest size={14} aria-hidden />,
        keywords: [String(entry.ref.number), entry.ref.url, ...(entry.draft ? ["draft"] : [])],
        run: (app) => link(app, client, rows, thread, entry.ref.url),
      }))];
    },
  };
}
