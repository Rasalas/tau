import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Dialog, SettingsState, READ_ONLY_REASON, errorMessage, hostHasLocalFiles, hostIsReadOnly, useHostCapabilities, usePreferences, useThreadStore, useWorkbenchShell, type DesktopExtensionContext, type RegionProps, type UiSession, type WorkbenchActions } from "tau";
import type { ProjectPromotionInfo, WorkspaceHostClient } from "./protocol.js";
import { PROMOTE_PROJECT } from "./project-promotion-menu.js";
import type { WorkspaceStore } from "./store.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";
import { readProjectIcon, writeProjectIcon } from "./project-icons.js";

export function ProjectPromotionDialog({ session, host, actions, store }: { session: UiSession; host: WorkspaceHostClient; actions: WorkbenchActions; store: WorkspaceStore }) {
  const [name, setName] = useState(session.title.slice(0, 60));
  const [git, setGit] = useState(false);
  const [info, setInfo] = useState<ProjectPromotionInfo>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const capabilities = useHostCapabilities();
  const readOnly = capabilities.readOnly || hostIsReadOnly();
  const workspace = session.workspaceId;
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => { if (live) setLoading(true); }, 300);
    setError(undefined);
    setInfo(undefined);
    if (!workspace) { setError("This machine has not published this thread's workspace."); clearTimeout(timer); return; }
    void host.promotionInfo(workspace, session.id).then((result) => {
      if (live) setInfo(result);
    }, (reason: unknown) => { if (live) setError(errorMessage(reason)); }).finally(() => {
      clearTimeout(timer);
      if (live) setLoading(false);
    });
    return () => { live = false; clearTimeout(timer); };
  }, [workspace, session.id, host, attempt]);
  const close = () => { if (!submitting.current) store.closeProjectPromotion(); };
  const submit = async () => {
    if (submitting.current || readOnly || hostIsReadOnly() || !workspace || !info || !name.trim()) return;
    submitting.current = true;
    setBusy(true); setError(undefined);
    try {
      const result = await host.promoteScratch(workspace, session.id, name.trim(), git);
      store.closeProjectPromotion();
      const message = `"${result.name}" is now a project.`;
      const settings = () => store.openProjectSettings({ projectPath: result.workspace.displayPath, projectName: result.name, workspaceId: result.workspace.workspaceId });
      if (actions.toast) actions.toast({ type: "success", title: message, actions: [{ label: "Project settings", run: settings, opens: true }] });
      else actions.notify(message);
      void store.refresh().catch(() => undefined);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return createPortal(<Dialog label="Turn into a project" className="confirm-dialog project-promotion-dialog" onClose={close}>
    <h2>Turn into a project</h2>
    <p>The thread's folder becomes a project where it is. Nothing moves, and the agent keeps working in the same place.</p>
    <form id="project-promotion-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="project-promotion-name">Name<input autoFocus required maxLength={60} value={name} disabled={busy || readOnly} onChange={(event) => setName(event.target.value)} /></label>
      <label><input type="checkbox" checked={git} disabled={busy || readOnly} onChange={(event) => setGit(event.target.checked)} /> Start a Git repository</label>
      <p className="muted">Adds branches, diffs and reviews. Commits the current files once.</p>
      {info && info.otherThreads > 0 ? <p>{info.otherThreads} other {info.otherThreads === 1 ? "thread in this folder moves" : "threads in this folder move"} with it.</p> : null}
      {loading ? <SettingsState kind="loading" title="Loading…" /> : null}
      {info?.promoted ? <p role="status">This folder is already a project.</p> : null}
      {error ? <div role="alert"><p>{error}</p>{!info ? <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button> : null}</div> : null}
    </form>
    <footer>
      <button type="button" className="text-button" disabled={busy} onClick={close}>Cancel</button>
      <button type="submit" form="project-promotion-form" className="primary" disabled={busy || readOnly || !info || info.promoted || !name.trim()} title={readOnly ? READ_ONLY_REASON : undefined}>{busy ? "Creating…" : "Turn into project"}</button>
    </footer>
  </Dialog>, document.body);
}

/** Mounted on every profile, including compact's own thread menu and palette. */
export function createProjectPromotionRegion(context: DesktopExtensionContext, store: WorkspaceStore, host: WorkspaceHostClient) {
  return function ProjectPromotionRegion({ actions }: RegionProps) {
    const threads = useThreadStore();
    const { registry } = useWorkbenchShell();
    const activeId = actions.activeThread()?.sessionId;
    const subscribe = useCallback((listener: () => void) => activeId ? threads.subscribeToThread(activeId, listener) : () => undefined, [threads, activeId]);
    const active = useSyncExternalStore(subscribe, () => activeId ? threads.getThread(activeId) : undefined);
    const target = useSyncExternalStore(store.subscribe, () => store.getSnapshot().projectPromotion);
    const organizer = useSyncExternalStore(store.subscribe, () => store.getSnapshot().threadRailOrganizer);
    const project = useSyncExternalStore(store.subscribe, () => store.getSnapshot().projectSettings);
    const preferences = usePreferences();
    useEffect(() => {
      if (!active?.projectless) return;
      return context.registerCommand({ id: PROMOTE_PROJECT, label: "Turn into project…", group: "Project", access: "write", surfaces: ["thread-title"], run: () => store.openProjectPromotion(active) });
    }, [active, actions]);
    // Use the decorated organizer for title menus even if Thread Rail registered its function earlier.
    useEffect(() => {
      if (!organizer || registry.getThreadMenu()?.id !== "thread-rail.menu") return;
      return context.registerThreadMenu({
        id: "workspace.project-promotion-menu",
        menu: (session, lookup) => store.getSnapshot().threadRailOrganizer?.menu(session, lookup),
        run: (session, id, app) => store.getSnapshot().threadRailOrganizer?.runMenu(session, id, app),
      });
    }, [organizer, registry]);
    const canReveal = hostHasLocalFiles() && project && threads.getSnapshot().threads.some((entry) => entry.backendKind !== "machine"
      && (project.workspaceId ? entry.workspaceId === project.workspaceId : entry.projectPath === project.path));
    return <>
      {target ? <ProjectPromotionDialog key={target.id} session={target} host={host} actions={actions} store={store} /> : null}
      {project ? createPortal(<ProjectSettingsDialog key={project.workspaceId ?? project.path} project={project} current={readProjectIcon(preferences, project)} automatic={project.icon}
        onSave={(choice) => { writeProjectIcon(preferences, project, choice); store.closeProjectSettings(); }} onClose={() => store.closeProjectSettings()} onError={(message) => actions.notify(message, "error")}
        {...(canReveal ? { onShowFolder: () => { void store.openInEditor(undefined, "file-manager", undefined, project.workspaceId ?? project.path); }, fileManagerName: store.getSnapshot().editors.find((editor) => editor.id === "file-manager")?.name } : {})} />, document.body) : null}
    </>;
  };
}
