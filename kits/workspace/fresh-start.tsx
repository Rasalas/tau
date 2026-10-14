import { useEffect, useState, useSyncExternalStore } from "react";
import { Folder, Link, MessageSquareDashed } from "lucide-react";
import { ProviderIconStack, errorMessage, providerStackLabel, tooltipProps, useReadyRuntimes, useThreadStore, useWorkbenchShell, type RegionProps } from "tau";
import { CLONE_SOURCE } from "./add-project-menu.js";
import { useWorkspaceStore } from "./store-context.js";

/** One thing the row names as connected, with the mark that stands for it. */
interface Connected { key: string; label: string; modelProvider?: string; runtimeProvider?: string }

function names(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  const shown = labels.length > 3 ? [...labels.slice(0, 2), `${labels.length - 2} more`] : labels;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A fresh install (2a): no thread anywhere and no repository open, so the draft
 * gives way to what to do first. Its stylesheet hides the heading and composer
 * while it shows; the new-thread chord opens a draft, which ends it.
 */
export function FreshStart({ snapshot, actions }: RegionProps) {
  const { registry } = useWorkbenchShell();
  const threads = useThreadStore();
  const store = useWorkspaceStore();
  // The host keeps an empty session open from the start; the rail lists none without a message.
  const empty = useSyncExternalStore(threads.subscribe, () => threads.getSnapshot().threads.every((thread) => thread.messageCount === 0));
  const drafts = useSyncExternalStore(threads.subscribeToDrafts, threads.getDrafts);
  const draft = drafts.find((candidate) => candidate.active);
  const active = actions.activeThread();
  const ready = useReadyRuntimes(snapshot, empty);
  const [firstDraft, setFirstDraft] = useState<{ id: string; replacement: boolean }>();
  useEffect(() => {
    if (!active?.draftPending || !draft || firstDraft) return;
    // The first draft may replace an unready startup runtime without a user choosing to start.
    const replacement = empty && ready?.some((backend) => backend.kind === active?.backendKind) === true
      && !ready.some((backend) => backend.kind === (snapshot?.backendKind ?? "pi"));
    setFirstDraft({ id: draft.draftId, replacement });
  }, [active?.backendKind, active?.draftPending, draft, empty, firstDraft, ready, snapshot?.backendKind]);
  // A new draft or any input ends the start page; the empty startup replacement does not.
  const idle = empty && (!active?.draftPending || (firstDraft?.replacement && firstDraft.id === draft?.draftId
    && !draft.preview && !draft.attachments && !draft.submitting));
  // The answer is for one project: another one on screen (a folder just opened) is asked again.
  const workspace = snapshot?.workspaceId ?? snapshot?.cwd;
  const [asked, setAsked] = useState<{ workspace: string | undefined; plain: boolean }>();
  useEffect(() => {
    if (!idle) return undefined;
    let live = true;
    // A private "No project" folder is where the user chose to start; it is not a missing project.
    store.host.getWorkspaceInfo().then((info) => { if (live) setAsked({ workspace, plain: !info.isRepo && !info.projectless }); }, () => undefined);
    return () => { live = false; };
  }, [idle, store, workspace]);
  const [starting, setStarting] = useState(false);
  const fresh = idle && asked !== undefined && asked.workspace === workspace && asked.plain;
  if (!fresh) return null;
  const startWithoutProject = () => {
    setStarting(true);
    store.host.createScratch()
      .then((scratch) => actions.openWorkspace(scratch.workspaceId))
      .catch((error: unknown) => actions.notify(errorMessage(error), "error"))
      .finally(() => setStarting(false));
  };
  // Pi is named by the model providers it holds; any other runtime by its own mark.
  const piProviders = [...new Set((snapshot?.backendKind ?? "pi") === "pi" ? (snapshot?.models ?? []).map((model) => model.provider) : [])];
  const connected = (ready ?? []).flatMap((backend): Connected[] => backend.kind === "pi" && piProviders.length
    ? piProviders.map((provider) => ({ key: `pi:${provider}`, label: providerStackLabel(provider, undefined), modelProvider: provider }))
    : [{ key: backend.kind, label: backend.label, runtimeProvider: backend.kind }]);
  const keys = ([["workspace.open-project", "open a project"], ["runtime.new-session", "new thread"], ["runtime.command-palette", "search anything"]] as const)
    .flatMap(([id, label]) => {
      const chord = registry.keybindingLabel(id);
      return chord ? [{ chord, label }] : [];
    });
  return (
    <div className="fresh-start">
      <svg className="fresh-start-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="8" />
        <path d="M8.7 10L22.52 10M15 10L15 19.15C15 21.29 16.74 23.03 18.88 23.03C20.33 23.03 21.04 22.63 22.03 21.94" />
      </svg>
      <h2>Open a project to start</h2>
      <p className="fresh-start-lede">A project is any folder on this machine. A git repo adds worktrees and reviews.</p>
      <div className="fresh-start-actions">
        <button type="button" className="primary" onClick={() => void actions.executeCommand?.("workspace.open-project")}><Folder size={12} aria-hidden />Open a folder</button>
        <button type="button" onClick={() => actions.openProjectSources(CLONE_SOURCE)}><Link size={12} aria-hidden />Clone a repository</button>
        <button type="button" disabled={starting} {...tooltipProps("A private folder for this thread, no project needed")} onClick={startWithoutProject}><MessageSquareDashed size={12} aria-hidden />Start without a project</button>
      </div>
      {keys.length ? <dl className="fresh-start-keys">
        {keys.map(({ chord, label }) => <div key={label}><dt>{(chord.includes("+") ? chord.split("+") : [...chord]).map((key, index) => <kbd key={index}>{key}</kbd>)}</dt><dd>{label}</dd></div>)}
      </dl> : null}
      {ready ? <p className="fresh-start-providers">
        {connected.slice(0, 3).map(({ key, modelProvider, runtimeProvider }) => modelProvider
          ? <ProviderIconStack key={key} modelProvider={modelProvider} runtimeMark={false} hint={false} />
          : <ProviderIconStack key={key} {...(runtimeProvider ? { runtimeProvider } : {})} hint={false} />)}
        <span>{connected.length ? `${names(connected.map(({ label }) => label))} connected · ` : "No agent is set up yet · "}
          <button type="button" onClick={() => actions.openSettings("providers")}>{connected.length ? "add more" : "set one up"}</button></span>
      </p> : null}
    </div>
  );
}
