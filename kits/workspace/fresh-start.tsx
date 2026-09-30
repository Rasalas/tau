import { useEffect, useState, useSyncExternalStore } from "react";
import { Folder, Link } from "lucide-react";
import { ProviderIconStack, providerStackLabel, useThreadStore, useWorkbenchShell, type RegionProps } from "tau";
import { CLONE_SOURCE } from "./add-project-menu.js";
import { useWorkspaceStore } from "./store-context.js";

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
  // The new-thread chord opens a draft; then the composer is back.
  const idle = empty && !actions.activeThread()?.draftPending;
  const [repo, setRepo] = useState<boolean>();
  useEffect(() => {
    if (!idle) return undefined;
    let live = true;
    store.host.getWorkspaceInfo().then((info) => { if (live) setRepo(info.isRepo); }, () => undefined);
    return () => { live = false; };
  }, [idle, store]);
  const fresh = idle && repo === false;
  if (!fresh) return null;
  const providers = [...new Set((snapshot?.models ?? []).map((model) => model.provider))];
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
      <p className="fresh-start-lede">A project is any folder with a git repo. Threads, worktrees and reviews hang off it.</p>
      <div className="fresh-start-actions">
        <button type="button" className="primary" onClick={() => void actions.executeCommand?.("workspace.open-project")}><Folder size={12} aria-hidden />Open a folder</button>
        <button type="button" onClick={() => actions.openProjectSources(CLONE_SOURCE)}><Link size={12} aria-hidden />Clone a repository</button>
      </div>
      {keys.length ? <dl className="fresh-start-keys">
        {keys.map(({ chord, label }) => <div key={label}><dt>{(chord.includes("+") ? chord.split("+") : [...chord]).map((key, index) => <kbd key={index}>{key}</kbd>)}</dt><dd>{label}</dd></div>)}
      </dl> : null}
      <p className="fresh-start-providers">
        {providers.slice(0, 3).map((provider) => <ProviderIconStack key={provider} modelProvider={provider} runtimeMark={false} hint={false} />)}
        <span>{providers.length ? `${names(providers.map((provider) => providerStackLabel(provider, undefined)))} connected · ` : "No provider connected yet · "}
          <button type="button" onClick={() => actions.openSettings("providers")}>{providers.length ? "add more" : "add one"}</button></span>
      </p>
    </div>
  );
}
