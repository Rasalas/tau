import { useEffect, useState } from "react";
import { SettingRow, SettingsSection, useSetting, type SettingHandle } from "tau";
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

function Toggle({ label, setting }: { label: string; setting: SettingHandle<boolean> }) {
  return (
    <button type="button" className={`switch ${setting.value ? "on" : ""}`} role="switch" aria-checked={setting.value} aria-label={label} disabled={!setting.writable} onClick={() => setting.set(!setting.value)}>
      <i />
    </button>
  );
}

function Choice<T extends string>({ label, setting, choices }: { label: string; setting: SettingHandle<T>; choices: ReadonlyArray<{ value: T; label: string }> }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button key={choice.value} type="button" disabled={!setting.writable} className={setting.value === choice.value ? "active" : ""} aria-pressed={setting.value === choice.value}
          onClick={() => (choice.value === "" ? setting.reset() : setting.set(choice.value))}>{choice.label}</button>
      ))}
    </div>
  );
}

/** A text field committed on blur or Enter; empty removes the level's value. */
function TextField({ label, placeholder, setting }: { label: string; placeholder: string; setting: SettingHandle<string> }) {
  const [draft, setDraft] = useState(setting.value);
  useEffect(() => setDraft(setting.value), [setting.value]);
  const commit = () => {
    const next = draft.trim();
    if (next === setting.value) return;
    if (next) setting.set(next);
    else setting.reset();
  };
  return <input type="text" className="settings-input" spellCheck={false} aria-label={label} placeholder={placeholder} value={draft} disabled={!setting.writable}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />;
}

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
          control={<Choice label="New threads run in" setting={workspaceMode} choices={WORKSPACE_MODES} />} />
        <SettingRow id="setting-start-from-origin" title="New worktrees start from origin" description="Fetch the remote first and start the worktree at its commit, so a stale local branch is never the base." setting={startFromOrigin}
          control={<Toggle label="New worktrees start from origin" setting={startFromOrigin} />} />
        <SettingRow id="setting-worktree-submodules" title="Submodules" description="How a new worktree fills its git submodules. Top level only stops at the ones the repository declares; Skip leaves them to a setup script. Project file reads worktreeSubmodules from the branch's .tau/project.json, else recursive." setting={submodules}
          control={<Choice label="Submodules" setting={submodules} choices={SUBMODULES} />} />
      </SettingsSection>
      <SettingsSection title="Default branch">
        <SettingRow id="setting-auto-pull" title="Keep the default branch current" description="Fast-forward the default-branch checkout to its upstream when the project opens, when the window comes to the front and every five minutes. Only a checkout with no changed or untracked files and no local commits moves; nothing is ever merged, rebased or reset." setting={autoPull}
          control={<Toggle label="Keep the default branch current" setting={autoPull} />} />
      </SettingsSection>
      <SettingsSection title="New projects">
        <SettingRow id="setting-project-base-directory" title="Add project starts in" description="Where the local-folder browser opens and where a clone lands. Leave it empty to start in your home folder and choose a folder for each clone." setting={baseDirectory}
          control={<TextField label="Add project starts in" placeholder="~/" setting={baseDirectory} />} />
      </SettingsSection>
    </div>
  );
}
