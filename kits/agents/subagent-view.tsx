import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ArrowUpLeft, Bot, CircleAlert, Wrench } from "lucide-react";
import { Button, Markdown, ProviderIconStack, useWorkbench, type ConversationViewProps } from "tau";
import { formatElapsed, nativeAgentRow, nativeAgentTools, type AgentRow } from "./model.js";
import { isBusyStatus } from "./protocol.js";

export const SUBAGENT_VIEW = "agents.subagent";

const STATUS = { running: "Running", waiting: "Waiting", pending: "Queued", completed: "Done", idle: "Done", failed: "Failed", cancelled: "Cancelled" };

/** The native child the conversation column shows, so its row in the lineage can say so. */
export const openedSubagent = (() => {
  const listeners = new Set<() => void>();
  let id: string | undefined;
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => id,
    set: (next: string | undefined) => { id = next; for (const listener of [...listeners]) listener(); },
  };
})();

export function useOpenedSubagent(): string | undefined {
  return useSyncExternalStore(openedSubagent.subscribe, openedSubagent.get);
}

function Elapsed({ row }: { row: AgentRow }) {
  const [now, setNow] = useState(Date.now);
  const live = isBusyStatus(row.status);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return row.startedAt ? <time>{formatElapsed(Math.max(0, (row.endedAt ?? (live ? now : row.startedAt)) - row.startedAt))}</time> : null;
}

/** "Subagent of · <parent>" over the run, as T3 Code draws it; the pill goes back. */
function ParentDivider({ title, onOpen }: { title: string; onOpen(): void }) {
  return <div className="subagent-parent-divider">
    <span aria-hidden />
    <button type="button" title="Open parent thread" onClick={onOpen}>
      <Bot size={12} aria-hidden /><strong>Subagent of</strong><span>·&nbsp;{title}</span>
    </button>
    <span aria-hidden />
  </div>;
}

/**
 * A runtime's own subagent (Claude Code's Agent tool, a Codex child) in place of
 * the parent's transcript. It has no Tau thread to switch to: it reads from the
 * parent's tool run and takes no prompts.
 */
export function SubagentView({ snapshot, params, onClose }: ConversationViewProps) {
  const { tools } = useWorkbench();
  const toolId = typeof params.toolId === "string" ? params.toolId : "";
  const tool = nativeAgentTools(snapshot?.turnActivityHistory, tools).get(toolId);
  const row = tool ? nativeAgentRow(tool) : undefined;
  const parentTitle = snapshot?.sessionTitle || "Parent thread";
  const scrollRef = useRef<HTMLDivElement>(null);
  const atTail = useRef(true);
  const entries = row?.native?.entries ?? [];
  const running = row ? isBusyStatus(row.status) : false;

  useEffect(() => {
    openedSubagent.set(toolId);
    return () => openedSubagent.set(undefined);
  }, [toolId]);
  // Opens at the latest step and follows the run while the reader stays there.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && atTail.current) node.scrollTop = node.scrollHeight;
  }, [tool?.output, entries.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || (event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
    // Not to the window, where Escape stops the parent's run.
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const title = row?.title ?? "Subagent";
  const meta = [row?.native?.runtime, row?.model].filter(Boolean).join(" · ");
  return <section className="subagent-view" aria-label={`Subagent ${title}`} onKeyDown={onKeyDown}>
    <div className="subagent-view-scroll" ref={scrollRef} tabIndex={-1}
      onScroll={(event) => { const node = event.currentTarget; atTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}
    >
      <div className="subagent-view-inner">
        <ParentDivider title={parentTitle} onOpen={onClose} />
        {!row ? <p className="subagent-view-empty" role="status">This subagent is not part of the thread any more.</p> : <>
          <header className="subagent-view-head">
            <h2>{title}</h2>
            {meta ? <small>{meta}</small> : null}
          </header>
          {entries.length > 0 ? entries.map((entry, index) => entry.kind === "tool"
            ? <div key={entry.id} className="subagent-entry-tool">
              <Wrench size={12} aria-hidden /><strong>{entry.text}</strong>{entry.detail ? <code title={entry.detail}>{entry.detail}</code> : null}
            </div>
            : entry.kind === "error"
              ? <div key={entry.id} className="subagent-entry-error" role="alert"><CircleAlert size={13} aria-hidden />{entry.text}</div>
              : <div key={entry.id} className="subagent-entry-text"><Markdown streaming={running && index === entries.length - 1}>{entry.text}</Markdown></div>)
            // A run recorded before steps were kept has only its joined text.
            : row.native?.transcript ? <div className="subagent-entry-text"><Markdown>{row.native.transcript}</Markdown></div>
              : <p className="subagent-view-empty" role="status">Waiting for activity…</p>}
          {running ? <p className="subagent-view-working"><span className="spinner small" aria-hidden />{row.lastTool ? `Working · ${row.lastTool}` : "Working"}</p> : null}
        </>}
      </div>
    </div>
    <footer className="subagent-bar">
      {row?.native?.runtime ? <ProviderIconStack runtimeProvider={row.native.runtime} hint={false} /> : <Bot size={16} aria-hidden />}
      <span className="subagent-bar-model">{row?.model ?? row?.native?.runtime ?? "Subagent"}</span>
      {row ? <span className={`subagent-bar-status status-${row.status}`}>
        {running ? <span className="spinner small" aria-hidden /> : null}{STATUS[row.status]} <Elapsed row={row} />
      </span> : null}
      <span className="subagent-bar-note">Runs on its own</span>
      <span className="spacer" />
      <Button variant="ghost" onClick={onClose}><ArrowUpLeft size={14} aria-hidden />Open parent</Button>
    </footer>
  </section>;
}
