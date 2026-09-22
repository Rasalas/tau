import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ExtensionRegistry } from "../extension-system";
import { SettingsSection } from "./settings-layout";

/**
 * Every live chord, the Pi actions `keybindings.json` names that Tau does not
 * implement, and on request every command id. Read-only: chords are rebound in
 * Pi's own file.
 */
export function KeybindingsPage({ registry, initialFilter = "" }: { registry: ExtensionRegistry; initialFilter?: string }) {
  const [filter, setFilter] = useState(initialFilter);
  const [showAllCommands, setShowAllCommands] = useState(false);

  const keybindings = registry.getKeybindings();
  const commands = registry.getCommands();
  const conflicts = registry.getKeybindingConflicts();

  const query = filter.trim().toLowerCase();
  // A keybindings.json names a Pi action by its own id. When Tau implements no
  // command for it the chord is registered but nothing runs, so it belongs in
  // its own list rather than under "active".
  const implemented = keybindings.filter((binding) => commands.some((command) => command.id === binding.commandId));
  const unimplemented = keybindings.filter((binding) => !commands.some((command) => command.id === binding.commandId));

  const filteredBindings = useMemo(() => {
    if (!query) return implemented;
    return implemented.filter((b) => {
      const label = commands.find((c) => c.id === b.commandId)?.label?.toLowerCase() ?? "";
      return label.includes(query) || b.commandId.toLowerCase().includes(query) || b.keys.toLowerCase().includes(query)
        || b.label.toLowerCase().includes(query) || b.extensionName.toLowerCase().includes(query);
    });
  }, [implemented, commands, query]);

  const filteredUnimplemented = useMemo(() => {
    if (!query) return unimplemented;
    return unimplemented.filter((b) => b.commandId.toLowerCase().includes(query) || b.keys.toLowerCase().includes(query) || b.extensionName.toLowerCase().includes(query));
  }, [unimplemented, query]);

  const filteredCommands = useMemo(() => {
    if (!query) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(query) || c.id.toLowerCase().includes(query) || c.group.toLowerCase().includes(query));
  }, [commands, query]);

  return (
    <div className="settings-page">
      <p className="lede">Chords bound to workbench commands and Pi actions. Rebind any command id or Pi action in <code>~/.pi/agent/keybindings.json</code>; run <code>/reload</code> after editing it.</p>

      <label className="settings-filter">
        <Search size={14} />
        <input
          type="search"
          placeholder="Filter keybindings or commands…"
          aria-label="Filter keybindings or commands"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>

      <SettingsSection
        title={`Active keybindings (${filteredBindings.length})`}
        headerAction={<button className="text-button" onClick={() => setShowAllCommands((v) => !v)}>{showAllCommands ? "Hide command ids" : "Show all command ids"}</button>}
      >
        {filteredBindings.map((binding) => (
          <div className="keybinding-row" key={binding.keys}>
            <span>
              <strong>{commands.find((command) => command.id === binding.commandId)?.label ?? binding.commandId}</strong>
              <small>{binding.commandId} · {binding.extensionName.toLowerCase()}</small>
            </span>
            <kbd>{binding.label}</kbd>
          </div>
        ))}
        {filteredBindings.length === 0 ? (
          <div className="keybinding-row"><span>No keybindings match &ldquo;{filter}&rdquo;.</span></div>
        ) : null}
      </SettingsSection>

      {filteredUnimplemented.length > 0 ? (
        <SettingsSection title={`Not implemented by Tau (${filteredUnimplemented.length})`}>
          <p className="settings-group-note">
            <code>~/.pi/agent/keybindings.json</code> names these Pi actions, but Tau has no command for them, so pressing the chord does nothing.
          </p>
          {filteredUnimplemented.map((binding) => (
            <div className="keybinding-row" key={binding.keys} data-level="unimplemented">
              <span>
                <strong>{binding.commandId}</strong>
                <small>{binding.extensionName.toLowerCase()}</small>
              </span>
              <kbd>{binding.label}</kbd>
            </div>
          ))}
        </SettingsSection>
      ) : null}

      {conflicts.map((conflict) => (
        <div className="settings-note" key={`${conflict.keys}:${conflict.commandId}`}>
          {conflict.keys} from {conflict.extensionId} ({conflict.commandId}) was ignored: {conflict.boundTo.extensionId} bound it to {conflict.boundTo.commandId} first.
        </div>
      ))}

      {showAllCommands ? (
        <SettingsSection title={`All registered commands (${filteredCommands.length})`}>
          <p className="settings-group-note">Use any of these command ids in <code>~/.pi/agent/keybindings.json</code> to bind a chord.</p>
          {filteredCommands.map((command) => {
            const bound = keybindings.filter((b) => b.commandId === command.id);
            return (
              <div className="keybinding-row" key={command.id}>
                <span>
                  <strong>{command.label}</strong>
                  <small><code>{command.id}</code> ({command.group})</small>
                </span>
                <div className="keybinding-keys">
                  {bound.length > 0 ? bound.map((b) => <kbd key={b.keys}>{b.label}</kbd>) : <span className="settings-row-empty">Unbound</span>}
                </div>
              </div>
            );
          })}
        </SettingsSection>
      ) : null}
    </div>
  );
}
