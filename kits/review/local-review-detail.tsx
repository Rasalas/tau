import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GitMerge, MessageSquare, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import {
  errorMessage,
  formatCost,
  Markdown,
  ProviderIconStack,
  READ_ONLY_REASON,
  Skeleton,
  tooltipProps,
  useModelName,
  useThreadStore,
  type DiffLineSlot,
  type HostExtensionClient,
  type UiFileDiff,
  type WorkbenchActions,
} from "tau";
import { mergeBlocker, reviewRuntime, type LocalReview } from "./local-reviews.js";
import type { LocalReviewsStore, ReviewRun } from "./local-reviews-store.js";
import type { PendingReviewComment } from "./protocol.js";
import { lineKeys, orderFiles, threadKey } from "./pull-request-logic.js";
import { CheckIcon, ReplyBox } from "./pull-request-parts.js";
import { LayoutToggle, ReviewDetailFrame, useBackKeys, type FrameTab } from "./review-detail-frame.js";
import type { DetailNote, DetailParts, DetailState } from "./review-detail-store.js";
import { ReviewDiffStack, type StackFile } from "./review-diff-stack.js";
import { baseName, lineTarget, lineText } from "./review-lines.js";

/** What the page lets the detail do to a review; the list's rows share it. */
export interface LocalActions {
  merge(review: LocalReview): void;
  rebase(review: LocalReview): void;
  remove(review: LocalReview): void;
  busy: string | undefined;
  mayMerge: boolean;
  mayAsk: boolean;
  mayRemove: boolean;
}

type Tab = "changes" | "turns" | "checks";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const ALREADY: Record<NonNullable<LocalReview["mergedBy"]>, string> = {
  patches: "every commit's change is there already, under other commits (a cherry-pick, a rebase or rewritten history).",
  tree: "merging would change nothing (a squash merge).",
  request: "its pull request was merged on the host.",
};
const RUN_STATUS = { succeeded: "passed", failed: "failed", running: "pending", stopped: "cancelled" } as const;
const RUN_WORDS = { succeeded: "Passed", failed: "Failed", running: "Running", stopped: "Stopped" } as const;

/** A thread on another machine does not see this checkout's branch. */
const rebaseBlocker = (review: LocalReview, mayAsk: boolean) => !mayAsk ? READ_ONLY_REASON
  : review.remote ? `The thread runs on ${review.remote.machine}, where ${review.target} is not this checkout's; merge it by hand or send a note.`
  : !review.threadId ? "No thread works on this branch any more."
  : undefined;
const askBlocker = (review: LocalReview, mayAsk: boolean) => !mayAsk ? READ_ONLY_REASON
  : !review.threadId && !review.remote ? "No thread works on this branch any more." : undefined;

function ModelMark({ review }: { review: LocalReview }) {
  const catalog = useModelName(reviewRuntime(review), review.model, review.modelProvider);
  const label = catalog ?? review.model;
  return (
    <span className="rvd-model">
      <ProviderIconStack modelProvider={review.modelProvider} runtimeProvider={reviewRuntime(review)} runtimeMark={false} {...(label ? { modelName: label } : {})} hint={{ side: "top" }} />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

/** "Add the note": the words, the line they are about, and what the diff shows there. */
function noteMessage(held: readonly PendingReviewComment[]): string {
  return held.map((note) => [
    `\`${note.path}:${note.line}\`${note.side === "old" ? " (before the change)" : ""}`,
    ...(note.code ? ["```diff", note.code, "```"] : []),
    note.body,
  ].join("\n")).join("\n\n");
}

const sendLabel = (count: number) => count === 1 ? "Send to the thread" : count === 2 ? "Send both as one turn" : `Send all ${count} as one turn`;

async function openInEditor(workspace: HostExtensionClient, review: LocalReview, path: string): Promise<void> {
  const editors = await workspace.invoke("list-editors") as Array<{ id: string }> | undefined;
  const editorId = editors?.[0]?.id;
  if (!editorId) throw new Error("No supported editor found on PATH");
  await workspace.invoke("open-in-editor", { editorId, relPath: path, workspace: review.workspace });
}

interface Draft { path: string; line: number; side: "new" | "old"; code: string }

/**
 * A local review as design 1e draws it: the merge-request view a finished
 * thread lands on. Its files sit under each other, notes on their lines are
 * collected in the sidebar until they go to the thread, and a conflict (2e)
 * shows where and asks the thread to rebase.
 */
export function LocalReviewDetail({ review, parts, detail, act, actions, back }: {
  review: LocalReview;
  parts: { store: LocalReviewsStore; host: HostExtensionClient };
  detail: DetailParts;
  act: LocalActions;
  actions: WorkbenchActions;
  back(): void;
}) {
  const [summary, setSummary] = useState<{ summary?: string; turns?: number; prompts?: string[] }>();
  const [tab, setTab] = useState<Tab>("changes");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [noting, setNoting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [active, setActive] = useState<string>();
  const [jump, setJump] = useState<{ path: string; at: number }>();
  const jumps = useRef(0);
  const [sending, setSending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  let threads: ReturnType<typeof useThreadStore> | undefined;
  try { threads = useThreadStore(); } catch { threads = undefined; }
  const thread = review.threadId ? threads?.getThread(review.threadId) : undefined;
  const noteKey = `local:${review.key}`;
  const held = useSyncExternalStore(detail.notes.subscribe, () => detail.notes.comments(noteKey));
  const asked = askBlocker(review, act.mayAsk);
  useBackKeys(back);

  useEffect(() => {
    let live = true;
    setSummary(undefined);
    parts.store.summary(review).then((answer) => { if (live) setSummary(answer); }, () => { if (live) setSummary({}); });
    return () => { live = false; };
  }, [parts.store, review.key, review.tip]); // eslint-disable-line react-hooks/exhaustive-deps

  // The conflicting files first, as 2e shows them.
  const files = useMemo<StackFile[]>(() => {
    const ordered = orderFiles(review.paths).map((file) => ({ ...file, ...(review.conflicts.includes(file.path) ? { conflict: true } : {}) }));
    return [...ordered.filter((file) => file.conflict), ...ordered.filter((file) => !file.conflict)];
  }, [review.paths, review.conflicts]);
  const runs: ReviewRun[] = parts.store.latestRuns(review.path ?? "");

  const readDiff = useCallback((path: string): Promise<UiFileDiff> => parts.host.invoke("file-diff", { workspace: review.workspace, relPath: path, options: { scope: "branch", baseRef: review.target } }) as Promise<UiFileDiff>,
    [parts.host, review.workspace, review.target]);

  const sendNotes = useCallback(async (list: readonly PendingReviewComment[]) => {
    if (list.length === 0) return;
    setSending(true);
    try {
      await parts.store.ask(review, "note", noteMessage(list));
      for (const note of list) detail.notes.remove(noteKey, note.id);
      actions.toast?.({ type: "success", title: list.length === 1 ? "Note sent to the thread" : `${list.length} notes sent to the thread as one turn`, description: review.title });
    } catch (error) {
      actions.toast?.({ type: "error", title: "The notes were not sent", description: errorMessage(error) });
    } finally {
      setSending(false);
    }
  }, [actions, detail.notes, noteKey, parts.store, review]);

  const notes = useMemo<DetailNote[]>(() => held.map((note) => ({ id: note.id, label: `${baseName(note.path)}:${note.line}`, text: note.body })), [held]);
  const heldRef = useRef(held);
  heldRef.current = held;
  const sendRef = useRef(sendNotes);
  sendRef.current = sendNotes;
  const state = useMemo<DetailState>(() => ({
    key: review.key,
    kind: "local",
    files: files.map((file) => ({ path: file.path, added: file.added, removed: file.removed, ...(file.conflict ? { conflict: true } : {}) })),
    moreFiles: Math.max(0, review.files - review.paths.length),
    turnsHeading: "Turns",
    turns: summary?.prompts ?? [],
    notes,
    sendLabel: sendLabel(notes.length),
    ...(asked ? { sendDisabled: asked } : sending ? { sendDisabled: "Sending…" } : {}),
    ...(active ? { active } : {}),
  }), [active, asked, files, notes, review.files, review.key, review.paths.length, sending, summary?.prompts]);
  useEffect(() => {
    detail.store.publish(state, {
      jump: (path) => { setTab("changes"); setJump({ path, at: ++jumps.current }); },
      sendAll: () => { void sendRef.current(heldRef.current); },
      sendNote: (id) => { void sendRef.current(heldRef.current.filter((note) => note.id === id)); },
      removeNote: (id) => detail.notes.remove(noteKey, id),
    });
  }, [detail.store, detail.notes, noteKey, state]);
  useEffect(() => () => detail.store.retire(review.key), [detail.store, review.key]);

  const heldAt = useMemo(() => {
    const map = new Map<string, PendingReviewComment[]>();
    for (const note of held) {
      const key = threadKey(note.path, note.side, note.line);
      map.set(key, [...map.get(key) ?? [], note]);
    }
    return map;
  }, [held]);

  const slots = useMemo(() => {
    const cache = new Map<string, DiffLineSlot>();
    return (path: string): DiffLineSlot | undefined => {
      if (asked || !review.workspace) return undefined;
      const known = cache.get(path);
      if (known) return known;
      const at = (line: Parameters<typeof lineKeys>[1]) => lineKeys(path, line).flatMap((key) => heldAt.get(key) ?? []);
      const drafting = (line: Parameters<typeof lineKeys>[1]) => draft?.path === path && lineTarget(line)?.line === draft.line && lineTarget(line)?.side === draft.side;
      const slot: DiffLineSlot = {
        onAction: ({ line }) => {
          const target = lineTarget(line);
          if (target) setDraft({ path, ...target, code: lineText(line) });
        },
        actionLabel: ({ line }) => line.newLine !== undefined ? `Note on line ${line.newLine}` : `Note on removed line ${line.oldLine}`,
        count: ({ line }) => at(line).length,
        selected: ({ line }) => drafting(line),
        render: ({ line }) => {
          const mine = at(line);
          const editing = drafting(line) ? draft : undefined;
          if (mine.length === 0 && !editing) return null;
          return (
            <div className="rvd-line-slot">
              {mine.map((note) => (
                <div key={note.id} className="rvd-note" role="group" aria-label={`Note on line ${note.line}`}>
                  <span className="rvd-note-body"><strong>You</strong> {note.body}</span>
                  <span className="rvd-note-actions">
                    <button type="button" className="text-button" disabled={sending} onClick={() => void sendRef.current([note])}>Send to the thread</button>
                    <button type="button" className="text-button" onClick={() => detail.notes.remove(noteKey, note.id)}>Remove</button>
                  </span>
                </div>
              ))}
              {editing ? (
                <ReplyBox
                  label={`Note on line ${editing.line}`}
                  placeholder="Reply — this goes to the thread as a turn"
                  submitLabel="Add note"
                  onSubmit={async (text) => { detail.notes.add(noteKey, { path: editing.path, line: editing.line, side: editing.side, body: text, code: editing.code }); setDraft(undefined); }}
                  onCancel={() => setDraft(undefined)}
                  extra={(text) => (
                    <button type="button" className="text-button" disabled={!text.trim() || sending} onClick={() => {
                      const now = { id: "now", path: editing.path, line: editing.line, side: editing.side, body: text.trim(), code: editing.code };
                      setDraft(undefined);
                      void sendRef.current([now]);
                    }}>Send now</button>
                  )}
                />
              ) : null}
            </div>
          );
        },
      };
      cache.set(path, slot);
      return slot;
    };
    // The slots follow what they draw: the notes and the line being written.
  }, [asked, detail.notes, draft, heldAt, noteKey, review.workspace, sending]);

  const blocked = !act.mayMerge ? READ_ONLY_REASON : mergeBlocker(review);
  const busy = act.busy === review.key;
  const merged = review.state === "merged";
  const checks = review.checks;
  const passed = checks ? checks.failed > 0 ? `${checks.failed} failed` : checks.running > 0 ? `${checks.running} running` : `${checks.passed} passed` : undefined;
  const tabs: FrameTab<Tab>[] = [
    { id: "changes", label: "Changes" },
    { id: "turns", label: "Turns", ...(summary?.turns ? { aside: summary.turns } : {}) },
    { id: "checks", label: "Checks", ...(passed ? { aside: `· ${passed}` } : {}) },
  ];

  const sendNote = async (text: string) => {
    await parts.store.ask(review, "note", text);
    setNoting(false);
    actions.toast?.({ type: "success", title: "Note sent to the thread", description: review.title });
  };

  const meta = (
    <>
      <span className="rvd-mono">{review.remote ? `${review.remote.machine}: ` : ""}{review.branch}</span>
      {review.target ? <><span aria-hidden="true">→</span><span className="rvd-mono" data-off={review.offDefault ? "" : undefined} {...(review.offDefault ? tooltipProps(`Not ${review.offDefault}: Merge lands on the branch the project's checkout has out.`) : {})}>{review.target}</span></> : null}
      <span aria-hidden="true">·</span>
      <span>{plural(review.files, "file")}</span>
      <span className="stat-add">+{review.added}</span>
      <span className="stat-del">−{review.removed}</span>
      {review.model ? <><span aria-hidden="true">·</span><ModelMark review={review} /></> : null}
      {review.costUsd !== undefined ? <><span aria-hidden="true">·</span><span className="rvd-mono">{formatCost(review.costUsd) ?? "$0.00"}</span></> : null}
      {review.behind > 0 ? <span className="rvd-behind"><TriangleAlert size={11} aria-hidden="true" />{review.target} moved {plural(review.behind, "commit")} since this branch started</span> : null}
      {review.uncommitted ? <span className="rvd-behind"><TriangleAlert size={11} aria-hidden="true" />{review.uncommitted} not committed</span> : null}
    </>
  );

  const buttons = merged ? (
    <>
      {thread ? <button type="button" className="rvd-ghost" onClick={() => { void actions.switchSession(thread.path); }}>Open thread</button> : null}
      {review.workspace && !review.remote ? (
        <button type="button" className="rvd-ghost" disabled={!act.mayRemove || removing} {...tooltipProps(act.mayRemove ? `Removes the worktree and deletes ${review.branch}; ${review.target} holds its work` : READ_ONLY_REASON)} onClick={() => setRemoving(true)}>
          <Trash2 size={12} aria-hidden="true" /> Remove worktree and branch
        </button>
      ) : null}
    </>
  ) : (
    <>
      {thread ? <button type="button" className="rvd-ghost" onClick={() => { void actions.switchSession(thread.path); }}>Open thread</button> : null}
      {review.conflicts.length > 0 ? (
        <button type="button" className="rvd-secondary" disabled={Boolean(rebaseBlocker(review, act.mayAsk)) || busy} {...tooltipProps(rebaseBlocker(review, act.mayAsk) ?? `Asks the thread to rebase onto ${review.target}`)} onClick={() => act.rebase(review)}>
          <RefreshCw size={12} aria-hidden="true" /> Ask the thread to rebase
        </button>
      ) : null}
      <button type="button" className="rvd-ghost" disabled={Boolean(asked) || noting} {...tooltipProps(asked ?? "Send the thread a note on what to change")} onClick={() => setNoting(true)}>
        <MessageSquare size={12} aria-hidden="true" /> Request changes
      </button>
      <button type="button" className="rvd-primary" disabled={Boolean(blocked) || busy} {...tooltipProps(blocked ?? `Merge ${review.branch} into ${review.target} (a merge commit, after checking it merges cleanly)`)} onClick={() => act.merge(review)}>
        <GitMerge size={12} aria-hidden="true" /> {busy ? "Merging…" : `Merge into ${review.target || "the target"}`}
      </button>
    </>
  );

  const notices = (
    <>
      {review.ask ? (
        <div className="rv-ask-open rvd-notice" role="status">
          {review.ask.kind === "note" ? <MessageSquare size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          <span>{review.ask.kind === "note" ? <>Your note: {review.ask.text}</> : "You asked the thread to rebase."} It shows here until the thread commits again.</span>
          <button type="button" disabled={!act.mayAsk} onClick={() => { void parts.store.withdraw(review).catch((error) => actions.notify(errorMessage(error))); }}>Withdraw</button>
        </div>
      ) : null}
      {review.mergedBy ? <p className="rv-already rvd-notice" role="status"><GitMerge size={13} aria-hidden="true" /> Already in {review.target}: {ALREADY[review.mergedBy]}</p> : null}
      {review.conflicts.length > 0 ? (
        <p className="rv-conflicts rvd-notice" role="status">
          <TriangleAlert size={13} aria-hidden="true" /> Conflicts with {review.target} in {plural(review.conflicts.length, "file")}. Ask the thread to rebase: it re-runs the checks and comes back here.
        </p>
      ) : null}
      {removing ? (
        <div className="rvd-notice rvd-confirm" role="group" aria-label="Remove">
          <span>Remove the worktree and delete {review.branch}? The threads stay.</span>
          <button type="button" onClick={() => setRemoving(false)}>Cancel</button>
          <button type="button" className="danger" disabled={busy} onClick={() => act.remove(review)}>{busy ? "Removing…" : "Remove"}</button>
        </div>
      ) : null}
      {noting ? <NoteBox onCancel={() => setNoting(false)} onSend={sendNote} /> : null}
    </>
  );

  return (
    <ReviewDetailFrame<Tab>
      label={review.title}
      title={review.title}
      meta={meta}
      actions={buttons}
      summary={summary === undefined ? <Skeleton className="rv-summary-skeleton" /> : summary.summary ? <Markdown>{summary.summary}</Markdown> : <p className="rvd-muted">The thread left no summary.</p>}
      notices={notices}
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      toolbar={tab === "changes" ? <LayoutToggle layout={layout} onChange={setLayout} /> : null}
      scrollRef={scroll}
    >
      {tab === "changes" ? (
        <>
          <ReviewDiffStack
            files={files}
            layout={layout}
            wrap
            read={readDiff}
            version={review.tip ?? ""}
            lines={slots}
            {...(review.workspace && !review.remote ? { onOpenInEditor: (path: string) => { void openInEditor(detail.workspace, review, path).catch((error) => actions.notify(errorMessage(error))); } } : {})}
            jump={jump}
            onActive={setActive}
            {...(review.workspace ? {} : { unavailable: review.remote ? `This branch came back from ${review.remote.machine}; its diff is not read here.` : "The worktree is gone; the diff is not available." })}
            scroll={scroll}
          />
          {review.files > review.paths.length && review.paths.length > 0 ? <p className="rvd-more">and {plural(review.files - review.paths.length, "more file")}</p> : null}
          {review.paths.length === 0 ? <p className="rvd-empty">{review.files > 0 ? `${plural(review.files, "file")} changed; the list of them is not available.` : "No file changes."}</p> : null}
        </>
      ) : tab === "turns" ? (
        <TurnsList prompts={summary?.prompts} loading={summary === undefined} />
      ) : (
        <RunsList runs={runs} />
      )}
    </ReviewDetailFrame>
  );
}

function NoteBox({ onCancel, onSend }: { onCancel(): void; onSend(text: string): Promise<void> }) {
  return (
    <div className="rvd-notice rvd-request">
      <ReplyBox label="Note to the thread" placeholder="What should the thread change?" submitLabel="Send to thread" onSubmit={onSend} onCancel={onCancel} />
    </div>
  );
}

function TurnsList({ prompts, loading }: { prompts: readonly string[] | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="rv-summary-skeleton" />;
  if (!prompts?.length) return <p className="rvd-empty">The thread's turns are not available.</p>;
  return (
    <ol className="rvd-turns" aria-label="Turns">
      {prompts.map((title, index) => <li key={index}><span>{index + 1}</span><span>{title}</span></li>)}
    </ol>
  );
}

function RunsList({ runs }: { runs: readonly ReviewRun[] }) {
  if (runs.length === 0) return <p className="rvd-empty">No checks ran in this worktree. Project Scripts' runs show here.</p>;
  return (
    <ul className="rvd-runs" aria-label="Checks">
      {runs.map((run) => (
        <li key={run.name}>
          <CheckIcon status={RUN_STATUS[run.status]} />
          <span>{run.name}</span>
          <span className={`rvd-run-status ${RUN_STATUS[run.status]}`}>{RUN_WORDS[run.status]}</span>
        </li>
      ))}
    </ul>
  );
}
