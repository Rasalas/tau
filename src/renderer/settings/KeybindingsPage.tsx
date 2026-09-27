import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Keyboard, MoreHorizontal, Plus, Search, TriangleAlert, X } from "lucide-react";
import type { ExtensionRegistry, KeybindingCollision, ResolvedKeybinding, UserKeymapContribution } from "../extension-system";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { chordFromKeyboardEvent, formatKeyChord, isMacPlatform, parseKeyChord } from "../keybindings";
import { Menu } from "../components/Menu";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { tooltipProps } from "../components/ui/Tooltip";
import { errorMessage } from "../../workbench/error-message";
import { chordsAfterEdit, keybindingSource, pressesKeys, whenError, whenSuggestions } from "./keybinding-editor";
import { Badge, Button, HelpTip, SettingsState, TextField } from "./controls";
import { SettingsSection } from "./settings-layout";


const chordLabel = (keys: string, mac: boolean) => {
  const chord = parseKeyChord(keys);
  return chord ? formatKeyChord(chord, mac) : keys;
};

const hasModifier = (event: ReactKeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

/**
 * A field that takes the next chord pressed. Escape gives up, a bare Tab
 * leaves; while it has the keyboard no workbench chord runs.
 */
function ChordRecorder({ label, placeholder = "Press keys…", mac, onRecord, onStop }: {
  label: string;
  placeholder?: string;
  mac: boolean;
  onRecord(keys: string): void;
  onStop(): void;
}) {
  return (
    <input
      className="keybinding-recorder"
      {...{ [KEYBINDING_CAPTURE_ATTRIBUTE]: "" }}
      readOnly
      autoFocus
      placeholder={placeholder}
      aria-label={label}
      onBlur={onStop}
      onKeyDown={(event) => {
        if (event.key === "Tab" && !hasModifier(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape" && !hasModifier(event)) return onStop();
        const keys = chordFromKeyboardEvent(event.nativeEvent, mac);
        if (keys) onRecord(keys);
      }}
    />
  );
}

interface EditorContext {
  registry: ExtensionRegistry;
  keymap: UserKeymapContribution & { extensionId: string };
  mac: boolean;
  onNotify(message: string): void;
}

interface Draft {
  recording: boolean;
  key?: string;
  when: string;
  /** Opened to change the clause alone, so the field gets the keyboard. */
  whenOnly?: boolean;
}

/** One chord being recorded or changed: the old one it replaces (`target`), or a new one for the command. */
function useChordDraft({ registry, keymap, onNotify }: EditorContext, commandId: string, target?: ResolvedKeybinding) {
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const inherited = registry.getDefaultKeybindings(commandId)[0]?.when;
  const startWhen = target ? target.when ?? "" : inherited ?? "";
  const write = async (chords: Parameters<UserKeymapContribution["setChords"]>[1]) => {
    setSaving(true);
    try {
      await keymap.setChords(commandId, chords);
      setDraft(undefined);
    } catch (error) {
      onNotify(`Could not write ${keymap.label}: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };
  return {
    draft,
    saving,
    record: () => setDraft((current) => ({ recording: true, key: current?.key, when: current?.when ?? startWhen })),
    editWhen: () => setDraft({ recording: false, key: target?.keys, when: startWhen, whenOnly: true }),
    recorded: (key: string) => setDraft((current) => ({ recording: false, key, when: current?.when ?? startWhen })),
    // Leaving the recorder keeps a chord already recorded, else drops the draft.
    stopRecording: () => setDraft((current) => (current?.key ? { ...current, recording: false } : undefined)),
    setWhen: (when: string) => setDraft((current) => current && { ...current, when }),
    cancel: () => setDraft(undefined),
    dirty: Boolean(draft?.key) && (draft!.key !== target?.keys || draft!.when.trim() !== startWhen.trim()),
    save: () => draft?.key ? write(chordsAfterEdit(registry.getKeybindings(), commandId, inherited, { target, next: { key: draft.key, when: draft.when } })) : Promise.resolve(),
    remove: () => write(chordsAfterEdit(registry.getKeybindings(), commandId, inherited, { target })),
    reset: () => write(undefined),
  };
}
type ChordDraft = ReturnType<typeof useChordDraft>;

function collisionText(collision: KeybindingCollision, commandLabel: (id: string) => string): string {
  const other = `${commandLabel(collision.binding.commandId)} (${collision.binding.extensionName})`;
  if (collision.outcome === "wins") return `Takes the keys from ${other} wherever both apply.`;
  if (collision.outcome === "loses") return `${other} keeps these keys wherever both apply.`;
  return `Same keys as ${other}: only one of the two stays bound.`;
}

/** The `when` field, the collisions of the chord drafted, Save and Cancel. */
function DraftPanel({ context, commandId, label, editor, commandLabel }: {
  context: EditorContext;
  commandId: string;
  label: string;
  editor: ChordDraft;
  commandLabel(id: string): string;
}) {
  const { draft } = editor;
  if (!draft || draft.recording || !draft.key) return null;
  const error = whenError(draft.when);
  // An empty clause is written as "everywhere", so the check reads it that way too.
  const candidate = { commandId, key: draft.key, when: draft.when.trim() || "true" };
  const here = error ? [] : context.registry.findKeybindingCollisions(candidate, context.mac);
  const there = error ? [] : context.registry.findKeybindingCollisions(candidate, !context.mac)
    .filter((hit) => !here.some((other) => other.binding.commandId === hit.binding.commandId));
  const elsewhere = context.mac ? "on Windows and Linux" : "on macOS";
  return (
    <div
      className="keybinding-draft"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || hasModifier(event)) return;
        event.preventDefault();
        editor.cancel();
      }}
    >
      <label className="keybinding-when">
        <span>When</span>
        {/* Checked, with its collisions, at each key. */}
        <TextField
          label={`When clause for ${label}`}
          value={draft.when}
          placeholder="Everywhere"
          mono
          autoFocus={draft.whenOnly}
          suggestions={whenSuggestions(context.registry.getKeybindings())}
          error={error}
          onChange={editor.setWhen}
        />
      </label>
      {[...here.map((hit) => [hit, context.mac, ""] as const), ...there.map((hit) => [hit, !context.mac, ` ${elsewhere}`] as const)].map(([hit, mac, where]) => (
        <p className="keybinding-collision" data-outcome={hit.outcome} key={`${hit.binding.commandId}${where}`}>
          <TriangleAlert size={12} aria-hidden />
          <span>{chordLabel(draft.key!, mac)}{where}: {collisionText(hit, commandLabel)}</span>
        </p>
      ))}
      <div className="keybinding-draft-actions">
        <Button onClick={editor.cancel} disabled={editor.saving}>Cancel</Button>
        <Button variant="primary" autoFocus={!draft.whenOnly} busy={editor.saving} onClick={() => void editor.save()} disabled={!editor.dirty || Boolean(error)}>Save</Button>
      </div>
    </div>
  );
}

/** The chord of a row: a button that starts recording, the recorder, or the chord drafted. */
function ChordControl({ label, keys, editor, mac }: { label: string; keys?: string; editor: ChordDraft; mac: boolean }) {
  const { draft } = editor;
  if (draft?.recording) {
    return <ChordRecorder label={`Press the new chord for ${label}`} mac={mac} onRecord={editor.recorded} onStop={editor.stopRecording} />;
  }
  const shown = draft?.key ?? keys;
  return (
    <button type="button" className="keybinding-chord" data-drafted={draft?.key ? "" : undefined} aria-label={`Change the chord for ${label}${shown ? `: ${chordLabel(shown, mac)}` : ""}`} onClick={editor.record}>
      {shown ? <kbd>{chordLabel(shown, mac)}</kbd> : <span className="settings-row-empty">Record</span>}
    </button>
  );
}

function RowMenu({ label, items, onSelect }: { label: string; items: Array<{ id: string; label: string; destructive?: boolean }>; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <span className="menu-anchor keybinding-row-menu">
      <button type="button" className="tau-icon-button" aria-label={`More for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={14} />
      </button>
      {open ? <Menu align="right" label={`More for ${label}`} items={items} onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** One live chord: click it to record another, or change where it applies. */
function KeybindingRow({ binding, commandLabel, context, siblings }: {
  binding: ResolvedKeybinding;
  commandLabel(id: string): string;
  context: EditorContext | undefined;
  /** How many live chords the command has, this one included. */
  siblings: number;
}) {
  const source = keybindingSource(binding, context?.keymap.extensionId);
  const label = commandLabel(binding.commandId);
  const editable = context !== undefined && source !== "config";
  const title = (
    <span>
      <strong>
        {label}
        {source === "custom" ? <Badge>Custom</Badge> : null}
        {source === "config" ? <span {...tooltipProps("Set in config.json's keybindings; change it there")}><Badge>config.json</Badge></span> : null}
      </strong>
      <small>{binding.commandId} · {binding.extensionName.toLowerCase()}{binding.when ? <> · when <code>{binding.when}</code></> : null}</small>
    </span>
  );
  if (!editable) {
    return <div className="keybinding-row">{title}<kbd>{binding.label}</kbd></div>;
  }
  return <EditableKeybindingRow binding={binding} label={label} title={title} source={source} context={context} siblings={siblings} commandLabel={commandLabel} />;
}

function EditableKeybindingRow({ binding, label, title, source, context, siblings, commandLabel }: {
  binding: ResolvedKeybinding;
  label: string;
  title: ReactNode;
  source: ReturnType<typeof keybindingSource>;
  context: EditorContext;
  siblings: number;
  commandLabel(id: string): string;
}) {
  const editor = useChordDraft(context, binding.commandId, binding);
  const adder = useChordDraft(context, binding.commandId);
  const items = [
    { id: "when", label: "Change where it applies" },
    { id: "add", label: "Add another chord" },
    ...(source === "custom" ? [{ id: "reset", label: "Reset to default" }] : []),
    ...(siblings > 1 ? [{ id: "remove", label: "Remove this chord", destructive: true }] : []),
  ];
  return (
    <div className="keybinding-row-group" data-editing={editor.draft || adder.draft ? "" : undefined}>
      <div className="keybinding-row" data-source={source}>
        {title}
        <RowMenu label={label} items={items} onSelect={(id) => {
          if (id === "when") editor.editWhen();
          else if (id === "add") adder.record();
          else if (id === "reset") void editor.reset();
          else if (id === "remove") void editor.remove();
        }} />
        <ChordControl label={label} keys={binding.keys} editor={editor} mac={context.mac} />
      </div>
      <DraftPanel context={context} commandId={binding.commandId} label={label} editor={editor} commandLabel={commandLabel} />
      {adder.draft ? (
        <div className="keybinding-row keybinding-add-row">
          <span><small>Another chord for {label}</small></span>
          <ChordControl label={label} editor={adder} mac={context.mac} />
        </div>
      ) : null}
      <DraftPanel context={context} commandId={binding.commandId} label={label} editor={adder} commandLabel={commandLabel} />
    </div>
  );
}

/** A command in the full list: its chords, and a way to add one. */
function CommandRow({ command, bound, context, commandLabel }: {
  command: { id: string; label: string; group: string };
  bound: readonly ResolvedKeybinding[];
  context: EditorContext | undefined;
  commandLabel(id: string): string;
}) {
  const row = (control?: ReactNode) => (
    <div className="keybinding-row">
      <span>
        <strong>{command.label}</strong>
        <small><code>{command.id}</code> ({command.group})</small>
      </span>
      <div className="keybinding-keys">
        {bound.length > 0 ? [...new Set(bound.map((b) => b.label))].map((label) => <kbd key={label}>{label}</kbd>) : <span className="settings-row-empty">Unbound</span>}
      </div>
      {control}
    </div>
  );
  if (!context) return row();
  return <EditableCommandRow command={command} context={context} commandLabel={commandLabel} row={row} />;
}

function EditableCommandRow({ command, context, commandLabel, row }: {
  command: { id: string; label: string };
  context: EditorContext;
  commandLabel(id: string): string;
  row(control: ReactNode): ReactNode;
}) {
  const adder = useChordDraft(context, command.id);
  return (
    <div className="keybinding-row-group" data-editing={adder.draft ? "" : undefined}>
      {row(adder.draft ? <ChordControl label={command.label} editor={adder} mac={context.mac} /> : (
        <button type="button" className="tau-icon-button" aria-label={`Add a chord for ${command.label}`} {...tooltipProps("Add a chord")} onClick={adder.record}><Plus size={14} /></button>
      ))}
      <DraftPanel context={context} commandId={command.id} label={command.label} editor={adder} commandLabel={commandLabel} />
    </div>
  );
}

/**
 * Every live chord, the Pi actions `keybindings.json` names that Tau does not
 * implement, and on request every command id. Where an extension offers a
 * user keymap (`registerUserKeymap`) a chord is changed by clicking it and
 * pressing the new keys; without one the page only lists.
 */
export function KeybindingsPage({ registry, initialFilter = "", onNotify = () => {} }: { registry: ExtensionRegistry; initialFilter?: string; onNotify?(message: string): void }) {
  const [filter, setFilter] = useState(initialFilter);
  const [keyFilter, setKeyFilter] = useState<string>();
  const [searchingKeys, setSearchingKeys] = useState(false);
  const [showAllCommands, setShowAllCommands] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const mac = isMacPlatform();

  const keybindings = registry.getKeybindings();
  const commands = registry.getCommands();
  const conflicts = registry.getKeybindingConflicts();
  const keymap = registry.getUserKeymap();
  const context: EditorContext | undefined = keymap ? { registry, keymap, mac, onNotify } : undefined;
  const commandLabel = (id: string) => commands.find((command) => command.id === id)?.label ?? id;

  const query = filter.trim().toLowerCase();
  // A keybindings.json names a Pi action by its own id. When Tau implements no
  // command for it the chord is registered but nothing runs, so it belongs in
  // its own list rather than under "active".
  const implemented = keybindings.filter((binding) => commands.some((command) => command.id === binding.commandId));
  const unimplemented = keybindings.filter((binding) => !commands.some((command) => command.id === binding.commandId));

  const matches = (...texts: Array<string | undefined>) => !query || texts.some((text) => text?.toLowerCase().includes(query));
  const pressed = (binding: { keys: string }) => !keyFilter || pressesKeys(binding, keyFilter, mac);
  const filteredBindings = implemented.filter((b) => pressed(b) && matches(commandLabel(b.commandId), b.commandId, b.keys, b.label, b.extensionName, b.when));
  const rowKey = (b: (typeof keybindings)[number]) => `${b.keys}|${b.when ?? ""}|${b.commandId}`;
  const filteredUnimplemented = unimplemented.filter((b) => pressed(b) && matches(b.commandId, b.keys, b.extensionName));
  const filteredCommands = commands.filter((c) => (!keyFilter || keybindings.some((b) => b.commandId === c.id && pressed(b))) && matches(c.label, c.id, c.group));
  // Pi actions Tau has no command for stay Pi's, so they do not call for Reset all.
  const custom = implemented.some((binding) => keybindingSource(binding, keymap?.extensionId) === "custom");
  const noMatch = keyFilter ? `No keybinding presses ${chordLabel(keyFilter, mac)}` : `No keybinding matches “${filter.trim()}”`;

  const resetAll = async () => {
    setConfirmReset(false);
    try {
      await keymap?.resetAll();
    } catch (error) {
      onNotify(`Could not write ${keymap?.label}: ${errorMessage(error)}`);
    }
  };

  const clearFilter = () => { setFilter(""); setKeyFilter(undefined); };
  const filtering = Boolean(query || keyFilter);

  return (
    <div className="settings-page">
      {keymap ? (
        <p className="lede">Chords bound to workbench commands and Pi actions. Click a chord and press the new keys, or pick where it applies from its menu; a save writes <code>{keymap.label}</code> and applies at once. A chord without a <code>when</code> clause keeps its default&rsquo;s.</p>
      ) : (
        <p className="lede">Chords bound to workbench commands and Pi actions. Rebind any command id or Pi action in <code>~/.pi/agent/keybindings.json</code>, as a chord or as <code>{"{"} "key": "mod+d", "when": "terminalFocus" {"}"}</code> to say where it applies; a rebound chord without <code>when</code> keeps the default&rsquo;s.</p>
      )}

      <div className="keybinding-search">
        <label className="settings-filter">
          <Search size={14} aria-hidden />
          {searchingKeys ? (
            <ChordRecorder label="Press the keys to search for" placeholder="Press the keys to search for…" mac={mac} onRecord={(keys) => { setKeyFilter(keys); setFilter(""); setSearchingKeys(false); }} onStop={() => setSearchingKeys(false)} />
          ) : keyFilter ? (
            <span className="keybinding-key-filter">
              <kbd>{chordLabel(keyFilter, mac)}</kbd>
              <button type="button" className="tau-icon-button" aria-label="Clear the key search" onClick={() => setKeyFilter(undefined)}><X size={13} /></button>
            </span>
          ) : (
            <>
              <input
                type="search"
                placeholder="Filter keybindings or commands…"
                aria-label="Filter keybindings or commands"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }}
              />
              {filter ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => setFilter("")}><X size={13} /></button> : null}
            </>
          )}
        </label>
        <Button
          className="keybinding-keys-button"
          icon={<Keyboard size={15} />}
          aria-label="Search by keys"
          aria-pressed={searchingKeys}
          {...tooltipProps("Search by pressing the keys")}
          onClick={() => setSearchingKeys(!searchingKeys)}
        />
      </div>

      <SettingsSection
        title={`Active keybindings (${filteredBindings.length})`}
        headerAction={<>
          {keymap && custom ? <Button variant="ghost" onClick={() => setConfirmReset(true)}>Reset all</Button> : null}
          <Button variant="ghost" onClick={() => setShowAllCommands((v) => !v)}>{showAllCommands ? "Hide command ids" : "Show all command ids"}</Button>
        </>}
      >
        {filteredBindings.map((binding) => (
          <KeybindingRow
            key={rowKey(binding)}
            binding={binding}
            commandLabel={commandLabel}
            context={context}
            siblings={keybindings.filter((other) => other.commandId === binding.commandId && keybindingSource(other) !== "config").length}
          />
        ))}
        {filteredBindings.length === 0 ? (
          filtering
            ? <SettingsState kind="empty" title={noMatch} description="Search by a command's name, its id, its keys or where it applies." action={<Button onClick={clearFilter}>Clear the search</Button>} />
            : <SettingsState kind="empty" title="No keybindings" description="Extensions bind their chords as they load; none has bound one yet." />
        ) : null}
      </SettingsSection>

      {filteredUnimplemented.length > 0 ? (
        <SettingsSection
          title={`Not implemented by Tau (${filteredUnimplemented.length})`}
          headerAction={<HelpTip label="Why" text="~/.pi/agent/keybindings.json names these Pi actions, but Tau has no command for them, so pressing the chord does nothing." />}
        >
          {filteredUnimplemented.map((binding) => (
            <div className="keybinding-row" key={rowKey(binding)} data-level="unimplemented">
              <span>
                <strong>{binding.commandId}</strong>
                <small>{binding.extensionName.toLowerCase()}</small>
              </span>
              <kbd>{binding.label}</kbd>
            </div>
          ))}
        </SettingsSection>
      ) : null}

      {conflicts.length > 0 ? (
        <SettingsSection title={`Ignored chords (${conflicts.length})`}>
          {conflicts.map((conflict) => (
            <div className="keybinding-row" key={`${conflict.keys}:${conflict.commandId}`} data-level="ignored">
              <span>
                <strong>{commandLabel(conflict.commandId)} <Badge tone="warn">Ignored</Badge></strong>
                <small>{conflict.extensionId} · {conflict.boundTo.extensionId} bound it to {conflict.boundTo.commandId} first</small>
              </span>
              <kbd>{chordLabel(conflict.keys, mac)}</kbd>
            </div>
          ))}
        </SettingsSection>
      ) : null}

      {showAllCommands ? (
        <SettingsSection
          title={`All registered commands (${filteredCommands.length})`}
          headerAction={<HelpTip label="How to bind" text={keymap ? "Add a chord to any command with its + button." : "Use any of these command ids in ~/.pi/agent/keybindings.json to bind a chord."} />}
        >
          {filteredCommands.map((command) => (
            <CommandRow key={command.id} command={command} bound={keybindings.filter((b) => b.commandId === command.id)} context={context} commandLabel={commandLabel} />
          ))}
          {filteredCommands.length === 0 ? <SettingsState kind="empty" title="No command matches" action={<Button onClick={clearFilter}>Clear the search</Button>} /> : null}
        </SettingsSection>
      ) : null}

      {confirmReset ? (
        <ConfirmDialog
          title="Reset every keybinding?"
          message={<>Every command gets its default chords back, and the chords you set are removed from <code>{keymap?.label}</code>.</>}
          confirmLabel="Reset all"
          destructive
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => void resetAll()}
        />
      ) : null}

    </div>
  );
}
