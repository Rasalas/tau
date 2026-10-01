import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, GitCommitHorizontal, GitMerge, MessageSquare, Pencil, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import {
  errorMessage,
  formatCost,
  Markdown,
  ProviderIconStack,
  READ_ONLY_REASON,
  Skeleton,
  tooltipProps,
  useCommandAllowed,
  useModelName,
  useThreadStore,
  type DiffLineSlot,
  type HostExtensionClient,
  type UiFileDiff,
  type WorkbenchActions,
} from "tau";
import { mergeBlocker, reviewRuntime, type ConflictFile, type HunkPick, type LocalReview, type NoteThread } from "./local-reviews.js";
import type { LocalReviewsStore, ReviewRun } from "./local-reviews-store.js";
import { REVIEW_HOST_EXTENSION_ID, type PendingReviewComment } from "./protocol.js";
import { lineKeys, orderFiles, threadKey } from "./pull-request-logic.js";
import { ReplyBox } from "./pull-request-parts.js";
import { runsPipeline } from "./pipeline.js";
import { PipelineGraph, PipelineMini } from "./pipeline-view.js";
import { LayoutToggle, ReviewDetailFrame, useBackKeys, type FrameTab } from "./review-detail-frame.js";
import type { DetailNote, DetailParts, DetailState } from "./review-detail-store.js";
import { ReviewDiffStack, type StackFile } from "./review-diff-stack.js";
import { baseName, lineTarget, lineText, noteMessage } from "./review-lines.js";
import { ALREADY, askBlocker, plural, rebaseBlocker } from "./review-words.js";

/** What the page lets the detail do to a review; the list's rows share it. */
export interface LocalActions {
  merge(review: LocalReview, picks?: Record<string, HunkPick[]>): void;
  rebase(review: LocalReview): void;
  remove(review: LocalReview): void;
  busy: string | undefined;
  mayMerge: boolean;
  mayAsk: boolean;
  mayRemove: boolean;
}

type Tab = "changes" | "turns" | "checks";


function ModelMark({ review, bare }: { review: LocalReview; bare?: boolean }) {
  const catalog = useModelName(reviewRuntime(review), review.model, review.modelProvider);
  const label = catalog ?? review.model;
  return (
    <span className="rvd-model">
      <ProviderIconStack modelProvider={review.modelProvider} runtimeProvider={reviewRuntime(review)} runtimeMark={false} {...(label ? { modelName: label } : {})} hint={{ side: "top" }} />
      {label && !bare ? <span>{label}</span> : null}
    </span>
  );
}

const PICKED: Record<string, string> = { thread: "Kept this thread", main: "Kept ", both: "Both kept" };
const KEEP = { thread: "Keep this thread", main: "Keep ", both: "Keep both" };

/** One conflicting file as 2e draws it: each hunk's two sides and a pick under them. */
function ConflictHunks({ file, target, picks, onPick }: { file?: ConflictFile; target: string; picks: readonly (HunkPick | undefined)[]; onPick(index: number, pick: HunkPick | undefined): void }) {
  const [editing, setEditing] = useState<number>();
  if (!file) return <div className="rvd-loading" role="status" aria-label="Loading the conflicts" />;
  if (file.unpickable) return <p className="rvd-note-line">{file.unpickable} Ask the thread to rebase.</p>;
  const line = (key: string, number: number, text: string, side = "") => <div key={key} className={`rvd-cline ${side}`}><span>{number}</span><code>{text}</code></div>;
  return (
    <div className="rvd-hunks">
      {file.hunks.map((hunk, index) => {
        const pick = picks[index];
        return (
          <div key={index} role="group" aria-label={`Hunk ${index + 1} of ${file.hunks.length}`}>
            {hunk.before !== undefined ? line("b", hunk.mainLine - 1, hunk.before) : null}
            <div className="rvd-hunk-head">Hunk {index + 1} of {file.hunks.length}</div>
            {hunk.thread.map((text, at) => line(`t${at}`, hunk.threadLine + at, text, "thread"))}
            {hunk.main.map((text, at) => line(`m${at}`, hunk.mainLine + at, text, "main"))}
            <div className="rvd-picks">
              {editing === index && typeof pick === "object" ? <>
                <textarea aria-label={`Hunk ${index + 1} by hand`} value={pick.text} rows={pick.text.split("\n").length + 1} onChange={(event) => onPick(index, { text: event.target.value })} />
                <button type="button" onClick={() => setEditing(undefined)}>Done</button>
              </> : pick ? <>
                <span className="rvd-picked"><Check size={12} aria-hidden="true" /> {typeof pick === "object" ? "Edited by hand" : PICKED[pick]}{pick === "main" ? target : ""}</span>
                <button type="button" onClick={() => onPick(index, undefined)}>Change</button>
              </> : <>
                {(["thread", "main", "both"] as const).map((side) => <button key={side} type="button" onClick={() => onPick(index, side)}>{KEEP[side]}{side === "main" ? target : ""}</button>)}
                <button type="button" onClick={() => { onPick(index, { text: [...hunk.thread, ...hunk.main].join("\n") }); setEditing(index); }}><Pencil size={12} aria-hidden="true" /> Edit by hand</button>
              </>}
            </div>
            {hunk.after !== undefined ? line("a", hunk.mainLine + hunk.main.length, hunk.after) : null}
          </div>
        );
      })}
    </div>
  );
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
export function LocalReviewDetail({ review, parts, detail, act, actions, back, focus }: {
  review: LocalReview;
  parts: { store: LocalReviewsStore; host: HostExtensionClient };
  detail: DetailParts;
  act: LocalActions;
  actions: WorkbenchActions;
  back(): void;
  /** Opened at its checks. */
  focus?: "checks" | undefined;
}) {
  const [summary, setSummary] = useState<{ summary?: string; turns?: number; prompts?: string[] }>();
  const [tab, setTab] = useState<Tab>(focus ?? "changes");
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
  const mayCommit = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "local-review-commit");
  const [committing, setCommitting] = useState(false);
  const picking = review.conflicts.length > 0 && review.state !== "merged" && Boolean(review.workspace) && !review.remote;
  const [conflicts, setConflicts] = useState<{ tip: string; files: ConflictFile[] }>();
  const [picks, setPicks] = useState<Record<string, (HunkPick | undefined)[]>>({});
  const [sent, setSent] = useState<NoteThread[]>([]);
  useBackKeys(back);

  useEffect(() => {
    let live = true;
    setPicks({});
    if (picking) parts.store.conflicts(review).then((answer) => { if (live) setConflicts(answer); }, (error) => { if (live) actions.notify(errorMessage(error)); });
    if (!review.remote) parts.store.notes(review).then((answer) => { if (live) setSent(Array.isArray(answer) ? answer : []); }, () => undefined);
    return () => { live = false; };
  }, [parts.store, review.key, review.tip, picking]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // A file only the worktree holds has no commit to read against the target.
  const readDiff = useCallback((path: string): Promise<UiFileDiff> => parts.host.invoke("file-diff", {
    workspace: review.workspace,
    relPath: path,
    options: review.paths.find((entry) => entry.path === path)?.uncommitted ? {} : { scope: "branch", baseRef: review.target },
  }) as Promise<UiFileDiff>, [parts.host, review.workspace, review.target, review.paths]);

  const sendNotes = useCallback(async (list: readonly PendingReviewComment[]) => {
    if (list.length === 0) return;
    setSending(true);
    try {
      await parts.store.ask(review, "note", noteMessage(list), list.map(({ id, path, line, side, body }) => ({ id, note: id, path, line, side, body })));
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
    files: files.map((file) => {
      const hunks = conflicts?.files.find((entry) => entry.path === file.path)?.hunks.length;
      return { path: file.path, added: file.added, removed: file.removed, ...(file.conflict ? { conflict: true } : {}), ...(hunks ? { hunks } : {}) };
    }),
    moreFiles: Math.max(0, review.files - review.paths.length),
    turnsHeading: "Turns",
    turns: summary?.prompts ?? [],
    notes,
    sendLabel: sendLabel(notes.length),
    ...(asked ? { sendDisabled: asked } : sending ? { sendDisabled: "Sending…" } : {}),
    ...(active ? { active } : {}),
  }), [active, asked, conflicts, files, notes, review.files, review.key, review.paths.length, sending, summary?.prompts]);
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
  const sentAt = useMemo(() => {
    const map = new Map<string, NoteThread[]>();
    for (const entry of sent) {
      const key = threadKey(entry.path, entry.side, entry.line);
      map.set(key, [...map.get(key) ?? [], entry]);
    }
    return map;
  }, [sent]);
  const reply = useCallback(async (entry: NoteThread, body: string) => {
    await parts.store.ask(review, "note", noteMessage([{ ...entry, body }]), [{ id: crypto.randomUUID(), note: entry.id, path: entry.path, line: entry.line, side: entry.side, body }]);
    setSent((current) => current.map((item) => item.id === entry.id ? { ...item, said: [...item.said, { body, at: Date.now() }] } : item));
  }, [parts.store, review]);

  const slots = useMemo(() => {
    const cache = new Map<string, DiffLineSlot>();
    return (path: string): DiffLineSlot | undefined => {
      if (asked || !review.workspace) return undefined;
      const known = cache.get(path);
      if (known) return known;
      const at = (line: Parameters<typeof lineKeys>[1]) => lineKeys(path, line).flatMap((key) => heldAt.get(key) ?? []);
      const talks = (line: Parameters<typeof lineKeys>[1]) => lineKeys(path, line).flatMap((key) => sentAt.get(key) ?? []);
      const drafting = (line: Parameters<typeof lineKeys>[1]) => draft?.path === path && lineTarget(line)?.line === draft.line && lineTarget(line)?.side === draft.side;
      const slot: DiffLineSlot = {
        onAction: ({ line }) => {
          const target = lineTarget(line);
          if (target) setDraft({ path, ...target, code: lineText(line) });
        },
        actionLabel: ({ line }) => line.newLine !== undefined ? `Note on line ${line.newLine}` : `Note on removed line ${line.oldLine}`,
        count: ({ line }) => at(line).length + talks(line).length,
        selected: ({ line }) => drafting(line),
        render: ({ line }) => {
          const mine = at(line);
          const said = talks(line);
          const editing = drafting(line) ? draft : undefined;
          if (mine.length === 0 && said.length === 0 && !editing) return null;
          return (
            <div className="rvd-line-slot">
              {said.map((entry) => (
                <div key={entry.id} className="rvd-note" role="group" aria-label={`Note on line ${entry.line}, sent`}>
                  {entry.said.map((turn, index) => (
                    <Fragment key={index}>
                      <span className="rvd-note-body"><strong>You</strong> {turn.body}</span>
                      {turn.answer ? <span className="rvd-note-body rvd-answer"><ModelMark review={review} bare /> {turn.answer}</span>
                        : index === entry.said.length - 1 ? <span className="rvd-muted">The thread has not answered yet.</span> : null}
                    </Fragment>
                  ))}
                  <ReplyBox label={`Reply on line ${entry.line}`} placeholder="Reply — this goes to the thread as a turn" submitLabel="Reply" autoFocus={false} onSubmit={(text) => reply(entry, text)} onCancel={() => undefined} />
                </div>
              ))}
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
                      const now = { id: crypto.randomUUID(), path: editing.path, line: editing.line, side: editing.side, body: text.trim(), code: editing.code };
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
  }, [asked, detail.notes, draft, heldAt, noteKey, reply, review, sending, sentAt]);

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

  const unpicked = conflicts?.files.every((file) => !file.unpickable && file.hunks.every((_, index) => picks[file.path]?.[index])) ? undefined : "Merge unlocks when every hunk has a pick.";
  const mergePicks = () => {
    if (!conflicts || conflicts.tip !== review.tip) return;
    act.merge(review, Object.fromEntries(conflicts.files.map((file) => [file.path, picks[file.path] as HunkPick[]])));
  };
  const commitBlocked = !mayCommit ? READ_ONLY_REASON : review.remote || !review.workspace ? "The worktree is not on this computer." : review.uncommitted ? undefined : "Nothing to commit: the thread committed its work.";
  const commit = () => {
    setCommitting(true);
    parts.store.commit(review).then(
      (result) => actions.toast?.({ type: "success", title: `Committed on ${review.branch}`, description: result.detail }),
      (error) => actions.toast?.({ type: "error", title: "Nothing was committed", description: errorMessage(error) }),
    ).finally(() => { setCommitting(false); void parts.store.refresh(); });
  };

  const sendNote = async (text: string) => {
    await parts.store.ask(review, "note", text);
    setNoting(false);
    actions.toast?.({ type: "success", title: "Note sent to the thread", description: review.title });
  };

  const meta = (
    <>
      <span className="rvd-mono">{review.remote ? `${review.remote.machine}: ` : ""}{review.branch}</span>
      {review.target ? <><span aria-hidden="true">→</span><span className="rvd-mono" data-off={review.offDefault ? "" : undefined} {...(review.offDefault ? tooltipProps(`Not ${review.offDefault}: Merge lands on the branch the project's checkout has out.`) : {})}>{review.target}</span></> : null}
      {picking ? null : <>
      <span aria-hidden="true">·</span>
      <span>{plural(review.files, "file")}</span>
      <span className="stat-add">+{review.added}</span>
      <span className="stat-del">−{review.removed}</span>
      {review.model ? <><span aria-hidden="true">·</span><ModelMark review={review} /></> : null}
      {review.costUsd !== undefined ? <><span aria-hidden="true">·</span><span className="rvd-mono">{formatCost(review.costUsd) ?? "$0.00"}</span></> : null}
      </>}
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
        <button type="button" className={picking ? "rvd-ghost rvd-strong" : "rvd-secondary"} disabled={Boolean(rebaseBlocker(review, act.mayAsk)) || busy} {...tooltipProps(rebaseBlocker(review, act.mayAsk) ?? `Asks the thread to rebase onto ${review.target}`)} onClick={() => act.rebase(review)}>
          <RefreshCw size={12} aria-hidden="true" /> Ask the thread to rebase
        </button>
      ) : null}
      {picking ? (
        <button type="button" className="rvd-primary" disabled={Boolean(unpicked) || busy} {...tooltipProps(unpicked ?? `Merge ${review.branch} into ${review.target} with your pick in every hunk`)} onClick={mergePicks}>
          <GitMerge size={12} aria-hidden="true" /> {busy ? "Merging…" : "Merge with my picks"}
        </button>
      ) : <>
        <button type="button" className="rvd-ghost" disabled={Boolean(asked) || noting} {...tooltipProps(asked ?? "Send the thread a note on what to change")} onClick={() => setNoting(true)}>
          <MessageSquare size={12} aria-hidden="true" /> Request changes
        </button>
        <button type="button" className="rvd-ghost rvd-strong" disabled={Boolean(commitBlocked) || committing} {...tooltipProps(commitBlocked ?? `Commits the ${plural(review.uncommitted, "file")} not committed in the worktree on ${review.branch}; nothing is merged`)} onClick={commit}>
          <GitCommitHorizontal size={12} aria-hidden="true" /> {committing ? "Committing…" : "Commit only"}
        </button>
        <button type="button" className="rvd-primary" disabled={Boolean(blocked) || busy} {...tooltipProps(blocked ?? `Merge ${review.branch} into ${review.target} (a merge commit, after checking it merges cleanly)`)} onClick={() => act.merge(review)}>
          <GitMerge size={12} aria-hidden="true" /> {busy ? "Merging…" : `Merge into ${review.target || "the target"}`}
        </button>
      </>}
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
      {review.conflicts.length > 0 && !picking ? (
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
      beside={runs.length ? <PipelineMini pipelines={[runsPipeline(runs)]} onOpen={() => setTab("checks")} /> : null}
      meta={meta}
      actions={buttons}
      summary={picking ? <p>{plural(review.conflicts.length, "file")} changed on both sides. Pick a side per hunk, or hand it back — the thread rebases, re-runs the checks and comes back here. Merge unlocks when every hunk has a pick.</p>
        : summary === undefined ? <Skeleton className="rv-summary-skeleton" /> : summary.summary ? <Markdown>{summary.summary}</Markdown> : <p className="rvd-muted">The thread left no summary.</p>}
      notices={notices}
      tabs={picking ? [] : tabs}
      tab={tab}
      onTab={setTab}
      toolbar={tab === "changes" && !picking ? <LayoutToggle layout={layout} onChange={setLayout} /> : null}
      scrollRef={scroll}
    >
      {tab === "changes" || picking ? (
        <>
          <ReviewDiffStack
            files={files}
            layout={layout}
            wrap
            read={readDiff}
            version={review.tip ?? ""}
            lines={slots}
            {...(picking ? {
              body: (file: StackFile) => file.conflict ? <ConflictHunks file={conflicts?.files.find((entry) => entry.path === file.path)} target={review.target} picks={picks[file.path] ?? []} onPick={(index, pick) => setPicks((current) => {
                const next = [...current[file.path] ?? []];
                next[index] = pick;
                return { ...current, [file.path]: next };
              })} /> : undefined,
              extra: (file: StackFile) => file.conflict ? <span className="rvd-legend"><i className="thread" />this thread<i className="main" />{review.target}</span> : null,
            } : {})}
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
        <div className="rvd-pad"><PipelineGraph pipelines={runs.length ? [runsPipeline(runs)] : []} actions={actions} empty="No checks ran in this worktree. Project Scripts' runs show here." /></div>
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
