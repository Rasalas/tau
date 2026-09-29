import { useEffect, useRef } from "react";
import { changesSinceTurn, type DesktopExtensionContext, type RegionProps, type UiWorkspaceChanges } from "tau";
import { REVIEW_HOST_EXTENSION_ID, WORKSPACE_CHANGES_PANEL, type WorkspaceStoreApi } from "./protocol.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { openPullRequest } from "./pull-request-open.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/** Review Kit's option, off by default. */
export const PROACTIVE_OPTION = "proactive-panels";

/** The bar for a turn's changes to open the diff by themselves. */
export function worthShowing(changes: Pick<UiWorkspaceChanges, "files" | "added" | "removed">): boolean {
  return changes.files.length >= 3 || changes.added + changes.removed >= 50;
}

/**
 * The requests each thread was seen linking. The first look at a thread only
 * remembers them, so switching to a thread opens nothing; a request that turns
 * up later is new.
 */
export class LinkWatcher {
  private seen = new Map<string, Set<string>>();

  observe(threadId: string, urls: readonly string[]): string[] {
    const known = this.seen.get(threadId);
    this.seen.set(threadId, new Set(urls));
    return known ? urls.filter((url) => !known.has(url)) : [];
  }
}

/**
 * Proactive panels: with it on, a request the thread
 * on screen links while you watch opens as its tab (several at once open the
 * Changes panel, which lists them), and a turn that changed at least 3 files
 * or 50 lines opens the Changes panel. A thread that links requests keeps to
 * them. Drawn as an empty title-bar region for its `actions`.
 */
export function createProactivePanels(plugin: DesktopExtensionContext, links: ThreadLinkRows, workspace: () => WorkspaceStoreApi | undefined) {
  const enabled = () => plugin.preferences.optionValue(REVIEW_HOST_EXTENSION_ID, PROACTIVE_OPTION, false) === true;
  return function ProactivePanels({ actions }: RegionProps) {
    // The region redraws with every snapshot; what it watches must outlive that.
    const latest = useRef(actions);
    latest.current = actions;
    useEffect(() => {
      const now = () => latest.current;
      const watcher = new LinkWatcher();
      const baselines = new Map<string, UiWorkspaceChanges>();
      const active = () => now().activeThread()?.sessionId;
      const watch = () => {
        const threadId = active();
        if (!threadId || !links.has(threadId)) return;
        const current = links.get(threadId);
        const added = watcher.observe(threadId, current.map((link) => link.url));
        if (added.length === 0 || !enabled()) return;
        if (added.length > 1) { now().openPanel(WORKSPACE_CHANGES_PANEL); return; }
        const ref = parseRequestUrl(added[0]!);
        if (ref) openPullRequest(now(), { url: ref.url, number: ref.number, provider: ref.service }, now().activeThread()?.cwd);
      };
      const stopLinks = links.subscribe(watch);
      const stopThread = plugin.events.on("active-thread-changed", (event) => { if (event.sessionId) links.ensure(event.sessionId); watch(); });
      const first = active();
      if (first) links.ensure(first);
      const stopStatus = plugin.events.on("agent-status", (event) => {
        const store = workspace();
        if (!store || event.sessionId !== active()) return;
        if (event.running) {
          baselines.set(event.sessionId, store.getSnapshot().changes);
          return;
        }
        const before = baselines.get(event.sessionId);
        baselines.delete(event.sessionId);
        if (!before || !enabled() || links.get(event.sessionId).length > 0) return;
        void store.refresh().then(() => {
          if (event.sessionId === active() && worthShowing(changesSinceTurn(before, store.getSnapshot().changes))) now().openPanel(WORKSPACE_CHANGES_PANEL);
        }, () => undefined);
      });
      return () => { stopLinks(); stopThread(); stopStatus(); };
    }, []);
    return null;
  };
}
