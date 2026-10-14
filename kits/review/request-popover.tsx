import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, Layers } from "lucide-react";
import { Popover, tooltipProps } from "tau";
import { providerInfo, requestNumber, type ThreadPullRequestLink } from "./protocol.js";
import { threadRequestTree, type ThreadRequestNode } from "./thread-request-tree.js";

type RequestPopoverEntry = Pick<ThreadPullRequestLink, "url" | "service" | "host" | "repo" | "number" | "linkedAt" | "headRef" | "baseRef" | "title" | "draft" | "stack"> & {
  state?: "open" | "draft" | "merged" | "closed";
};
const ICON = { open: GitPullRequestArrow, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;

/** The rail badge and composer's +N share a compact, scrollable request preview. */
export function useRequestPopover<T extends HTMLElement>(entries: readonly RequestPopoverEntry[], { threadId, workspace, branchUrl, side = "bottom", align = "start" }: {
  threadId: string;
  workspace?: string;
  branchUrl?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const anchor = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; };
  const close = () => { cancel(); setOpen(false); };
  const enter = () => { cancel(); timer.current = setTimeout(() => setOpen(true), 350); };
  const leave = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  // A hover opens outside React's event handler; install dismissal before the visible links can be clicked.
  useLayoutEffect(() => {
    if (!open) return;
    const stop = () => { setOpen(false); clearTimeout(timer.current); };
    const clicked = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".request-popover") || event.target.closest("a.request-compact-row")) stop(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest(".request-popover")) stop(); };
    document.addEventListener("click", clicked, true);
    window.addEventListener("blur", stop);
    window.addEventListener("resize", stop);
    document.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("click", clicked, true); window.removeEventListener("blur", stop); window.removeEventListener("resize", stop); document.removeEventListener("scroll", scroll, true); };
  }, [open]);
  const triggerProps = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== "touch") enter(); },
    onPointerLeave: leave,
    onBlur: leave,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      setOpen(true);
    },
  };
  const popover = open ? <Popover anchor={anchor} side={side} align={align} label="Thread pull requests" className="request-popover" takeFocus={false} onClose={close}>
    <div onPointerEnter={cancel} onPointerLeave={leave} onFocus={cancel} onBlur={leave} onClick={(event) => { cancel(); event.stopPropagation(); }}>
      <CompactRequests nodes={threadRequestTree(entries)} threadId={threadId} workspace={workspace} branchUrl={branchUrl} />
    </div>
  </Popover> : null;
  return { anchor, close, triggerProps, popover };
}

const groupSize = (nodes: ThreadRequestNode<RequestPopoverEntry>[]): number => nodes.reduce((sum, node) => sum + 1 + groupSize(node.children), 0);

function CompactRequests({ nodes, threadId, workspace, branchUrl, nested = false }: { nodes: ThreadRequestNode<RequestPopoverEntry>[]; threadId: string; workspace?: string; branchUrl?: string; nested?: boolean }) {
  return <ul className="request-compact-tree" aria-label="Pull requests">
    {nodes.map(({ request: entry, children }) => {
      const state = entry.state === "merged" || entry.state === "closed" || entry.state === "draft" ? entry.state : entry.draft ? "draft" : "open";
      const Icon = ICON[state];
      const label = `${providerInfo(entry.service).short} ${requestNumber(entry.service, entry.number)}`;
      const size = !nested && children.length ? 1 + groupSize(children) : undefined;
      return <li key={entry.url} aria-label={`${label}, ${state}${entry.title ? `: ${entry.title}` : ""}`}>
        <a className={`request-compact-row state-${state}`} href={entry.url} aria-label={`${label}, ${state}${entry.title ? `: ${entry.title}` : ""}`} data-request-thread={threadId} data-request-workspace={workspace} data-request-branch={branchUrl}>
          <Icon size={13} aria-hidden="true" /><b>{requestNumber(entry.service, entry.number)}</b><span>{entry.title ?? entry.repo}</span>{size ? <small {...tooltipProps(`${size} requests in this branch stack`)}><Layers size={10} aria-hidden="true" />{size}</small> : null}
        </a>
        {children.length ? <CompactRequests nodes={children} threadId={threadId} workspace={workspace} branchUrl={branchUrl} nested /> : null}
      </li>;
    })}
  </ul>;
}

