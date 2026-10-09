import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUpLeft, Bot, CircleAlert, Wrench } from "lucide-react";
import { Button, Markdown, ProviderIconStack, ThreadTranscript, useThreadStore, useWorkbench, type ConversationViewProps, type WorkbenchActions } from "tau";
import { formatElapsed, nativeAgentRow, nativeAgentTools, type AgentRow } from "./model.js";
import { isBusyStatus, type AgentThreadStatus } from "./protocol.js";
import { agentsStore } from "./store.js";

export const SUBAGENT_VIEW = "agents.subagent";

const STATUS: Record<AgentThreadStatus, string> = { running: "Running", waiting: "Waiting", pending: "Queued", completed: "Done", idle: "Done", failed: "Failed", cancelled: "Cancelled" };

/** The child the conversation column shows (a native run's tool id or a thread id), so its row in the lineage can say so. */
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

/** What `openedSubagent` holds for a row. */
export function subagentKey(row: AgentRow): string | undefined {
  return row.native ? row.id : row.threadId;
}

/**
 * Opens a child in place of the parent's transcript, as T3 Code does; a child on
 * another machine, or a core without conversation views, gets a stage tab.
 */
export function openAgent(row: AgentRow, actions: WorkbenchActions): void {
  if (row.native) actions.openConversationView?.(SUBAGENT_VIEW, { toolId: row.id });
  else if (row.threadId && actions.openConversationView) actions.openConversationView(SUBAGENT_VIEW, { threadId: row.threadId });
  else if (row.threadId) actions.openThread(row.threadId);
  else if (row.machine?.thread) actions.openThread(row.machine.thread, { machine: row.machine.id });
}

type Timing = Pick<AgentRow, "status" | "startedAt" | "endedAt">;

function Elapsed({ row }: { row: Timing }) {
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

function Head({ title, meta }: { title: string; meta: string }) {
  return <header className="subagent-view-head">
    <h2>{title}</h2>
    {meta ? <small>{meta}</small> : null}
  </header>;
}

/** Where the composer stands in a thread: what runs, and the way back. */
function Bar({ mark, model, timing, onClose }: { mark: ReactNode; model: string; timing: Timing | undefined; onClose(): void }) {
  return <footer className="subagent-bar">
    {mark ?? <Bot size={16} aria-hidden />}
    <span className="subagent-bar-model">{model}</span>
    {timing ? <span className={`subagent-bar-status status-${timing.status}`}>
      {isBusyStatus(timing.status) ? <span className="spinner small" aria-hidden /> : null}{STATUS[timing.status]} <Elapsed row={timing} />
    </span> : null}
    <span className="subagent-bar-note">Runs on its own</span>
    <span className="spacer" />
    <Button variant="ghost" onClick={onClose}><ArrowUpLeft size={14} aria-hidden />Open parent</Button>
  </footer>;
}

/**
 * A child in place of the parent's transcript. It takes no prompts: a native
 * run (Claude Code's Agent tool, a Codex child) reads from the parent's tool
 * run, a child thread from its own transcript.
 */
export function SubagentView(props: ConversationViewProps) {
  const threadId = typeof props.params.threadId === "string" ? props.params.threadId : undefined;
  const key = threadId ?? (typeof props.params.toolId === "string" ? props.params.toolId : "");
  useEffect(() => {
    openedSubagent.set(key);
    return () => openedSubagent.set(undefined);
  }, [key]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || (event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
    // Not to the window, where Escape stops the parent's run.
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };
  return <div className="subagent-view-keys" onKeyDown={onKeyDown}>
    {threadId ? <ChildThread {...props} threadId={threadId} /> : <NativeChild {...props} toolId={key} />}
  </div>;
}

function NativeChild({ snapshot, toolId, onClose }: ConversationViewProps & { toolId: string }) {
  const { tools } = useWorkbench();
  const tool = nativeAgentTools(snapshot?.turnActivityHistory, tools).get(toolId);
  const row = tool ? nativeAgentRow(tool) : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atTail = useRef(true);
  const entries = row?.native?.entries ?? [];
  const running = row ? isBusyStatus(row.status) : false;
  // Opens at the latest step and follows the run while the reader stays there.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && atTail.current) node.scrollTop = node.scrollHeight;
  }, [tool?.output, entries.length]);

  const title = row?.title ?? "Subagent";
  return <section className="subagent-view" aria-label={`Subagent ${title}`}>
    <div className="subagent-view-scroll" ref={scrollRef} tabIndex={-1}
      onScroll={(event) => { const node = event.currentTarget; atTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}
    >
      <div className="subagent-view-inner">
        <ParentDivider title={snapshot?.sessionTitle || "Parent thread"} onOpen={onClose} />
        {!row ? <p className="subagent-view-empty" role="status">This subagent is not part of the thread any more.</p> : <>
          <Head title={title} meta={[row.native?.runtime, row.model].filter(Boolean).join(" · ")} />
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
    <Bar
      mark={row?.native?.runtime ? <ProviderIconStack runtimeProvider={row.native.runtime} hint={false} /> : null}
      model={row?.model ?? row?.native?.runtime ?? "Subagent"}
      timing={row}
      onClose={onClose}
    />
  </section>;
}

/** A child Tau started as a thread of its own (a runtime without native delegation), read-only. */
function ChildThread({ snapshot, threadId, onClose }: ConversationViewProps & { threadId: string }) {
  const store = useThreadStore();
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activity = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const agents = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const session = navigation.threads.find((thread) => thread.id === threadId);
  const link = agents?.links.find((entry) => entry.threadId === threadId);
  const status: AgentThreadStatus = link?.status ?? (activity.runningThreadIds.includes(threadId) ? "running" : "idle");
  const model = link?.model ?? (session?.model ? `${session.modelProvider ? `${session.modelProvider}/` : ""}${session.model}` : undefined);
  const title = session?.title || link?.title || "Subagent";
  return <section className="subagent-view subagent-thread" aria-label={`Subagent ${title}`}>
    <div className="subagent-view-top">
      <div className="subagent-view-inner">
        <ParentDivider title={snapshot?.sessionTitle || "Parent thread"} onOpen={onClose} />
        <Head title={title} meta={link?.agent ?? ""} />
      </div>
    </div>
    <div className="subagent-thread-transcript"><ThreadTranscript sessionId={threadId} /></div>
    <Bar
      mark={session?.modelProvider ? <ProviderIconStack modelProvider={session.modelProvider} runtimeMark={false} hint={false} /> : null}
      model={model?.split("/").at(-1) ?? "Subagent"}
      timing={{ status, ...(link?.startedAt ? { startedAt: link.startedAt } : {}), ...(link?.endedAt ? { endedAt: link.endedAt } : {}) }}
      onClose={onClose}
    />
  </section>;
}
