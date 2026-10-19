import { useEffect, useRef } from "react";
import type { RegionProps, WorkbenchActions } from "tau";
import { parseRequestUrl } from "./pull-request-json.js";
import { openPullRequest, openThreadPullRequests, opensInBrowser } from "./pull-request-open.js";

/** Only request links in conversations, rail badges and their preview belong to this router. */
export function routeRequestLink(event: MouseEvent, actions: WorkbenchActions): void {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1) || !(event.target instanceof Element)) return;
  const badge = event.target.closest<HTMLElement>(".request-badge[data-request-thread]");
  // A thread's overview is no request URL; a middle click leaves it alone.
  if (badge?.dataset.requestThread && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    openThreadPullRequests(actions, badge.dataset.requestThread, badge.dataset.requestWorkspace, badge.dataset.requestBranch);
    return;
  }
  const anchor = event.target.closest<HTMLAnchorElement>(".message .markdown a[href], a.request-badge[href], .request-popover a.request-compact-row[href]");
  if (!anchor) return;
  const request = parseRequestUrl(anchor.href);
  if (!request) return;
  event.preventDefault();
  // A badge is inside the thread row: opening its request must not select that row.
  event.stopPropagation();
  // The link's own address, fragment and all, is what the browser gets.
  if (opensInBrowser(event)) actions.openExternal(anchor.href);
  else openPullRequest(actions, { url: request.url, number: request.number, provider: request.service }, anchor.dataset.requestWorkspace ?? actions.activeThread()?.cwd, undefined, anchor.dataset.requestThread ? { threadId: anchor.dataset.requestThread, workspace: anchor.dataset.requestWorkspace, branchUrl: anchor.dataset.requestBranch } : undefined);
}

/** Installed by Review Kit, removed when the kit is deactivated. */
export function RequestLinks({ actions }: RegionProps) {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const click = (event: MouseEvent) => routeRequestLink(event, latest.current);
    document.addEventListener("click", click, true);
    document.addEventListener("auxclick", click, true);
    return () => { document.removeEventListener("click", click, true); document.removeEventListener("auxclick", click, true); };
  }, []);
  return null;
}
