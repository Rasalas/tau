import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Check, Circle, Sparkles, X } from "lucide-react";
import { Dialog, errorMessage, FileKindIcon, Spinner, tooltipProps, type HostExtensionClient, type PreferencesStore, type RegionProps, type UiFileDiff, type WorkbenchActions } from "tau";
import { chosenWritingModel, followRequestTemplate, writingInstructions } from "./commit-messages.js";
import type { LocalRequestClient } from "./local-request-client.js";
import { providerInfo, type ReviewRequestStatus, type WorkspaceStoreApi } from "./protocol.js";
import { openPullRequest } from "./pull-request-open.js";
import { PUBLISH_STEPS, runPublish, stepState, stepWords, type PublishProgress, type PublishStep, type StepState } from "./publish-steps.js";
import { requestShort, type RequestClient, type RowRequests } from "./requests.js";
import type { WorkspaceChangesReader } from "./workspace.js";

/** What the card needs of the rest of the kit. */
export interface PublishParts {
  store(): WorkspaceStoreApi | undefined;
  /** Workspace Kit's host entry: the commit and the push. */
  workspace: HostExtensionClient;
  requests: RequestClient;
  client: LocalRequestClient;
  changes: WorkspaceChangesReader;
  rows: RowRequests;
  preferences: PreferencesStore;
}

export interface PublishTarget {
  /** A commit message already written (the review's); without one the card has it written. */
  message?: string;
  /** The commit went through. */
  onCommitted?(): void;
}

/** Whether the card is open, and for what; a button sets it, the title-bar layer draws it. */
export class RequestPublishing {
  private open: (PublishTarget & { id: number }) | undefined;
  private count = 0;
  private readonly listeners = new Set<() => void>();

  show(target: PublishTarget = {}): void { this.set({ ...target, id: ++this.count }); }
  close(): void { this.set(undefined); }
  getSnapshot = (): (PublishTarget & { id: number }) | undefined => this.open;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(open: (PublishTarget & { id: number }) | undefined): void {
    this.open = open;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Files the diff reads for the commit message, at most. */
const MESSAGE_DIFFS = 12;
/** Rows of the file list before "and N more". */
const LISTED_FILES = 8;

const STEP_ICON: Record<"pending" | "done" | "failed", typeof Circle> = { pending: Circle, done: Check, failed: X };

/**
 * "Commit, push & PR" in one card: the files, a commit message and a title and description the
 * existing writers drafted (both editable), and the three steps behind one button. A step that fails
 * leaves the card open and the earlier ones done; pressing again continues there.
 */
function PublishRequestCard({ target, parts, store, actions, onClose }: { target: PublishTarget; parts: PublishParts; store: WorkspaceStoreApi; actions: WorkbenchActions; onClose(): void }) {
  const opened = useRef(store.getSnapshot()).current;
  const { changes } = opened;
  const workspace = opened.workspaceId ?? opened.cwd;
  const branch = opened.workspace?.branch;
  // What a commit takes: the staged files, else every changed one.
  const files = useRef((() => { const staged = changes.files.filter((file) => file.staged); return staged.length > 0 ? staged : changes.files; })()).current;
  const [status, setStatus] = useState<ReviewRequestStatus>();
  const [message, setMessage] = useState(target.message ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState<"message" | "description">();
  const [notes, setNotes] = useState<string[]>([]);
  const [progress, setProgress] = useState<PublishProgress>({ done: [] });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const latest = useRef(0);
  const { short, noun, capabilities } = providerInfo(status?.service ?? "github");
  const commitDone = progress.done.includes("commit");
  const locked = busy || Boolean(generating);

  const readDiffs = async (): Promise<UiFileDiff[]> => (await Promise.allSettled(files.slice(0, MESSAGE_DIFFS).map((file) => parts.changes.fileDiff(file.path))))
    .flatMap((read) => read.status === "fulfilled" ? [read.value] : []);

  /** The commit message the review writes, then the description the Local PR form writes, for that commit. */
  const generate = async (writeMessage: boolean) => {
    const run = ++latest.current;
    const current = () => alive.current && latest.current === run;
    const problems: string[] = [];
    let commit = message;
    if (writeMessage) {
      setGenerating("message");
      try {
        commit = (await store.suggestCommitMessage(changes, await readDiffs()))?.trim() ?? "";
      } catch (reason) {
        problems.push(`Could not write a message from the diff: ${errorMessage(reason).replace(/\.$/u, "")}.`);
      }
      commit ||= changes.proposedMessage ?? "";
      if (!current()) return;
      setMessage(commit);
    }
    setGenerating("description");
    try {
      const model = chosenWritingModel(parts.preferences);
      const prefer = actions.activeThread()?.model;
      const instructions = writingInstructions(parts.preferences);
      const written = await parts.client.describe({
        ...(model ? { model } : {}),
        ...(prefer ? { prefer } : {}),
        ...(instructions ? { instructions } : {}),
        ...(followRequestTemplate(parts.preferences) ? {} : { template: false }),
        ...(commit.trim() && !commitDone ? { pending: { message: commit, files: files.map(({ path, added, removed }) => ({ path, added, removed })) } } : {}),
      });
      if (!current()) return;
      setTitle(written.title);
      setBody(written.body);
    } catch (reason) {
      problems.push(`Could not write the description: ${errorMessage(reason).replace(/\.$/u, "")}.`);
    }
    if (!current()) return;
    setNotes(problems);
    setGenerating(undefined);
  };

  useEffect(() => {
    alive.current = true;
    parts.requests.status().then((next) => { if (alive.current) setStatus(next); }, () => undefined);
    void generate(!target.message?.trim());
    return () => { alive.current = false; };
    // Once, when the card opens.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    setBusy(true);
    const done = await runPublish(progress, {
      commit: async () => {
        await parts.workspace.invoke("commit", { message: message.trim(), push: false, ...(workspace ? { workspace } : {}) });
        void store.refresh();
        target.onCommitted?.();
      },
      push: async () => {
        await parts.workspace.invoke("push", workspace ? { workspace } : undefined);
        void store.refresh();
      },
      create: async () => {
        const result = await parts.requests.create({ title: title.trim(), body, base: "", draft });
        if (workspace) parts.rows.set(workspace, result.status.request);
        void store.refresh();
        const created = result.status.request;
        actions.notify(created ? `${requestShort(created)} #${created.number} created${draft ? " as draft" : ""}.` : `${short} created.`);
        if (created) openPullRequest(actions, created, opened.cwd);
      },
    }, (next) => { if (alive.current) setProgress(next); }, (step, reason) => actions.notify(`${stepWords(step, short).failed}: ${errorMessage(reason)}`, "error"));
    if (alive.current) setBusy(false);
    if (done) onClose();
  };

  const blocked = status?.problem ?? (status && !capabilities.create ? `${providerInfo(status.service).name} does not let Tau open a ${noun}; open it on the website.` : undefined);
  const ready = message.trim().length > 0 && title.trim().length > 0 && !blocked;
  const failed = progress.failed !== undefined;
  const shown = files.slice(0, LISTED_FILES);

  return (
    <Dialog className="confirm-dialog pr-publish-dialog" label={`Commit, push & ${short}`} onClose={() => { if (!busy) onClose(); }}>
      <header>
        <h2>Commit, push &amp; {short}</h2>
        <p className="pr-publish-target"><code title={branch}>{branch ?? "HEAD"}</code>{status ? <> into <code>{status.base}</code></> : null}</p>
      </header>
      <ul className="pr-publish-files" aria-label={`${files.length} changed ${files.length === 1 ? "file" : "files"}`}>
        {shown.map((file) => (
          <li key={file.path} title={file.path}>
            <FileKindIcon name={file.name} />
            <span className="pr-publish-file-name">{file.name}{file.directory ? <small>{file.directory}</small> : null}</span>
            <span className="stat-add">+{file.added}</span>
            <span className="stat-del">−{file.removed}</span>
          </li>
        ))}
        {files.length > shown.length ? <li className="pr-publish-more">and {files.length - shown.length} more</li> : null}
      </ul>
      <label className="pr-publish-field">Commit message
        <textarea
          aria-label="Commit message"
          rows={3}
          placeholder={generating === "message" ? "Writing from the diff…" : "Message"}
          value={generating === "message" ? "" : message}
          disabled={locked || commitDone}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      <label className="pr-publish-field">{short} title
        <input
          aria-label={`${short} title`}
          placeholder={generating ? "Writing from the commits…" : "Title"}
          value={generating ? "" : title}
          disabled={locked}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="pr-publish-field">{short} description
        <textarea
          aria-label={`${short} description`}
          rows={5}
          placeholder={generating ? "Writing from the commits…" : "What changed, and why?"}
          value={generating ? "" : body}
          disabled={locked}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="pr-publish-options">
        {capabilities.draft ? <label className="request-draft"><input type="checkbox" checked={draft} disabled={locked} onChange={(event) => setDraft(event.target.checked)} /> Draft</label> : null}
        <span className="spacer" />
        <button type="button" className="mini-button" disabled={locked} onClick={() => void generate(!commitDone)} {...tooltipProps(commitDone ? "Write the title and description again" : "Write the commit message, title and description again")}>
          <Sparkles size={12} aria-hidden="true" /> Write again
        </button>
      </div>
      {notes.map((note) => <p key={note} className="lpr-note" role="status">{note}</p>)}
      {blocked ? <p className="request-problem" role="note">{blocked}</p> : null}
      <ol className="pr-publish-steps" aria-label="Progress">
        {PUBLISH_STEPS.map((step) => <StepRow key={step} step={step} state={stepState(progress, step)} words={stepWords(step, short)} />)}
      </ol>
      <footer>
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || Boolean(generating) || !ready} onClick={() => void confirm()}>
          {busy ? "Working…" : failed ? "Try again" : `Commit, push & ${short}`}
        </button>
      </footer>
    </Dialog>
  );
}

function StepRow({ step, state, words }: { step: PublishStep; state: StepState; words: Record<StepState, string> }) {
  const Icon = state === "running" ? undefined : STEP_ICON[state];
  return (
    <li data-step={step} data-state={state} aria-current={state === "running" ? "step" : undefined}>
      {Icon ? <Icon size={13} aria-hidden="true" /> : <Spinner size="sm" label={words.running} />}
      <span>{words[state]}</span>
    </li>
  );
}

/** Drawn from a title-bar region, over the whole window, while the card is open. */
export function createPublishCardLayer(publishing: RequestPublishing, parts: PublishParts) {
  return function PublishCardLayer({ actions }: RegionProps) {
    const target = useSyncExternalStore(publishing.subscribe, publishing.getSnapshot, publishing.getSnapshot);
    const store = parts.store();
    if (!target || !store) return null;
    return createPortal(
      <PublishRequestCard key={target.id} target={target} parts={parts} store={store} actions={actions} onClose={() => publishing.close()} />,
      document.body,
    );
  };
}
