/**
 * What Settings → Keybindings needs to edit chords, apart from drawing them:
 * where a live binding comes from, the list a command's chords become after
 * an edit, the `when` clauses to suggest, and search by keys. Pure, so the
 * rules are tested without a page.
 */
import { USER_CONFIG_KEYBINDINGS, type ResolvedKeybinding, type UserKeybinding } from "../extension-system";
import { parseWhen } from "../keybinding-when";
import { parseKeyChord, platformChordId } from "../keybindings";

/** `custom` came from the user keymap, `config` from config.json's `keybindings`, which this page does not write. */
export type KeybindingSource = "default" | "custom" | "config";

/** `keymapOwner` is the extension behind the user keymap; a kit's own replacing chord is still a default. */
export function keybindingSource(binding: ResolvedKeybinding, keymapOwner?: string): KeybindingSource {
  if (binding.extensionId === USER_CONFIG_KEYBINDINGS) return "config";
  return binding.replaces && binding.extensionId === keymapOwner ? "custom" : "default";
}

const clause = (when: string | undefined) => {
  const text = when?.trim();
  return !text || text === "true" ? undefined : text;
};

/**
 * A chord as the keymap writes it: without `when` when it keeps the clause a
 * replacing chord inherits (`inherited`, the command's first default's), with
 * `"true"` when it applies everywhere although the default does not.
 */
export function userChord(key: string, when: string | undefined, inherited: string | undefined): UserKeybinding {
  const own = clause(when);
  if (own === clause(inherited)) return { key };
  return { key, when: own ?? "true" };
}

export interface ChordEdit {
  /** The live binding the edit replaces or removes; absent to add a chord. */
  target?: ResolvedKeybinding;
  /** The chord that takes its place; absent to remove the target. */
  next?: { key: string; when?: string };
}

/**
 * A command's chords after one edit, for `UserKeymapContribution.setChords`:
 * every live chord of the command, the target swapped for the next one.
 * `undefined` when nothing is left, which gives the command its defaults back.
 */
export function chordsAfterEdit(live: readonly ResolvedKeybinding[], commandId: string, inherited: string | undefined, edit: ChordEdit): UserKeybinding[] | undefined {
  const current = live.filter((binding) => binding.commandId === commandId && keybindingSource(binding) !== "config");
  const chords: UserKeybinding[] = [];
  for (const binding of current) {
    if (binding !== edit.target) chords.push(userChord(binding.keys, binding.when, inherited));
    else if (edit.next) chords.push(userChord(edit.next.key, edit.next.when, inherited));
  }
  if (!edit.target && edit.next) chords.push(userChord(edit.next.key, edit.next.when, inherited));
  const unique = chords.filter((chord, index) => chords.findIndex((other) => other.key === chord.key && other.when === chord.when) === index);
  return unique.length > 0 ? unique : undefined;
}

/** Whether a draft clause reads; an empty one means "everywhere". */
export function whenError(when: string): string | undefined {
  return !when.trim() || parseWhen(when) ? undefined : "Use context names with !, &&, || and parentheses.";
}

/** Core's own contexts, beside whatever the live bindings name. */
const CORE_CONTEXTS = ["composerFocus", "stageFocus", "modelPickerFocus", "modelPickerOpen", "editableFocus"];

/** Clauses to offer in the `when` field: every context name the bindings use, and its negation. */
export function whenSuggestions(live: readonly ResolvedKeybinding[]): string[] {
  const names = new Set(CORE_CONTEXTS);
  for (const binding of live) {
    for (const name of binding.when?.match(/[A-Za-z_][\w.-]*/gu) ?? []) if (name !== "true" && name !== "false") names.add(name);
  }
  return [...names].sort().flatMap((name) => [name, `!${name}`]);
}

/** Whether a binding presses the keys `keys` names, on this platform. */
export function pressesKeys(binding: { keys: string }, keys: string, mac: boolean): boolean {
  const wanted = parseKeyChord(keys);
  const chord = parseKeyChord(binding.keys);
  return Boolean(wanted && chord && platformChordId(chord, mac) === platformChordId(wanted, mac));
}
