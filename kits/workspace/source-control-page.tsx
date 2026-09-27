import { SegmentedControl, Select, SettingRow, SettingsSection, Switch, TextField, useSetting } from "tau";
import { WORKSPACE_HOST_EXTENSION_ID as ID, type WorktreeSubmodules } from "./protocol.js";
import { AUTO_PULL_OPTION, NEW_THREAD_WORKSPACE_KEY, PROJECT_BASE_DIRECTORY_KEY, START_FROM_ORIGIN_OPTION, WORKTREE_SUBMODULES_KEY } from "./store.js";

const value = (key: string) => `values.${ID}.${key}`;
const option = (key: string) => `options.${ID}.${key}`;
const readString = (raw: unknown) => (typeof raw === "string" ? raw : undefined);
const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

const SUBMODULES: ReadonlyArray<{ value: "" | WorktreeSubmodules; label: string }> = [
  { value: "", label: "Project file" },
  { value: "recursive", label: "Recursive" },
  { value: "top-level", label: "Top level only" },
  { value: "none", label: "Skip" },
];
const WORKSPACE_MODES = [{ value: "current", label: "Current checkout" }, { value: "worktree", label: "A new worktree" }] as const;

/** The page's rows, for the Settings search. */
export const SOURCE_CONTROL_SETTINGS_ROWS = [
  { id: "setting-workspace-mode", label: "New threads run in", keywords: ["worktree", "checkout", "workspace", "new thread"] },
  { id: "setting-start-from-origin", label: "New worktrees start from origin", keywords: ["fetch", "remote", "base", "stale branch"] },
  { id: "setting-worktree-submodules", label: "Submodules", keywords: ["git submodules", "recursive", "worktreeSubmodules"] },
  { id: "setting-auto-pull", label: "Keep the default branch current", keywords: ["pull", "fast-forward", "upstream", "main"] },
  { id: "setting-project-base-directory", label: "Add project starts in", keywords: ["clone", "folder", "base folder", "directory"] },
];

/**
 * Settings → Source control, after T3 Code's: where new threads and projects
 * start, how a new worktree fills its submodules, and whether the default
 * branch keeps itself current. A project may override all but the folder.
 */
export function SourceControlPage() {
  const workspaceMode = useSetting<string>(value(NEW_THREAD_WORKSPACE_KEY), { defaultValue: "current", read: readString, format: (next) => WORKSPACE_MODES.find((mode) => mode.value === next)?.label ?? next });
  const startFromOrigin = useSetting<boolean>(option(START_FROM_ORIGIN_OPTION), { defaultValue: true, scope: "both", read: readBoolean });
  const submodules = useSetting<"" | WorktreeSubmodules>(value(WORKTREE_SUBMODULES_KEY), {
    defaultValue: "",
    scope: "both",
    read: (raw) => (raw === "recursive" || raw === "top-level" || raw === "none" ? raw : undefined),
    format: (next) => SUBMODULES.find((entry) => entry.value === next)?.label ?? next,
  });
  const autoPull = useSetting<boolean>(option(AUTO_PULL_OPTION), { defaultValue: false, scope: "both", read: readBoolean });
  const baseDirectory = useSetting<string>(value(PROJECT_BASE_DIRECTORY_KEY), { defaultValue: "", read: readString, format: (next) => next || "Home folder" });

  return (
    <div className="settings-page source-control-page">
      <h3>Source control</h3>
      <SettingsSection title="New threads">
        <SettingRow id="setting-workspace-mode" title="New threads run in" description="The workspace a new thread starts in; the picker under the composer changes it for one thread." setting={workspaceMode}
          control={<SegmentedControl label="New threads run in" value={workspaceMode.value} options={WORKSPACE_MODES} onChange={workspaceMode.set} />} />
        <SettingRow id="setting-start-from-origin" title="New worktrees start from origin" description="Fetch the remote first and start the worktree at its commit, so a stale local branch is never the base." setting={startFromOrigin}
          control={<Switch label="New worktrees start from origin" checked={startFromOrigin.value} onChange={startFromOrigin.set} />} />
        <SettingRow id="setting-worktree-submodules" title="Submodules" description="How a new worktree fills its git submodules."
          help="Top level only stops at the ones the repository declares; Skip leaves them to a setup script. Project file reads worktreeSubmodules from the branch's .tau/project.json, else recursive." setting={submodules}
          control={<Select label="Submodules" value={submodules.value} options={SUBMODULES} onChange={(next) => (next === "" ? submodules.reset() : submodules.set(next))} />} />
      </SettingsSection>
      <SettingsSection title="Default branch">
        <SettingRow id="setting-auto-pull" title="Keep the default branch current" description="Fast-forward the default-branch checkout to its upstream; nothing is ever merged, rebased or reset."
          help="When the project opens, when the window comes to the front and every five minutes. Only a checkout with no changed or untracked files and no local commits moves." setting={autoPull}
          control={<Switch label="Keep the default branch current" checked={autoPull.value} onChange={autoPull.set} />} />
      </SettingsSection>
      <SettingsSection title="New projects">
        <SettingRow id="setting-project-base-directory" title="Add project starts in" description="Where the local-folder browser opens and where a clone lands. Empty starts in your home folder and asks for each clone." setting={baseDirectory}
          control={<TextField label="Add project starts in" placeholder="~/" mono value={baseDirectory.value} onCommit={(draft) => {
            const next = draft.trim();
            if (next === baseDirectory.value) return;
            if (next) baseDirectory.set(next);
            else baseDirectory.reset();
          }} />} />
      </SettingsSection>
    </div>
  );
}
