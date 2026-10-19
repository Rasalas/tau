import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, SettingRow, SettingsSection, errorMessage, useThreadStore, type DesktopExtensionContext, type HostExtensionClient, type RegionProps, type SettingsSectionProps, type WorkbenchActions } from "tau";
import { WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "../workspace/protocol.js";
import { CUSTOMIZE_PROMPT_PREFIX, type CustomizationFolder, type CustomizationProject } from "./protocol.js";

const trimmed = (path: string) => path.replace(/[\\/]+$/u, "");

/** Where the prefix goes: a fresh page of this project. */
export interface CustomizeTarget { workspaceId: string; directory: string }

interface Wish { target: CustomizeTarget; asked: boolean }

/** The prefix waiting for its page; the composer-above region applies it, because only it holds the actions of the page on screen. */
export function createPendingPrefix(expiryMs = 15_000) {
  let wish: Wish | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: Wish | undefined, onExpire?: () => void) => {
    wish = next;
    clearTimeout(timer);
    if (next) timer = setTimeout(() => { set(undefined); onExpire?.(); }, expiryMs);
    for (const listener of [...listeners]) listener();
  };
  return {
    offer: (target: CustomizeTarget, onExpire?: () => void) => set({ target, asked: false }, onExpire),
    take: () => set(undefined),
    /** True once per offer: the region may ask for a new draft only once. */
    ask: (): boolean => { if (!wish || wish.asked) return false; wish.asked = true; return true; },
    getSnapshot: () => wish,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type PendingPrefix = ReturnType<typeof createPendingPrefix>;

/**
 * "Customize Tau…": the customization project (made on the first call, the same one after),
 * and "Change Tau: " in the composer of a fresh page in it, for the user to finish. Nothing is sent.
 */
export async function startCustomization(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  prefix: PendingPrefix,
  onFolder: (directory: string) => void = () => undefined,
): Promise<void> {
  let project: CustomizationProject;
  try {
    project = await host.invoke("customization-project") as CustomizationProject;
  } catch (error) {
    actions.notify(errorMessage(error), "error");
    return;
  }
  // The no-worktree rule has to know the folder before the page is made.
  onFolder(project.directory);
  if (!await actions.openWorkspace(project.workspaceId)) {
    actions.notify("The customization project could not be opened.", "error");
    return;
  }
  prefix.offer({ workspaceId: project.workspaceId, directory: project.directory }, () => actions.notify("The draft did not open. Try Customize Tau again.", "warning"));
}

const inProject = (thread: NonNullable<ReturnType<WorkbenchActions["activeThread"]>>, target: CustomizeTarget): boolean =>
  thread.workspaceId === target.workspaceId || (thread.cwd !== undefined && trimmed(thread.cwd) === trimmed(target.directory));

/** The entry at the top of Settings → Extensions; with nothing installed it says what the button is for. */
function CustomizeSection({ host, start }: { host: HostExtensionClient; start(): Promise<void> }) {
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void Promise.all([host.invoke("customization-folder"), host.invoke("list")])
      .then(([folder, listed]) => { if (current) setEmpty((folder as CustomizationFolder).packages === 0 && (listed as { packages: unknown[] }).packages.length === 0); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [host]);
  return (
    <SettingsSection title="Customize">
      <SettingRow
        id="setting-packages-customize"
        title="Customize Tau"
        description={empty
          ? "Nothing is installed yet. Say what you want changed and a thread builds it as an extension in your own project."
          : "Say what you want changed and a thread builds it as an extension in your own project."}
        control={(
          <Button variant="primary" busy={busy} onClick={() => { setBusy(true); void start().finally(() => setBusy(false)); }}>
            Customize Tau…
          </Button>
        )}
      />
    </SettingsSection>
  );
}

/** The palette command, the Settings entry, and the rule that this project's threads never get a worktree. */
export function registerCustomizeEntry(plugin: DesktopExtensionContext): void {
  let bound: WorkbenchActions | undefined;
  const prefix = createPendingPrefix();
  let folder: string | undefined;
  const remember = (directory: string) => { folder = trimmed(directory); };
  // The folder is also asked up front, so a draft in an existing project already follows the rule.
  void Promise.resolve(plugin.host.invoke("customization-folder")).then((answer) => {
    const directory = (answer as Partial<CustomizationFolder> | undefined)?.directory;
    if (directory) remember(directory);
  }, () => undefined);

  plugin.registerCommand({
    id: "packages.customize",
    label: "Customize Tau…",
    group: "Extensions",
    access: "write",
    run: (app) => startCustomization(plugin.host, app, prefix, remember),
  });
  // Its actions are the draft on screen's: they fill the composer, and the Settings button borrows them.
  plugin.registerRegion({
    id: "packages.customize-actions",
    placement: "composer-above",
    order: 91,
    profiles: ["desktop", "web"],
    Component: function CustomizeActions({ actions }: RegionProps) {
      const waiting = useSyncExternalStore(prefix.subscribe, prefix.getSnapshot);
      useEffect(() => {
        bound = actions;
        return () => { if (bound === actions) bound = undefined; };
      }, [actions]);
      const threads = useThreadStore();
      const index = useSyncExternalStore(threads.subscribe, threads.getSnapshot);
      useEffect(() => {
        const thread = waiting ? actions.activeThread() : undefined;
        if (!waiting || !thread || !inProject(thread, waiting.target)) return;
        // The project opens on an empty page of its own, or on a thread already used; only the second needs a draft.
        if (thread.sessionId !== undefined && (threads.getThread(thread.sessionId)?.messageCount ?? 0) > 0) {
          if (prefix.ask()) actions.newSession({ workspace: waiting.target.workspaceId });
          return;
        }
        prefix.take();
        // Text the user already typed into this draft stays as it is.
        if (!actions.composerDraft().trim()) actions.setComposerDraft?.(CUSTOMIZE_PROMPT_PREFIX);
        actions.focusComposer();
      }, [waiting, actions, threads, index]);
      return null;
    },
  });
  plugin.registerSettingsSection({
    id: "packages.customize",
    page: "extensions",
    order: 5,
    profiles: ["desktop", "web"],
    rows: [{ id: "setting-packages-customize", label: "Customize Tau", keywords: ["change", "button", "panel", "theme", "my own", "extension", "package"] }],
    Component: ({ onNotify }: SettingsSectionProps) => (
      <CustomizeSection
        host={plugin.host}
        start={async () => {
          if (!bound) { onNotify("The chat is not ready yet. Try again in a moment.", "warning"); return; }
          const app = bound;
          app.closeSettings?.();
          await startCustomization(plugin.host, app, prefix, remember);
        }}
      />
    ),
  });
  plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (workspace) =>
    workspace.registerInPlaceProjects((cwd) => folder !== undefined && trimmed(cwd) === folder));
}
