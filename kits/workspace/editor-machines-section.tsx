import { useEffect, useState, useSyncExternalStore } from "react";
import { errorMessage, Select, SettingRow, SettingsSection, TextField, type UiEnvironment } from "tau";
import type { EditorPlacement, EditorWindowMachines } from "./editor-placement.js";
import type { EditorMachineSetting, EditorOpenOn, EditorRemoteState } from "./protocol.js";
import { parseSshDestination } from "./remote-editors.js";
import type { WorkspaceStore } from "./store.js";

export const EDITOR_MACHINES_ROWS = [{ id: "setting-editor-machines", label: "Open projects in your editor", keywords: ["ssh", "remote", "vscode", "cursor", "zed", "editor", "destination", "remote-ssh"] }];

/** What the row says of the destination in use: entered, Tau's own route, an address, or why there is none. */
export function editorMachineDescription(remote: EditorRemoteState, openOn: EditorOpenOn | undefined): string {
  if (openOn === "machine") return `Opens in ${remote.name}'s own editor, on its screen.`;
  if (remote.problem) return remote.problem;
  const location = remote.location;
  if (location?.kind === "wsl") return `Opens in this device's editor inside the WSL distribution ${location.distro}.`;
  if (location?.kind !== "ssh") return "";
  if (remote.source === "saved") return `Opens in this device's editor over SSH at ${location.destination}.`;
  if (remote.source === "tau-ssh") return `Opens in this device's editor over SSH at ${location.destination}, the destination Tau connects with.`;
  return `Opens in this device's editor over SSH at ${location.destination}, from its address. Enter another if SSH reaches it differently.`;
}

function EditorMachineRow({ machine, setting, placement, onSaved }: {
  machine: UiEnvironment;
  setting: EditorMachineSetting | undefined;
  placement: EditorPlacement;
  onSaved(settings: Record<string, EditorMachineSetting>): void;
}) {
  const [problem, setProblem] = useState<string>();
  const remote = placement.remoteState(machine.id, machine.name, setting);
  const derived = placement.remoteState(machine.id, machine.name, setting?.openOn ? { openOn: setting.openOn } : undefined);
  const save = (patch: { ssh?: string | null; openOn?: EditorOpenOn | null }) => {
    setProblem(undefined);
    placement.setEditorMachine(machine.id, patch).then(onSaved, (error: unknown) => setProblem(errorMessage(error)));
  };
  const placeholder = derived.location?.kind === "ssh" ? derived.location.destination : "user@host or an SSH alias";
  return <SettingRow
    title={machine.name}
    description={<span role={problem ? "alert" : undefined}>{problem ?? editorMachineDescription(remote, setting?.openOn)}</span>}
    control={<>
      <TextField label={`SSH destination for ${machine.name}`} value={setting?.ssh ?? ""} placeholder={placeholder} width="md" mono
        disabled={setting?.openOn === "machine"}
        validate={(text) => { const parsed = text.trim() ? parseSshDestination(text) : undefined; return parsed && "error" in parsed ? parsed.error : undefined; }}
        onCommit={(text) => { if (text.trim() !== (setting?.ssh ?? "")) save({ ssh: text.trim() || null }); }} />
      <Select<EditorOpenOn> label={`Where ${machine.name}'s projects open`} value={setting?.openOn ?? "here"} width="md"
        options={[{ value: "here", label: "This device's editor" }, { value: "machine", label: `${machine.name}'s editor` }]}
        onChange={(openOn) => save({ openOn: openOn === "here" ? null : openOn })} />
    </>}
  />;
}

/**
 * Settings → Machines, for a desktop window: how this device reaches each
 * other machine when "Open in editor" opens one of its projects here, kept by
 * the window's own machine. The destination is guessed from the machine's
 * route until one is entered.
 */
export function createEditorMachinesSection(store: WorkspaceStore, placement: EditorPlacement, machines: EditorWindowMachines) {
  return function EditorMachinesSection() {
    const snapshot = useSyncExternalStore(machines.subscribe, machines.getSnapshot);
    const [settings, setSettings] = useState<Record<string, EditorMachineSetting>>();
    const [problem, setProblem] = useState<string>();
    const ready = Boolean(snapshot?.environments.some((environment) => environment.local));
    useEffect(() => {
      if (!ready) return undefined;
      let live = true;
      placement.editorMachines(true).then((value) => { if (live) setSettings(value); }, (error: unknown) => { if (live) setProblem(errorMessage(error)); });
      return () => { live = false; };
    }, [ready]);
    const others = snapshot?.environments.filter((environment) => !environment.local) ?? [];
    const saved = (value: Record<string, EditorMachineSetting>) => {
      setSettings(value);
      void store.loadEditors();
    };
    return <SettingsSection title="Open projects in your editor" id="setting-editor-machines">
      <SettingRow title="Another machine's project" description="“Open in editor” opens it in an editor of this device over SSH: VS Code, Cursor, Windsurf, VSCodium and Zed with their remote support. Enter user@host, host:port or an ~/.ssh/config alias where Tau's guess is wrong; SSH needs a key, not a password." />
      {problem ? <p role="alert">{problem}</p> : null}
      {others.length === 0 ? <p className="settings-group-note">Add a machine to open its projects here.</p> : null}
      {settings ? others.map((machine) => <EditorMachineRow key={machine.id} machine={machine} setting={settings[machine.id]} placement={placement} onSaved={saved} />) : null}
    </SettingsSection>;
  };
}
