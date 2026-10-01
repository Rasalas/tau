import { useEffect } from "react";
import { SegmentedControl, Select, SettingRow, SettingsSection, Switch, TextField, useSetting, type SettingHandle } from "tau";
import { WORKSPACE_HOST_EXTENSION_ID as ID, type WorktreeSubmodules } from "./protocol.js";
import { AUTO_PULL_OPTION, NEW_THREAD_WORKSPACE_KEY, PROJECT_BASE_DIRECTORY_KEY, START_FROM_ORIGIN_OPTION, TRACE_TABS_OPTION, WORKTREE_DIRECTORY_KEY, WORKTREE_SUBMODULES_KEY } from "./store.js";
import { useWorkspaceState } from "./branch-menu.js";

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

/** The page's rows, for the Settings search. */
export const SOURCE_CONTROL_SETTINGS_ROWS = [
  { id: "setting-worktree-submodules", label: "Submodules", keywords: ["git submodules", "recursive", "worktreeSubmodules"] },
  { id: "setting-auto-pull", label: "Keep the default branch current", keywords: ["pull", "fast-forward", "upstream", "main"] },
  { id: "setting-project-base-directory", label: "Add project starts in", keywords: ["clone", "folder", "base folder", "directory"] },
];

/**
 * Settings → Source control: how a new worktree fills its submodules, whether
 * the default branch keeps itself current, and where new projects start.
 * Where new threads run and what they start from are General's New threads.
 */
export function SourceControlPage() {
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
      <SettingsSection title="New worktrees">
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
          control={<PathField label="Add project starts in" placeholder="~/" setting={baseDirectory} />} />
      </SettingsSection>
    </div>
  );
}

/** A folder, written on Enter or blur; empty clears this level's value. */
function PathField({ label, placeholder, setting }: { label: string; placeholder: string; setting: SettingHandle<string> }) {
  return <TextField label={label} placeholder={placeholder} mono value={setting.value} onCommit={(draft) => {
    const next = draft.trim();
    if (next === setting.value) return;
    if (next) setting.set(next);
    else setting.reset();
  }} />;
}

/**
 * General's New threads card (design 2i): a worktree branch's name when its
 * field stays empty, what it starts from, and whether a new thread gets one;
 * the draft's popover changes each for one thread.
 */
export function NewThreadRows() {
  const { store, state } = useWorkspaceState();
  const origin = useSetting<boolean>(option(START_FROM_ORIGIN_OPTION), { defaultValue: true, scope: "both", read: readBoolean });
  const mode = useSetting<string>(value(NEW_THREAD_WORKSPACE_KEY), { defaultValue: "current", read: readString });
  const main = state.defaultBranches[state.workspaceId ?? state.cwd ?? ""] ?? "main";
  return <>
    <SettingRow title="Branch name" description="when you leave it empty"
      control={<SegmentedControl label="Branch name" value={store.branchNaming()} options={[{ value: "prompt", label: "From prompt" }, { value: "random", label: "Random" }]} onChange={(next) => store.setBranchNaming(next)} />} />
    <SettingRow title="Base" setting={origin}
      control={<SegmentedControl label="Base" value={String(origin.value)} options={[{ value: "true", label: `origin/${main}` }, { value: "false", label: main }]} onChange={(next) => origin.set(next === "true")} />} />
    <SettingRow id="setting-new-thread-workspace" title="New threads" setting={mode}
      control={<SegmentedControl label="New threads run in" value={mode.value} options={[{ value: "current", label: "Current checkout" }, { value: "worktree", label: "New worktree" }]} onChange={mode.set} />} />
  </>;
}

/** General's Threads card: a tab for each file the agent reads or edits (design 1a). */
export function TraceTabsRow() {
  const trace = useSetting<boolean>(option(TRACE_TABS_OPTION), { defaultValue: true, read: readBoolean });
  return <SettingRow title="Trace tabs" description="open files the agent touches" setting={trace}
    control={<Switch label="Trace tabs" checked={trace.value} onChange={trace.set} />} />;
}

/** Connections' This machine card (design 2h): the editor "Open in editor" launches, and where new worktrees go. */
export function ThisMachineRows() {
  const { store, state } = useWorkspaceState();
  useEffect(() => { void store.loadEditors(); }, [store]);
  const folder = useSetting<string>(value(WORKTREE_DIRECTORY_KEY), { defaultValue: "", read: readString });
  return <>
    <SettingRow title="Editor" description="“Open in editor” launches"
      control={<Select label="Editor" value={store.activeEditor()?.id} options={state.editors.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(id) => store.chooseEditor(id)} />} />
    <SettingRow title="Git" description="worktrees under" setting={folder}
      control={<PathField label="Worktrees under" placeholder="Beside each project" setting={folder} />} />
  </>;
}
