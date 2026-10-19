import { useEffect, useState } from "react";
import { Button, SettingRow, SettingsSection, errorMessage, type DesktopExtensionContext, type HostExtensionClient, type RegionProps, type SettingsSectionProps, type WorkbenchActions } from "tau";
import { WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "../workspace/protocol.js";
import { CUSTOMIZE_PROMPT_PREFIX, type CustomizationFolder, type CustomizationProject } from "./protocol.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const trimmed = (path: string) => path.replace(/[\\/]+$/u, "");

/**
 * "Customize Tau…": the customization project (made on the first call, the same one after),
 * a new thread's draft in it, and "Change Tau: " in the composer for the user to finish.
 * Nothing is sent.
 */
export async function startCustomization(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  onFolder: (directory: string) => void = () => undefined,
  /** The window's current actions: the ones in hand write to the draft that was on screen before the new one. */
  latest?: () => WorkbenchActions,
): Promise<void> {
  let project: CustomizationProject;
  try {
    project = await host.invoke("customization-project") as CustomizationProject;
  } catch (error) {
    actions.notify(errorMessage(error), "error");
    return;
  }
  // The no-worktree rule has to know the folder before the draft is made.
  onFolder(project.directory);
  if (!await actions.openWorkspace(project.workspaceId)) {
    actions.notify("The customization project could not be opened.", "error");
    return;
  }
  const inProject = () => {
    const thread = actions.activeThread();
    // A draft has no thread yet; `draftPending` only says its first prompt is on its way.
    return thread !== undefined && thread.sessionId === undefined && (thread.workspaceId === project.workspaceId || (thread.cwd !== undefined && trimmed(thread.cwd) === trimmed(project.directory)));
  };
  // A draft of the project already on screen is the one to use.
  if (!inProject()) {
    const before = latest?.();
    actions.newSession({ workspace: project.workspaceId });
    // A project the window does not list yet gets no draft; ask again until the host's list has it.
    for (let attempt = 1; attempt < 400 && !inProject(); attempt += 1) {
      await wait(25);
      if (attempt % 6 === 0 && !inProject()) actions.newSession({ workspace: project.workspaceId });
    }
    if (!inProject()) {
      actions.notify("The draft did not open. Try Customize Tau again.", "warning");
      return;
    }
    // The new draft's actions arrive with the next render.
    for (let attempt = 0; latest && attempt < 40 && latest() === before; attempt += 1) await wait(25);
  }
  const current = latest?.() ?? actions;
  // Text the user already typed into this draft stays as it is.
  if (!current.composerDraft().trim()) current.setComposerDraft?.(CUSTOMIZE_PROMPT_PREFIX);
  current.focusComposer();
}

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
    run: (app) => startCustomization(plugin.host, app, remember, () => bound ?? app),
  });
  // The Settings button has no actions of its own; this region hands it the window's.
  plugin.registerRegion({
    id: "packages.customize-actions",
    placement: "composer-above",
    order: 91,
    profiles: ["desktop", "web"],
    Component: function CustomizeActions({ actions }: RegionProps) {
      useEffect(() => {
        bound = actions;
        return () => { if (bound === actions) bound = undefined; };
      }, [actions]);
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
          await startCustomization(plugin.host, app, remember, () => bound ?? app);
        }}
      />
    ),
  });
  plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (workspace) =>
    workspace.registerInPlaceProjects((cwd) => folder !== undefined && trimmed(cwd) === folder));
}
