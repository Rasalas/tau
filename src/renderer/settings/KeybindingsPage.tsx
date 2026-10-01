import { useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Keyboard, MoreHorizontal, Pencil, Search, TriangleAlert, X } from "lucide-react";
import type { ExtensionRegistry, KeybindingCollision, ResolvedKeybinding, UserKeymapContribution } from "../extension-system";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { chordFromKeyboardEvent, formatKeyChord, isMacPlatform, keyChordParts, parseKeyChord } from "../keybindings";
import { usePreferences } from "../renderer-services-context";
import { Menu } from "../components/Menu";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { tooltipProps } from "../components/ui/Tooltip";
import { errorMessage } from "../../workbench/error-message";
import { chordsAfterEdit, KEYBINDING_CARDS, keybindingPlace, keybindingSource, pressesKeys, whenError, whenSuggestions, type KeybindingCard } from "./keybinding-editor";
import { Badge, Button, SettingsState, TextField } from "./controls";
import { SettingsCard, SettingsSection } from "./settings-layout";
import { SettingsPageAction } from "./page-action";

const chordLabel = (keys: string, mac: boolean) => {
  const chord = parseKeyChord(keys);
  return chord ? formatKeyChord(chord, mac) : keys;
};

const hasModifier = (event: ReactKeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;

/** Every key of a chord as a keycap of its own (design 2g). */
function Keycaps({ keys, mac, last }: { keys: string; mac: boolean; last?: string }) {
  const chord = parseKeyChord(keys);
  const parts = chord ? keyChordParts(chord, mac) : [keys];
  if (last) parts[parts.length - 1] = last;
  return <span className="keycaps" aria-label={chordLabel(keys, mac)}>{parts.map((part, index) => <kbd key={index} aria-hidden>{part}</kbd>)}</span>;
}

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
  /** The live chord it replaces; absent for one more chord. */
  target?: ResolvedKeybinding | undefined;
  recording: boolean;
  key?: string;
  when: string;
  /** Opened to change the clause alone, so the field gets the keyboard. */
  whenOnly?: boolean;
}

/** The one chord of a command being recorded or changed. */
function useChordDraft({ registry, keymap, onNotify }: EditorContext, commandId: string) {
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const inherited = registry.getDefaultKeybindings(commandId)[0]?.when;
  const startWhen = (target?: ResolvedKeybinding) => (target ? target.when ?? "" : inherited ?? "");
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
    record: (target?: ResolvedKeybinding) => setDraft((current) => (current && current.target === target ? { ...current, recording: true } : { target, recording: true, when: startWhen(target) })),
    editWhen: (target: ResolvedKeybinding) => setDraft({ target, recording: false, key: target.keys, when: startWhen(target), whenOnly: true }),
    recorded: (key: string) => setDraft((current) => current && { ...current, recording: false, key }),
    // Leaving the recorder keeps a chord already recorded, else drops the draft.
    stopRecording: () => setDraft((current) => (current?.key ? { ...current, recording: false } : undefined)),
    setWhen: (when: string) => setDraft((current) => current && { ...current, when }),
    cancel: () => setDraft(undefined),
    dirty: Boolean(draft?.key) && (draft!.key !== draft!.target?.keys || draft!.when.trim() !== startWhen(draft!.target).trim()),
    save: () => draft?.key ? write(chordsAfterEdit(registry.getKeybindings(), commandId, inherited, { target: draft.target, next: { key: draft.key, when: draft.when } })) : Promise.resolve(),
    remove: (target: ResolvedKeybinding) => write(chordsAfterEdit(registry.getKeybindings(), commandId, inherited, { target })),
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

/** The `when` field, the conflicts of the chord drafted, Save and Cancel. */
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
        {/* Checked, with its conflicts, at each key. */}
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

function RowMenu({ label, items, onSelect }: { label: string; items: Array<{ id: string; label: string; destructive?: boolean }>; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-anchor keybinding-row-menu">
      <button type="button" className="tau-icon-button" aria-label={`More for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreHorizontal size={14} />
      </button>
      {open ? <Menu align="right" label={`More for ${label}`} items={items} onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

interface CommandEntry {
  id: string;
  label: string;
  /** Where it comes from and where it applies, for the name's tooltip. */
  detail: string;
  bindings: ResolvedKeybinding[];
  card: KeybindingCard;
  rank: number;
  named: boolean;
  inert?: boolean;
}

/** One command: its name, each chord as keycaps, and the pen that records a new one. */
function CommandRow({ entry, context, commandLabel }: { entry: CommandEntry; context: EditorContext | undefined; commandLabel(id: string): string }) {
  const editable = entry.bindings.filter((binding) => keybindingSource(binding) !== "config");
  const custom = context !== undefined && entry.bindings.some((binding) => keybindingSource(binding, context.keymap.extensionId) === "custom");
  const name = (
    <span className="keybinding-label" {...tooltipProps(entry.detail)}>
      {entry.label}
      {custom ? <Badge>Custom</Badge> : null}
      {entry.inert ? <Badge tone="warn">Not implemented</Badge> : null}
      {entry.bindings.length > editable.length ? <Badge>config.json</Badge> : null}
    </span>
  );
  const chords = (bindings: readonly ResolvedKeybinding[]) => bindings.map((binding) => <Keycaps key={`${binding.keys}|${binding.when ?? ""}`} keys={binding.keys} mac={context?.mac ?? isMacPlatform()} />);
  if (!context || entry.inert || entry.id === "thread.jump") {
    return <div className="keybinding-row">{name}{entry.id === "thread.jump" ? <Keycaps keys={entry.bindings[0]?.keys ?? ""} mac={context?.mac ?? isMacPlatform()} last="1–9" /> : chords(entry.bindings)}</div>;
  }
  return <EditableCommandRow entry={entry} name={name} context={context} editable={editable} custom={custom} commandLabel={commandLabel} />;
}

function EditableCommandRow({ entry, name, context, editable, custom, commandLabel }: {
  entry: CommandEntry;
  name: ReactNode;
  context: EditorContext;
  editable: ResolvedKeybinding[];
  custom: boolean;
  commandLabel(id: string): string;
}) {
  const editor = useChordDraft(context, entry.id);
  const { draft } = editor;
  const { mac } = context;
  const recorder = <ChordRecorder label={`Press the new chord for ${entry.label}`} mac={mac} onRecord={editor.recorded} onStop={editor.stopRecording} />;
  const items = [
    ...(editable[0] ? [{ id: "when", label: "Change where it applies" }] : []),
    { id: "add", label: "Add another chord" },
    ...(custom ? [{ id: "reset", label: "Reset to default" }] : []),
    ...(editable.length > 1 ? editable.map((binding, index) => ({ id: `remove:${index}`, label: `Remove ${chordLabel(binding.keys, mac)}`, destructive: true })) : []),
  ];
  return (
    <div className="keybinding-row-group" data-editing={draft ? "" : undefined}>
      <div className="keybinding-row">
        {name}
        {entry.bindings.map((binding) => {
          const key = `${binding.keys}|${binding.when ?? ""}`;
          if (!editable.includes(binding)) return <Keycaps key={key} keys={binding.keys} mac={mac} />;
          if (draft?.target === binding && draft.recording) return <span key={key}>{recorder}</span>;
          const shown = draft?.target === binding && draft.key ? draft.key : binding.keys;
          return (
            <button key={key} type="button" className="keybinding-chord" data-drafted={shown !== binding.keys ? "" : undefined} aria-label={`Change the chord for ${entry.label}: ${chordLabel(shown, mac)}`} onClick={() => editor.record(binding)}>
              <Keycaps keys={shown} mac={mac} />
            </button>
          );
        })}
        {draft && !draft.target ? (draft.recording ? recorder : <span className="keybinding-chord" data-drafted=""><Keycaps keys={draft.key!} mac={mac} /></span>) : null}
        {entry.bindings.length === 0 && !draft ? <span className="settings-row-empty">Unbound</span> : null}
        <RowMenu label={entry.label} items={items} onSelect={(id) => {
          if (id === "when") editor.editWhen(editable[0]!);
          else if (id === "add") editor.record();
          else if (id === "reset") void editor.reset();
          else if (id.startsWith("remove:")) void editor.remove(editable[Number(id.slice(7))]!);
        }} />
        <button type="button" className="tau-icon-button keybinding-pen" aria-label={`Change ${entry.label}`} {...tooltipProps("Change")} onClick={() => editor.record(editable[0])}>
          <Pencil size={13} />
        </button>
      </div>
      <DraftPanel context={context} commandId={entry.id} label={entry.label} editor={editor} commandLabel={commandLabel} />
    </div>
  );
}

/** The composer's own keys: they follow Send with on General, which the pen opens. */
function ComposerKeys({ registry, mac, onOpen }: { registry: ExtensionRegistry; mac: boolean; onOpen?(target: string): void }) {
  const preferences = usePreferences();
  const { sendShortcut } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const modSends = sendShortcut === "mod-enter";
  const send = modSends ? "mod+enter" : "enter";
  const other = modSends ? "mod+shift+enter" : "mod+enter";
  const steers = registry.streamingDelivery() === "steer";
  const rows: Array<[string, string]> = [
    ["Send", send],
    ["Steer while running", steers ? send : other],
    ["Queue a follow-up", steers ? other : send],
    ["New line", modSends ? "enter" : "shift+enter"],
  ];
  return <>{rows.map(([label, keys]) => (
    <div className="keybinding-row" key={label}>
      <span className="keybinding-label">{label}</span>
      <Keycaps keys={keys} mac={mac} />
      {onOpen ? <button type="button" className="tau-icon-button keybinding-pen" aria-label={`Change ${label}: Send with, on General`} {...tooltipProps("Send with, on General")} onClick={() => onOpen("general#setting-send-with")}><Pencil size={13} /></button> : null}
    </div>
  ))}</>;
}

/**
 * Settings → Keybindings (design 2g): the live chords in cards by the layer
 * they work in, each key a keycap of its own and a pen that records a new
 * chord; conflicts show as soon as one is pressed. Below, chords that lost to
 * another, and on request every command with the Pi actions Tau does not
 * implement. Without a user keymap (`registerUserKeymap`) the page only lists.
 */
export function KeybindingsPage({ registry, initialFilter = "", onNotify = () => {}, onOpen }: { registry: ExtensionRegistry; initialFilter?: string; onNotify?(message: string): void; onOpen?(target: string): void }) {
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
  const matches = (...texts: Array<string | undefined>) => !query || texts.some((text) => text?.toLowerCase().includes(query));
  const pressed = (binding: { keys: string }) => !keyFilter || pressesKeys(binding, keyFilter, mac);
  // A keybindings.json names a Pi action by its own id; without a Tau command its chord does nothing.
  const unimplemented = keybindings.filter((binding) => !commands.some((command) => command.id === binding.commandId));
  const entries: CommandEntry[] = [];
  for (const command of commands) {
    const chords = keybindings.filter((binding) => binding.commandId === command.id);
    // ⌘1–⌘9 are one row: one thread each.
    const jump = /^thread\.jump-\d$/u.test(command.id);
    const id = jump ? "thread.jump" : command.id;
    const existing = entries.find((entry) => entry.id === id);
    if (existing) { existing.bindings.push(...chords); continue; }
    const where = [...new Set(chords.map((binding) => binding.when).filter(Boolean))];
    entries.push({
      id,
      label: jump ? "Open thread 1–9 of the rail" : command.label,
      detail: `${id} · ${chords[0]?.extensionName.toLowerCase() ?? command.group}${where.length ? ` · when ${where.join(", ")}` : ""}`,
      bindings: chords,
      ...keybindingPlace(id, command.group),
    });
  }
  // Pi actions keybindings.json binds that Tau has no command for: listed with every command, never bound.
  for (const binding of unimplemented) entries.push({ id: binding.commandId, label: binding.commandId, detail: binding.extensionName, bindings: [binding], card: "app", rank: 99, named: false, inert: true });
  const shown = (entry: CommandEntry) => (!keyFilter || entry.bindings.some(pressed)) && matches(entry.label, entry.id, entry.detail, ...entry.bindings.map((binding) => chordLabel(binding.keys, mac)));
  // A row the design names stays in its card unbound, so it can be given a chord there.
  const bound = entries.filter((entry) => !entry.inert && (entry.bindings.length > 0 || entry.named) && shown(entry)).sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label));
  const composerKeys = !query && !keyFilter || matches("send steer queue follow-up new line return enter");
  // Pi actions Tau has no command for stay Pi's, so they do not call for Reset all.
  const custom = keybindings.some((binding) => commands.some((command) => command.id === binding.commandId) && keybindingSource(binding, keymap?.extensionId) === "custom");
  const filtering = Boolean(query || keyFilter);
  const noMatch = keyFilter ? `No keybinding presses ${chordLabel(keyFilter, mac)}` : `No shortcut matches “${filter.trim()}”`;

  const resetAll = async () => {
    setConfirmReset(false);
    try {
      await keymap?.resetAll();
    } catch (error) {
      onNotify(`Could not write ${keymap?.label}: ${errorMessage(error)}`);
    }
  };
  const clearFilter = () => { setFilter(""); setKeyFilter(undefined); };
  const row = (entry: CommandEntry) => <CommandRow key={entry.id} entry={entry} context={context} commandLabel={commandLabel} />;

  return (
    <div className="settings-page keybindings-page">
      <SettingsPageAction>
        <label className="keybinding-find">
          <Search size={13} aria-hidden />
          {searchingKeys ? (
            <ChordRecorder label="Press the keys to search for" placeholder="Press the keys…" mac={mac} onRecord={(keys) => { setKeyFilter(keys); setFilter(""); setSearchingKeys(false); }} onStop={() => setSearchingKeys(false)} />
          ) : keyFilter ? (
            <span className="keybinding-key-filter">
              <Keycaps keys={keyFilter} mac={mac} />
              <button type="button" className="tau-icon-button" aria-label="Clear the key search" onClick={() => setKeyFilter(undefined)}><X size={12} /></button>
            </span>
          ) : (
            <input
              type="search"
              placeholder="Find a shortcut"
              aria-label="Find a shortcut"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }}
            />
          )}
          <button type="button" className="tau-icon-button" aria-label="Search by keys" aria-pressed={searchingKeys} {...tooltipProps("Search by pressing the keys")} onClick={() => setSearchingKeys(!searchingKeys)}>
            <Keyboard size={13} />
          </button>
        </label>
      </SettingsPageAction>

      <div className="settings-cards">
        {KEYBINDING_CARDS.map((id) => {
          const rows = bound.filter((entry) => entry.card === id);
          const composer = id === "conversation" && composerKeys;
          return rows.length || composer ? (
            <SettingsCard key={id} title={id[0]!.toUpperCase() + id.slice(1)}>
              {composer ? <ComposerKeys registry={registry} mac={mac} {...(onOpen ? { onOpen } : {})} /> : null}
              {rows.map(row)}
            </SettingsCard>
          ) : null;
        })}
        {bound.length === 0 && filtering ? (
          <SettingsState kind="empty" title={noMatch} description="Search by a command's name, its id or its keys." action={<Button onClick={clearFilter}>Clear the search</Button>} />
        ) : null}
        {showAllCommands ? (
          <SettingsCard title="Every command" wide>
            {entries.filter(shown).sort((left, right) => left.label.localeCompare(right.label)).map(row)}
          </SettingsCard>
        ) : null}
      </div>

      {conflicts.length > 0 ? (
        <SettingsSection title={`Ignored chords (${conflicts.length})`}>
          {conflicts.map((conflict) => (
            <div className="keybinding-row" key={`${conflict.keys}:${conflict.commandId}`} data-level="ignored">
              <span className="keybinding-label" {...tooltipProps(`${conflict.extensionId} · ${conflict.boundTo.extensionId} bound it to ${conflict.boundTo.commandId} first`)}>
                {commandLabel(conflict.commandId)} <Badge tone="warn">Ignored</Badge>
              </span>
              <Keycaps keys={conflict.keys} mac={mac} />
            </div>
          ))}
        </SettingsSection>
      ) : null}

      <p className="settings-footnote keybinding-foot">
        {keymap ? <>A change is written to <code>{keymap.label}</code> and applies at once.</> : <>Rebind any command id or Pi action in <code>~/.pi/agent/keybindings.json</code>.</>}
        <Button variant="ghost" aria-pressed={showAllCommands} onClick={() => setShowAllCommands((value) => !value)}>Every command</Button>
        {keymap && custom ? <Button variant="ghost" onClick={() => setConfirmReset(true)}>Reset all</Button> : null}
      </p>

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
