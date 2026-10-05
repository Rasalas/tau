import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { DiffView, errorMessage, useThreadStore, type HostExtensionClient, type PreferencesStore, type StageTabHandle, type UiFileDiff, type UiWorkspaceChanges, type WorkbenchActions } from "tau";
import { LocalChecks, type ScriptScope } from "./local-request-checks.js";
import type { LocalRequestClient } from "./local-request-client.js";
import { EvidenceGroups, EvidenceViewer } from "./local-request-evidence.js";
import { LocalRequestWriter, type LocalForm } from "./local-request-writer.js";
import { assignEvidence, evidenceKey, type LocalBranch, type LocalDrafts, type LocalEvidence } from "./local-request.js";
import { providerInfo, type ReviewRequestStatus, type WorkspaceStoreApi } from "./protocol.js";
import { relativeTime } from "./pull-request-logic.js";
import type { RequestClient, RowRequests } from "./requests.js";
import { ServiceIcon } from "./service-icon.js";
import type { WorkspaceChangesReader } from "./workspace.js";

/** What the view needs of the rest of the kit. */
export interface LocalRequestParts {
  client: LocalRequestClient;
  requests: RequestClient;
  rows: RowRequests;
  changes: WorkspaceChangesReader;
  store(): WorkspaceStoreApi | undefined;
  scripts: HostExtensionClient;
  preferences: PreferencesStore;
  drafts: LocalDrafts;
  /** Hears Evidence Kit say a thread's pictures changed. */
  onEvidence(listener: () => void): () => void;
}

type Tab = "summary" | "commits" | "code";

const NO_STORE = { subscribe: () => () => undefined, getSnapshot: () => undefined };
const STATUS_LETTERS: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };

interface Loaded {
  branch?: LocalBranch;
  branchError?: string;
  status?: ReviewRequestStatus;
  changes?: UiWorkspaceChanges;
  changesError?: string;
  evidence?: LocalEvidence[];
  evidenceAvailable?: boolean;
}

/**
 * The local pull request: the checkout's branch against its base as a
 * request would show it — summary with the description being written, the
 * checks the project's scripts give, the pictures of the turns that did the
 * work by commit, the commits and the diff — before anything is pushed.
 */
export default function LocalRequestView({ handle, actions, parts }: { handle: StageTabHandle; actions: WorkbenchActions; parts: LocalRequestParts }) {
  const store = parts.store();
  const snapshot = useSyncExternalStore((store ?? NO_STORE).subscribe, (store ?? NO_STORE).getSnapshot);
  const root = snapshot?.cwd;
  const workspaceId = snapshot?.workspaceId;
  const branchName = snapshot?.workspace?.branch;
  const uncommitted = snapshot?.changes.files.length ?? 0;
  const threadStore = useThreadStore();
  const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
  const [data, setData] = useState<Loaded>({});
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<{ frames: readonly LocalEvidence[]; index: number }>();

  const threads = useMemo(() => {
    const active = actions.activeThread();
    const listed = threadSnapshot.threads.filter((thread) => root && (thread.projectPath === root || thread.projectDisplayPath === root));
    const titles = new Map(listed.map((thread) => [thread.id, thread.title || "Untitled thread"]));
    if (active?.sessionId && active.cwd === root && !titles.has(active.sessionId)) titles.set(active.sessionId, threadStore.getThread(active.sessionId)?.title || "This thread");
    return titles;
  }, [actions, root, threadSnapshot.threads, threadStore]);
  const threadKey = [...threads.keys()].sort().join(",");

  const loadEvidence = useCallback(async () => {
    if (!root) return;
    try {
      const answer = await parts.client.evidence(root, [...threads.keys()]);
      setData((current) => ({ ...current, evidence: answer.evidence, evidenceAvailable: answer.available }));
    } catch {
      setData((current) => ({ ...current, evidence: [], evidenceAvailable: false }));
    }
    // threadKey stands for the thread ids.
  }, [parts.client, root, threadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (fresh: boolean) => {
    if (!root) return;
    setLoading(true);
    const [branch, status, changes] = await Promise.allSettled([parts.client.branch(), parts.requests.status(fresh), parts.changes.changes({ scope: "branch" })]);
    setData((current) => ({
      ...current,
      ...(branch.status === "fulfilled" ? { branch: branch.value, branchError: undefined } : { branchError: errorMessage(branch.reason) }),
      ...(status.status === "fulfilled" ? { status: status.value } : {}),
      ...(changes.status === "fulfilled" ? { changes: changes.value, changesError: undefined } : { changesError: errorMessage(changes.reason) }),
    }));
    if (status.status === "fulfilled") parts.rows.set(root, status.value.request);
    await loadEvidence();
    setLoading(false);
  }, [loadEvidence, parts, root]);

  useEffect(() => { void load(false); }, [load, branchName]);
  useEffect(() => parts.onEvidence(() => { void loadEvidence(); }), [loadEvidence, parts]);
  useEffect(() => { handle.setTitle("Local PR"); }, [handle]);

  // The draft of this branch: the text being written and the chosen pictures, kept per checkout and branch.
  const [form, setForm] = useState<LocalForm>({ title: "", body: "", base: "", draft: false });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [attached, setAttached] = useState(0);
  useEffect(() => parts.drafts.subscribe(() => setAttached((count) => count + 1)), [parts.drafts]);
  useEffect(() => {
    if (!root) return;
    const kept = parts.drafts.get(root, branchName);
    setForm(kept ? { title: kept.title, body: kept.body, base: kept.base, draft: kept.draft } : { title: "", body: "", base: "", draft: false });
    setSelected(new Set(kept?.selected ?? []));
  }, [attached, branchName, parts.drafts, root]);
  const save = (nextForm: LocalForm, nextSelected: ReadonlySet<string>) => {
    if (root) parts.drafts.set(root, branchName, { ...nextForm, selected: [...nextSelected] });
  };
  const updateForm = (update: Partial<LocalForm>) => setForm((current) => { const next = { ...current, ...update }; save(next, selected); return next; });
  const toggle = (frame: LocalEvidence) => setSelected((current) => {
    const next = new Set(current);
    const key = evidenceKey(frame);
    if (next.has(key)) next.delete(key); else next.add(key);
    save(form, next);
    return next;
  });

  const groups = useMemo(() => assignEvidence(data.branch?.commits ?? [], data.evidence ?? [], data.branch?.forkedAt), [data.branch, data.evidence]);
  const frames = useMemo(() => new Map(groups.flatMap((group) => group.turns.flatMap((turn) => turn.frames)).map((frame) => [evidenceKey(frame), frame])), [groups]);
  // Oldest first, the order a reader follows the change in.
  const chosen = useMemo(() => [...frames.values()].filter((frame) => selected.has(evidenceKey(frame))).sort((left, right) => left.at - right.at), [frames, selected]);

  if (!store) return <div className="stage-empty" role="status">The local pull request needs Workspace Kit.</div>;
  if (!root) return <div className="stage-empty" role="status">Open a thread in a project to see its branch as a pull request.</div>;

  const service = data.status?.service ?? "github";
  const { short, noun } = providerInfo(service);
  const commits = data.branch?.commits ?? [];
  const base = form.base.trim() || data.status?.base || data.branch?.base || "";
  const scope: ScriptScope | undefined = actions.activeThread()?.cwd === root && actions.activeThread()?.sessionId ? { sessionId: actions.activeThread()!.sessionId! } : workspaceId ? { workspaceId } : undefined;
  const frameCount = frames.size;

  return (
    <div className="pr-view lpr-view" aria-label={`Local ${short} for ${branchName ?? "this checkout"}`}>
      <header className="pr-head">
        <div className="pr-head-row">
          <span className="lpr-service"><ServiceIcon service={service} width={14} height={14} />{providerInfo(service).name}</span>
          <span className="lpr-note">{data.status?.request ? `#${data.status.request.number}` : "Not published"}</span>
          <span className="spacer" />
          <button className="icon-button compact" aria-label="Refresh the local pull request" title="Refresh" disabled={loading} onClick={() => { void store.refresh(); void load(true); }}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="pr-fold">
          <h1 className="pr-title">{data.status?.request ? "Local changes" : `New ${noun}`}</h1>

        </div>
      </header>

      <nav className="pr-tabs">
        <div className="toggle-group" role="tablist" aria-label="Local pull request sections">
          {(["summary", "commits", "code"] as const).map((entry) => (
            <button key={entry} role="tab" aria-selected={tab === entry} className={tab === entry ? "active" : ""} onClick={() => setTab(entry)}>
              {entry === "summary" ? "Summary" : entry === "commits" ? `Commits${commits.length ? ` ${commits.length}` : ""}` : `Code${data.changes?.files.length ? ` ${data.changes.files.length}` : ""}`}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {frameCount > 0 ? <span className="pr-tab-context">{frameCount} {frameCount === 1 ? "picture" : "pictures"} · {selected.size} chosen</span> : null}
      </nav>

      <div className="pr-body">
        {data.branchError ? <p className="pr-error pr-pad" role="alert">{data.branchError}</p> : null}
        {tab === "summary" ? (
          <div className="lpr-summary">
            {uncommitted > 0 ? (
              <p className="lpr-uncommitted" role="note">
                <span>{uncommitted} uncommitted {uncommitted === 1 ? "file" : "files"}</span>{" "}
                <button className="text-button" title={`Only committed changes go into the ${short}`} onClick={() => actions.openPanel("changes")}>Open Changes</button>
              </p>
            ) : null}
            <section className="lpr-section" aria-label="Description">
              <LocalRequestWriter form={form} onForm={updateForm} status={data.status} branch={branchName} root={root} selected={chosen} frames={frames}
                client={parts.client} requests={parts.requests} actions={actions} preferences={parts.preferences}
                onCreated={(status) => { setData((current) => ({ ...current, status })); parts.rows.set(root, status.request); parts.drafts.clear(root, branchName); }} />
            </section>
            <section className="lpr-section" aria-label="Checks">
              <LocalChecks scripts={parts.scripts} scope={scope} />
            </section>
            <section className="lpr-section" aria-label="Pictures">
              {groups.length > 0 ? <>
                <h2>Pictures <small>{frameCount} available · {selected.size} selected</small></h2>
                <EvidenceGroups groups={groups} titles={threads} client={parts.client} selected={selected} onToggle={toggle} onOpen={(list, index) => setViewer({ frames: list, index })} />
              </> : <details className="lpr-empty-detail">
                <summary>Pictures <span>{!data.evidence ? "Loading…" : "None yet"}</span></summary>
                <p className="pr-empty">{data.evidenceAvailable === false ? "Turn pictures are unavailable because Evidence Kit is off." : "Screenshots from this branch’s turns will appear here."}</p>
              </details>}

            </section>
          </div>
        ) : null}
        {tab === "commits" ? (
          <ol className="lpr-commits" aria-label="Commits">
            {commits.length === 0 ? <li className="pr-empty">No commits since {base || "the base"}.</li> : null}
            {groups.some((group) => !group.commit) ? (
              <li className="lpr-commit uncommitted">
                <div className="lpr-commit-line"><strong>Not committed yet</strong></div>
                <EvidenceGroups compact groups={groups.filter((group) => !group.commit)} titles={threads} client={parts.client} selected={selected} onToggle={toggle} onOpen={(list, index) => setViewer({ frames: list, index })} />
              </li>
            ) : null}
            {commits.map((commit) => (
              <li key={commit.sha} className="lpr-commit">
                <div className="lpr-commit-line">
                  <strong title={commit.subject}>{commit.subject}</strong>
                  <span className="spacer" />
                  {commit.author ? <span>{commit.author}</span> : null}
                  <span>{relativeTime(new Date(commit.at).toISOString())}</span>
                  <button className="pr-ref" title="Copy the commit id" onClick={() => void actions.copyText(commit.sha)}>{commit.sha.slice(0, 7)}</button>
                </div>
                {commit.body ? <p className="lpr-commit-body">{commit.body}</p> : null}
                <EvidenceGroups compact groups={groups.filter((group) => group.commit?.sha === commit.sha)} titles={threads} client={parts.client} selected={selected} onToggle={toggle} onOpen={(list, index) => setViewer({ frames: list, index })} />
              </li>
            ))}
          </ol>
        ) : null}
        {tab === "code" ? <LocalCode changes={data.changes} error={data.changesError} reader={parts.changes} /> : null}
      </div>

      {viewer ? <EvidenceViewer frames={viewer.frames} index={viewer.index} client={parts.client} selected={selected} onToggle={toggle} onClose={() => setViewer(undefined)} /> : null}
    </div>
  );
}

/** The branch's files against the merge base, one diff at a time. */
function LocalCode({ changes, error, reader }: { changes: UiWorkspaceChanges | undefined; error: string | undefined; reader: WorkspaceChangesReader }) {
  const files = changes?.files ?? [];
  const [path, setPath] = useState<string>();
  const current = files.find((file) => file.path === path) ?? files[0];
  const [diff, setDiff] = useState<{ path: string; diff?: UiFileDiff; error?: string }>();
  useEffect(() => {
    if (!current || !changes) return;
    let live = true;
    reader.fileDiff(current.path, { scope: "branch", ...(changes.baseCommit ? { baseCommit: changes.baseCommit } : {}), ...(changes.baseRef ? { baseRef: changes.baseRef } : {}) })
      .then((next) => { if (live) setDiff({ path: current.path, diff: next }); }, (reason: unknown) => { if (live) setDiff({ path: current.path, error: errorMessage(reason) }); });
    return () => { live = false; };
  }, [changes, current, reader]);
  if (error && !changes) return <p className="pr-error pr-pad" role="alert">{error}</p>;
  if (!changes) return <p className="pr-empty pr-pad" role="status">Loading the diff…</p>;
  if (files.length === 0) return <p className="pr-empty pr-pad">No committed changes against the base.</p>;
  const index = current ? files.indexOf(current) : 0;
  const step = (offset: number) => setPath(files[(index + offset + files.length) % files.length]!.path);
  const shown = diff?.path === current?.path ? diff : undefined;
  return (
    <div className="pr-code">
      <div className="pr-code-body">
        <main className="pr-code-main">
          {current ? (
            <header className="pr-file-header">
              <span className={`review-file-status ${current.status}`}>{STATUS_LETTERS[current.status] ?? "M"}</span>
              <strong title={current.path}>{current.name}</strong>
              {current.directory ? <span className="pr-file-dir">{current.directory}</span> : null}
              <span className="spacer" />
              <span className="stat-add">+{current.added}</span>
              <span className="stat-del">−{current.removed}</span>
              <button className="icon-button compact" aria-label="Previous file" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
              <button className="icon-button compact" aria-label="Next file" onClick={() => step(1)}><ChevronRight size={14} /></button>
            </header>
          ) : null}
          <div className="pr-diff">
            {shown?.error ? <p className="pr-error pr-pad" role="alert">{shown.error}</p> : <DiffView key={current?.path} {...(shown?.diff ? { diff: shown.diff } : {})} mode="unified" {...(current ? { path: current.path } : {})} />}
          </div>
        </main>
        <aside className="pr-file-list" aria-label="Changed files">
          {files.map((file) => (
            <button key={file.path} className={`pr-file-row ${file.path === current?.path ? "active" : ""}`} aria-current={file.path === current?.path} title={file.path} onClick={() => setPath(file.path)}>
              <span className={`review-file-status ${file.status}`}>{STATUS_LETTERS[file.status] ?? "M"}</span>
              <span className="pr-file-name">{file.name}{file.directory ? <small>{file.directory}</small> : null}</span>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
