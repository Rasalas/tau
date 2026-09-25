import { useEffect, useState, useSyncExternalStore } from "react";
import { GitBranch, GitMerge, RefreshCw } from "lucide-react";
import {
  DiffView, Empty, READ_ONLY_REASON, Spinner, errorMessage, hostCommandAllowed, tooltipProps, useCommandAllowed,
  type ComposerGateContext, type ComposerGateProps, type DesktopExtensionContext, type UiFileDiff, type WorkbenchActions,
} from "tau";
import {
  DRIFT_EVENT, decodeDriftState, undecidedDrift,
  type DriftFile, type DriftImport, type DriftImportResult, type DriftState, type DriftTarget,
} from "./drift-protocol.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

/** Each checkout's drift state as the host half last answered, refreshed on its `drift` event. */
/** How long a new draft's fresh drift check counts before the next draft checks again. */
export const DRIFT_REFRESH_MS = 60_000;

export class DriftFeed {
  private readonly states = new Map<string, DriftState>();
  private readonly refreshed = new Map<string, number>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly context: Pick<DesktopExtensionContext, "host" | "events">) {}

  start(): () => void {
    const stopDrift = this.context.host.onEvent(DRIFT_EVENT, (payload) => {
      const workspace = (payload as { workspace?: unknown } | undefined)?.workspace;
      for (const [cwd, state] of this.states) if (state.workspace === workspace || cwd === workspace) void this.load(cwd);
    });
    const stopWorkspace = this.context.events.on("workspace-changed", (event) => { void this.load(event.to); });
    return () => { stopDrift(); stopWorkspace(); };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(cwd: string | undefined): DriftState | undefined {
    return cwd ? this.states.get(cwd) : undefined;
  }

  /** Starts a first load for a checkout nobody asked about yet; answers what is known now. */
  ensure(cwd: string | undefined): DriftState | undefined {
    if (cwd && !this.states.has(cwd)) void this.load(cwd);
    return this.get(cwd);
  }

  async load(cwd: string): Promise<DriftState | undefined> {
    if (this.loading.has(cwd)) return this.get(cwd);
    this.loading.add(cwd);
    try {
      return this.set(cwd, await this.context.host.invoke("drift", { cwd }));
    } catch {
      return undefined;
    } finally {
      this.loading.delete(cwd);
    }
  }

  /**
   * A quiet check of the targets checked before, at most once a minute per
   * checkout, so a new thread's gate sees drift from after the project opened.
   * A target never checked is left alone: checking it could ask for a login.
   */
  refresh(cwd: string, now = Date.now()): void {
    const last = this.refreshed.get(cwd);
    if (last !== undefined && now - last < DRIFT_REFRESH_MS) return;
    const targets = (this.get(cwd)?.targets ?? []).filter((target) => target.check);
    if (!targets.length) return;
    this.refreshed.set(cwd, now);
    void (async () => {
      for (const target of targets) await this.run("check-drift", cwd, { targetId: target.targetId }).catch(() => undefined);
    })();
  }

  /** Runs a drift command and keeps the state it answers with. */
  async run(command: "check-drift" | "import-drift" | "merge-drift" | "drift-later", cwd: string, input: Record<string, unknown> = {}): Promise<DriftImportResult> {
    const answer = await this.context.host.invoke(command, { cwd, ...input });
    const raw = command === "import-drift" ? (answer as { state?: unknown }).state : answer;
    const state = this.set(cwd, raw);
    const imported = command === "import-drift" ? (answer as { imported?: DriftImport }).imported : undefined;
    return { state: state ?? { workspace: cwd, targets: [] }, ...(imported ? { imported } : {}) };
  }

  private set(cwd: string, raw: unknown): DriftState | undefined {
    const state = decodeDriftState(raw);
    if (!state) return undefined;
    this.states.set(cwd, state);
    for (const listener of this.listeners) listener();
    return state;
  }
}

export function useDrift(feed: DriftFeed, cwd: string | undefined): DriftState | undefined {
  const state = useSyncExternalStore(feed.subscribe, () => feed.get(cwd));
  useEffect(() => { feed.ensure(cwd); }, [feed, cwd]);
  return state;
}

const LETTERS: Record<DriftFile["change"], string> = { added: "A", modified: "M", deleted: "D" };
const STATUS_WORDS: Record<DriftImport["status"], string> = { open: "Not merged", later: "Merge later", merged: "Merged", gone: "Branch deleted" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const shown = (target: Pick<DriftTarget, "context">, path: string) => (target.context ? `${target.context}/${path}` : path);

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Whether the first prompt of a thread should wait for a word about drift. */
/** Renders nothing: a new thread's draft in a server project checks the server again for its gate. */
export function createDriftRefresh(feed: DriftFeed) {
  return function DriftRefresh({ actions }: { actions?: Pick<WorkbenchActions, "activeThread"> }) {
    // A new thread's draft has no id yet; the composer's snapshot is still the thread it came from.
    const active = actions?.activeThread();
    const cwd = active && !active.sessionId ? active.cwd : undefined;
    const state = useDrift(feed, cwd);
    useEffect(() => { if (cwd && state) feed.refresh(cwd); }, [feed, cwd, state]);
    return null;
  };
}

export function driftGateAsks(feed: DriftFeed, context: ComposerGateContext): boolean {
  const snapshot = context.snapshot;
  if (context.action !== "prompt" || !snapshot?.cwd) return false;
  // A new thread's draft still carries the messages of the thread it came from.
  const first = context.newThread ?? (snapshot.messages.length === 0 && !snapshot.olderCursor);
  if (!first) return false;
  if (!hostCommandAllowed(SERVERS_EXTENSION_ID, "import-drift")) return false;
  const undecided = undecidedDrift(feed.ensure(snapshot.cwd));
  return undecided.files > 0 || undecided.imports.length > 0;
}

function FileRows({ target, files, selected, onSelect }: { target: DriftTarget; files: readonly DriftFile[]; selected?: string; onSelect?(path: string): void }) {
  return (
    <ul className="servers-drift-files">
      {files.map((file) => (
        <li key={file.path}>
          <button type="button" className={file.path === selected ? "active" : ""} aria-current={file.path === selected} disabled={!onSelect} onClick={() => onSelect?.(file.path)}>
            <span className={`review-file-status ${file.change}`}>{LETTERS[file.change]}</span>
            <span className="servers-drift-path" title={shown(target, file.path)}>{shown(target, file.path)}</span>
            {file.certain ? null : <span className="servers-drift-tag" {...tooltipProps("Only size and time differ; importing reads the file and leaves it out if it is the same.")}>maybe</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Before a thread's first prompt: drift nobody decided about, then drift
 * branches waiting for a merge. Every step can be put off; nothing merges
 * without the click that says so.
 */
export function createDriftGate(feed: DriftFeed) {
  return function DriftGate({ context, proceed, cancel }: ComposerGateProps) {
    const cwd = context.snapshot?.cwd ?? "";
    const state = useDrift(feed, cwd);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const undecided = undecidedDrift(state);
    const act = async (label: string, work: () => Promise<unknown>, done?: () => void) => {
      setBusy(label);
      setError(undefined);
      try {
        await work();
        done?.();
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setBusy(undefined);
      }
    };
    const drifting = (state?.targets ?? []).filter((target) => target.check && !target.check.later && target.check.files.length > 0);
    if (undecided.files > 0) {
      const files = drifting.flatMap((target) => target.check!.files.map((file) => ({ target, file })));
      return (
        <section className="servers-prompt servers-drift-gate" role="dialog" aria-modal="true" aria-label="Changes on the server">
          <header>
            <h2>The server has changes the repository lacks</h2>
            <p>{plural(undecided.files, "file")} changed on {drifting.map((target) => target.label).join(", ")} since Tau last read it. Import them as a branch before the agent starts? Your files stay as they are.</p>
          </header>
          <ul className="servers-drift-files compact">
            {files.slice(0, 6).map(({ target, file }) => (
              <li key={`${target.targetId}:${file.path}`}><span className={`review-file-status ${file.change}`}>{LETTERS[file.change]}</span><span className="servers-drift-path">{shown(target, file.path)}</span></li>
            ))}
            {files.length > 6 ? <li className="servers-drift-more">and {files.length - 6} more</li> : null}
          </ul>
          {error ? <p className="servers-prompt-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={busy !== undefined} onClick={cancel}>Cancel</button>
            <button type="button" disabled={busy !== undefined} onClick={() => void act("later", async () => {
              for (const target of drifting) await feed.run("drift-later", cwd, { targetId: target.targetId });
            }, proceed)}>Not now</button>
            <button type="button" className="primary" autoFocus disabled={busy !== undefined} onClick={() => void act("import", async () => {
              for (const target of drifting) await feed.run("import-drift", cwd, { targetId: target.targetId });
            }, () => { if (!undecidedDrift(feed.get(cwd)).imports.length) proceed(); })}>{busy === "import" ? <Spinner size="xs" tone="current" /> : null}Import as branch</button>
          </footer>
        </section>
      );
    }
    const open = undecided.imports;
    const into = state?.branch;
    const count = open.reduce((sum, { item }) => sum + item.files.length, 0);
    return (
      <section className="servers-prompt servers-drift-gate" role="dialog" aria-modal="true" aria-label="Server drift branch">
        <header>
          <h2>{open.length === 1 ? `${open[0]!.item.branch} is not merged` : `${open.length} drift branches are not merged`}</h2>
          <p>{open.map(({ item }) => item.branch).join(", ")} {open.length === 1 ? "holds" : "hold"} {plural(count, "change")} from the server. {into ? `Merge into ${into} so the agent works on them?` : "Check out a branch to merge them into."}</p>
        </header>
        {error ? <p className="servers-prompt-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={busy !== undefined} onClick={cancel}>Cancel</button>
          <button type="button" disabled={busy !== undefined} onClick={() => void act("later", async () => {
            for (const { targetId, item } of open) await feed.run("drift-later", cwd, { targetId, branch: item.branch });
          }, proceed)}>Later</button>
          <button type="button" className="primary" autoFocus disabled={busy !== undefined || !into} onClick={() => void act("merge", async () => {
            for (const { targetId, item } of open) await feed.run("merge-drift", cwd, { targetId, branch: item.branch });
          }, proceed)}>{busy === "merge" ? <Spinner size="xs" tone="current" /> : null}Merge into {into ?? "…"}</button>
        </footer>
      </section>
    );
  };
}

function useDiff(context: Pick<DesktopExtensionContext, "host">, cwd: string, targetId: string, path: string | undefined, branch: string | undefined) {
  const [diff, setDiff] = useState<{ key: string; diff?: UiFileDiff; error?: string }>();
  const key = path ? `${targetId}:${branch ?? ""}:${path}` : "";
  useEffect(() => {
    if (!path) return;
    let live = true;
    const answer = (next: Omit<NonNullable<typeof diff>, "key">) => { if (live) setDiff({ key: `${targetId}:${branch ?? ""}:${path}`, ...next }); };
    context.host.invoke("drift-diff", { cwd, targetId, path, ...(branch ? { branch } : {}) })
      .then((next) => answer({ diff: next as UiFileDiff }), (reason: unknown) => answer({ error: errorMessage(reason) }));
    return () => { live = false; };
  }, [context, cwd, targetId, path, branch]);
  return diff?.key === key ? diff : undefined;
}

function ImportRow({ target, item, branch, busy, act, onSelect, selected }: {
  target: DriftTarget; item: DriftImport; branch: string | undefined; busy: boolean;
  act(label: string, command: "merge-drift" | "drift-later", input: Record<string, unknown>): void;
  onSelect(path: string): void; selected?: string;
}) {
  const writable = useCommandAllowed(SERVERS_EXTENSION_ID, "merge-drift");
  const waiting = item.status === "open" || item.status === "later";
  const mergeTip = !writable ? READ_ONLY_REASON : !branch ? "Check out a branch to merge into." : `A merge commit on ${branch}; your other work stays as it is.`;
  return (
    <li className={`servers-drift-import ${item.status}`}>
      <div className="servers-drift-import-line">
        <GitBranch size={13} />
        <strong>{item.branch}</strong>
        <span>{plural(item.files.length, "file")}</span>
        <time dateTime={item.at} {...tooltipProps(new Date(item.at).toLocaleString())}>{ago(item.at)}</time>
        <span className="servers-drift-tag">{STATUS_WORDS[item.status]}</span>
        <span className="spacer" />
        {item.status === "open" ? <button type="button" disabled={busy || !writable} {...(writable ? {} : tooltipProps(READ_ONLY_REASON))} onClick={() => act("later", "drift-later", { targetId: target.targetId, branch: item.branch })}>Later</button> : null}
        {waiting ? (
          <button type="button" className="primary" disabled={busy || !writable || !branch} {...tooltipProps(mergeTip)} onClick={() => act("merge", "merge-drift", { targetId: target.targetId, branch: item.branch })}>
            <GitMerge size={13} />Merge into {branch ?? "…"}
          </button>
        ) : null}
      </div>
      <FileRows target={target} files={item.files} {...(selected ? { selected } : {})} onSelect={onSelect} />
    </li>
  );
}

function TargetDrift({ context, feed, cwd, target, branch }: { context: Pick<DesktopExtensionContext, "host">; feed: DriftFeed; cwd: string; target: DriftTarget; branch: string | undefined }) {
  const [selection, setSelection] = useState<{ path: string; branch?: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const canImport = useCommandAllowed(SERVERS_EXTENSION_ID, "import-drift");
  const diff = useDiff(context, cwd, target.targetId, selection?.path, selection?.branch);
  const act = (label: string, command: "check-drift" | "import-drift" | "merge-drift" | "drift-later", input: Record<string, unknown> = { targetId: target.targetId }) => {
    setBusy(label);
    setError(undefined);
    setNote(undefined);
    feed.run(command, cwd, input).then((result) => {
      if (command === "import-drift") setNote(result.imported ? `Committed on ${result.imported.branch}. Your files are unchanged.` : "Nothing new after all: the files read the same as before.");
      if (command === "merge-drift") setSelection(undefined);
    }, (failure: unknown) => setError(errorMessage(failure))).finally(() => setBusy(undefined));
  };
  const files = target.check?.files ?? [];
  const checking = target.checking || busy === "check";
  return (
    <section className="servers-drift-target" aria-label={`Drift on ${target.label}`}>
      <header className="servers-drift-head">
        <strong>{target.label}</strong>
        {target.check ? <span {...tooltipProps(new Date(target.check.at).toLocaleString())}>Checked {ago(target.check.at)}{target.check.baseline === "head" ? " against the last commit" : ""}</span> : null}
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Check the server now" disabled={checking || busy !== undefined} {...tooltipProps("Check the server now")} onClick={() => act("check", "check-drift")}>
          {checking ? <Spinner size="sm" /> : <RefreshCw size={13} />}
        </button>
      </header>
      {target.error ? <p className="servers-prompt-error" role="alert">The last check failed: {target.error}</p> : null}
      {error ? <p className="servers-prompt-error" role="alert">{error}</p> : null}
      {note ? <p className="servers-drift-note" role="status">{note}</p> : null}
      {files.length ? (
        <div className="servers-drift-group">
          <div className="servers-drift-group-line">
            <span>{plural(files.length, "file")} changed on the server{target.check?.later ? " (put off)" : ""}</span>
            <span className="spacer" />
            {target.check?.later ? null : <button type="button" disabled={busy !== undefined || !canImport} {...(canImport ? {} : tooltipProps(READ_ONLY_REASON))} onClick={() => act("later", "drift-later")}>Not now</button>}
            <button type="button" className="primary" disabled={busy !== undefined || !canImport} {...tooltipProps(canImport ? "A commit on server-drift/<date> with exactly these files; nothing in your checkout changes." : READ_ONLY_REASON)} onClick={() => act("import", "import-drift")}>
              {busy === "import" ? <Spinner size="xs" tone="current" /> : <GitBranch size={13} />}Import as commit
            </button>
          </div>
          <FileRows target={target} files={files} {...(selection && !selection.branch ? { selected: selection.path } : {})} onSelect={(path) => setSelection({ path })} />
        </div>
      ) : target.unchecked ? (
        <Empty size="compact" title="Not read yet" description="Tau has not read this server. Check it against the last commit, or download it first." />
      ) : target.check ? (
        <p className="servers-drift-note">Nothing changed on the server since Tau last read it.</p>
      ) : checking ? null : (
        <p className="servers-drift-note">Not checked since Tau last read the server.</p>
      )}
      {target.imports.length ? (
        <ol className="servers-drift-imports" aria-label="Drift branches">
          {target.imports.map((item) => (
            <ImportRow key={item.branch} target={target} item={item} branch={branch} busy={busy !== undefined} act={act}
              {...(selection?.branch === item.branch ? { selected: selection.path } : {})} onSelect={(path) => setSelection({ path, branch: item.branch })} />
          ))}
        </ol>
      ) : null}
      {selection ? (
        <div className="servers-drift-diff">
          {diff?.error ? <p className="servers-prompt-error" role="alert">{diff.error}</p> : <DiffView key={`${selection.branch ?? ""}:${selection.path}`} {...(diff?.diff ? { diff: diff.diff } : {})} mode="unified" path={shown(target, selection.path)} />}
        </div>
      ) : null}
    </section>
  );
}

/** The drift of a project's targets (one, when `targetId` names it): the Drift tab's content. */
export function DriftPanel({ context, feed, cwd, targetId }: { context: Pick<DesktopExtensionContext, "host">; feed: DriftFeed; cwd: string; targetId?: string }) {
  const state = useDrift(feed, cwd);
  if (!state) return <div className="servers-drift"><Spinner size="sm" label="Loading the server's changes" /></div>;
  const targets = state.targets.filter((target) => !targetId || target.targetId === targetId);
  if (!targets.length) return <Empty size="compact" title="No server" description="This project has no .vscode/sftp.json target." />;
  return (
    <div className="servers-drift">
      {targets.map((target) => <TargetDrift key={target.targetId} context={context} feed={feed} cwd={cwd} target={target} branch={state.branch} />)}
    </div>
  );
}
