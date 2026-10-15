import { chordMatchesEvent, formatKeyChord, isMacPlatform, isModified, normalizeKeyChord, parseKeyChord, platformChordId, type KeyChord } from "./keybindings";
import { clientClause, DESKTOP_CONTEXT, evaluateWhen, isSpecificWhen, parseWhen, whenOverlaps, type WhenNode } from "./keybinding-when";
import type { ClientProfile } from "../workbench/client-profile";
import type { ContributionOwner } from "./extension-system";

export interface KeybindingContribution {
  keys: string;
  commandId: string;
  /**
   * Where the chord applies, e.g. `"terminalFocus && !stageFocus"`: context
   * names joined by `!`, `&&`, `||` and parentheses. `<name>Focus` holds while
   * the keyboard is inside an element marked `data-keybinding-context="<name>"`,
   * `<name>Open` while one is drawn. A clause that needs a context is the more
   * specific binding: it wins over one that does not, and runs before the
   * focused element sees the key. Without `when` the chord applies everywhere.
   */
  when?: string;
  /**
   * A command whose other chords this binding takes the place of, rather than
   * joining. The user who rebound an action in `keybindings.json` means *that*
   * key, not that one and Tau's default too; a kit passes the command id here
   * and core hides the default while the binding lives (Keybindings Kit is the
   * caller). Usually the same id as `commandId`. Naming another registered
   * command makes that one a stand-in the palette and the keymap no longer
   * list (it still runs by id): Workspace Kit's "Settle thread" gives way to
   * Thread Rail's (API 1.61.0).
   */
  replaces?: string;
}

export interface KeybindingConflict {
  keys: string;
  commandId: string;
  extensionId: string;
  /** The binding that holds the chord. */
  boundTo: { commandId: string; extensionId: string };
}

/**
 * A chord the user set for a command. Without `when` it keeps the clause of
 * the default it replaces; `"true"` makes it apply everywhere. New in API 1.12.0.
 */
export interface UserKeybinding {
  key: string;
  when?: string;
}

/**
 * The file Settings → Keybindings writes the chords the user records to. Its
 * owner binds what the file holds with `registerKeybinding` and `replaces`, as
 * before; the page only hands over a command's new chords. One at a time, the
 * last registered wins. New in API 1.12.0.
 */
export interface UserKeymapContribution {
  id: string;
  /** The file as the page names it, e.g. `~/.pi/agent/keybindings.json`. */
  label: string;
  /** Replaces a command's chords; `undefined` gives it its defaults back. Resolves once written. */
  setChords(commandId: string, chords: readonly UserKeybinding[] | undefined): Promise<void>;
  /** Gives every command its defaults back. */
  resetAll(): Promise<void>;
}

/** The owner of the chords config.json's `keybindings` sets. */
export const USER_CONFIG_KEYBINDINGS = "user-config";

/** A live binding a chord the user records would share its keys with. */
export interface KeybindingCollision {
  binding: ResolvedKeybinding;
  /** Where both clauses hold: the new chord `wins` the key, `loses` it, or they rank the same (`clash`) and one of them is dropped. */
  outcome: "wins" | "loses" | "clash";
}

export interface ResolvedKeybinding extends KeybindingContribution, ContributionOwner {
  /** Platform spelling for display, e.g. ⌘K. */
  label: string;
  chord: KeyChord;
}

/** One registration, in the order bindings are weighed. */
interface KeybindingEntry {
  binding: ResolvedKeybinding;
  ast: WhenNode | undefined;
  /** 0 a default, 1 a binding that `replaces` a command's chords, 2 an override from config.json. */
  tier: 0 | 1 | 2;
  seq: number;
}

/** An entry as it stands now: its effective clause, and whether that clause needs a context. */
interface LiveKeybinding extends KeybindingEntry {
  effective: ResolvedKeybinding;
  whenAst: WhenNode | undefined;
  specific: boolean;
}

interface KeybindingState {
  version: number;
  mac: boolean;
  live: LiveKeybinding[];
  conflicts: KeybindingConflict[];
  bindings?: ResolvedKeybinding[];
}

/** Owns keybinding registration, precedence, context matching and configuration overrides. */
export class ExtensionKeybindings {
  private readonly clientWhen: WhenNode;
  private keybindingEntries: KeybindingEntry[] = [];
  private keybindingSeq = 0;
  private keybindingsVersion = 0;
  private keybindingState: KeybindingState | undefined;
  private readonly shadowedCommands = new Map<string, number>();
  private overrideDisposers: Array<() => void> = [];

  constructor(private readonly profile: ClientProfile, private readonly changed: () => void) {
    this.clientWhen = clientClause(profile === "desktop");
  }

  /** Undefined means this binding belongs to another client profile. */
  register(binding: KeybindingContribution, owner: ContributionOwner): (() => void) | undefined {
    const chord = parseKeyChord(binding.keys);
    const id = normalizeKeyChord(binding.keys);
    if (!chord || !id) throw new Error(`Keybinding "${binding.keys}" from ${owner.extensionId} is not a key chord`);
    const when = binding.when?.trim() || undefined;
    const ast = when ? parseWhen(when) : undefined;
    if (when && !ast) throw new Error(`Keybinding "${binding.keys}" from ${owner.extensionId} has a when clause Tau cannot read: ${when}`);
    // A chord for the other kind of client (`isDesktop` here, `!isDesktop` in a browser) is not bound, so hints and the keymap list only what works.
    if (ast && !whenOverlaps(ast, this.clientWhen)) return undefined;
    const { when: _when, ...rest } = binding;
    const resolved: ResolvedKeybinding = { ...rest, ...(when ? { when } : {}), keys: id, chord, label: formatKeyChord(chord), ...owner };
    const dropShadow = binding.replaces ? this.shadowCommand(binding.replaces) : undefined;
    const entry = this.addKeybinding(resolved, ast, binding.replaces ? 1 : 0);
    const conflict = this.resolveKeybindings().conflicts.find((candidate) => candidate.commandId === binding.commandId && candidate.keys === id && candidate.extensionId === owner.extensionId);
    if (conflict) console.warn(`Keybinding ${id} from ${owner.extensionId} (${binding.commandId}) is already bound to ${conflict.boundTo.commandId} by ${conflict.boundTo.extensionId}; keeping the first.`);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.removeKeybinding(entry);
      dropShadow?.();
    };
    return dispose;
  }

  /** Commands replaced by another registered command are omitted from command lists. */
  standIns(hasCommand: (id: string) => boolean): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const { binding } of this.keybindingEntries) {
      if (binding.replaces && binding.replaces !== binding.commandId && hasCommand(binding.commandId)) hidden.add(binding.replaces);
    }
    return hidden;
  }

  /** Counts one shadow of a command's default chords; the returned function drops it again. */
  private shadowCommand(commandId: string): () => void {
    this.shadowedCommands.set(commandId, (this.shadowedCommands.get(commandId) ?? 0) + 1);
    this.keybindingsVersion += 1;
    this.changed();
    let dropped = false;
    return () => {
      if (dropped) return;
      dropped = true;
      const left = (this.shadowedCommands.get(commandId) ?? 1) - 1;
      if (left > 0) this.shadowedCommands.set(commandId, left);
      else this.shadowedCommands.delete(commandId);
      this.keybindingsVersion += 1;
      this.changed();
    };
  }

  /** A default chord of a command someone replaced: still registered, no longer live. */
  private isShadowed(binding: ResolvedKeybinding): boolean {
    return !binding.replaces && this.shadowedCommands.has(binding.commandId);
  }

  /** Applies user keymap overrides from config.json, replacing default chords. */
  applyKeybindingOverrides(overrides?: Record<string, string>): void {
    this.overrideDisposers.forEach((dispose) => dispose());
    this.overrideDisposers = [];
    if (!overrides) return;
    const owner: ContributionOwner = { extensionId: USER_CONFIG_KEYBINDINGS, extensionName: "User Config" };
    for (const [commandId, rawKeys] of Object.entries(overrides)) {
      if (!rawKeys || typeof rawKeys !== "string") continue;
      const chord = parseKeyChord(rawKeys);
      const id = normalizeKeyChord(rawKeys);
      if (!chord || !id) {
        console.warn(`User keybinding override ${commandId} = ${rawKeys} is not a key chord`);
        continue;
      }
      const dropShadow = this.shadowCommand(commandId);
      const entry = this.addKeybinding({ keys: id, commandId, replaces: commandId, chord, label: formatKeyChord(chord), ...owner }, undefined, 2);
      this.overrideDisposers.push(() => { this.removeKeybinding(entry); dropShadow(); });
    }
    this.changed();
  }

  private addKeybinding(binding: ResolvedKeybinding, ast: WhenNode | undefined, tier: KeybindingEntry["tier"]): KeybindingEntry {
    const entry: KeybindingEntry = { binding, ast, tier, seq: this.keybindingSeq++ };
    this.keybindingEntries.push(entry);
    this.keybindingsVersion += 1;
    this.changed();
    return entry;
  }

  private removeKeybinding(entry: KeybindingEntry): void {
    const index = this.keybindingEntries.indexOf(entry);
    if (index < 0) return;
    this.keybindingEntries.splice(index, 1);
    this.keybindingsVersion += 1;
    this.changed();
  }

  /**
   * Which bindings are live and which lost their chord. A replaced default is
   * not live. A binding that replaces a command without a `when` of its own
   * takes the clause of that command's first default, so a rebound key keeps
   * its context. Two live bindings collide when they press the same keys on this
   * platform (`mod+p` is `ctrl+p` off macOS), share a tier and
   * specificity, run different commands and their clauses can hold together;
   * the earlier one keeps the chord.
   */
  private resolveKeybindings(mac = isMacPlatform()): KeybindingState {
    if (this.keybindingState?.version === this.keybindingsVersion && this.keybindingState.mac === mac) return this.keybindingState;
    const defaults = new Map<string, KeybindingEntry>();
    for (const entry of this.keybindingEntries) {
      if (entry.tier === 0 && !defaults.has(entry.binding.commandId)) defaults.set(entry.binding.commandId, entry);
    }
    const ordered = this.keybindingEntries
      .filter((entry) => !this.isShadowed(entry.binding))
      .sort((a, b) => b.tier - a.tier || a.seq - b.seq);
    const live: LiveKeybinding[] = [];
    const chords = new Map<string, LiveKeybinding[]>();
    const conflicts: KeybindingConflict[] = [];
    for (const entry of ordered) {
      const inherited = !entry.binding.when && entry.binding.replaces ? defaults.get(entry.binding.replaces) : undefined;
      const whenAst = entry.ast ?? inherited?.ast;
      const effective = inherited?.binding.when ? { ...entry.binding, when: inherited.binding.when } : entry.binding;
      const candidate: LiveKeybinding = { ...entry, effective, whenAst, specific: isSpecificWhen(whenAst, this.profile === "desktop") };
      const chord = platformChordId(entry.binding.chord, mac);
      const holders = chords.get(chord) ?? [];
      const holder = holders.find((other) => other.tier === entry.tier
        && other.specific === candidate.specific
        && other.binding.commandId !== entry.binding.commandId
        && whenOverlaps(other.whenAst, whenAst));
      if (holder) {
        conflicts.push({ keys: entry.binding.keys, commandId: entry.binding.commandId, extensionId: entry.binding.extensionId, boundTo: { commandId: holder.binding.commandId, extensionId: holder.binding.extensionId } });
        continue;
      }
      live.push(candidate);
      holders.push(candidate);
      chords.set(chord, holders);
    }
    live.sort((a, b) => a.seq - b.seq);
    this.keybindingState = { version: this.keybindingsVersion, mac, live, conflicts };
    return this.keybindingState;
  }

  /** The chords that are live: a replaced default or a binding that lost its chord is not one of them. */
  getKeybindings(): ResolvedKeybinding[] {
    const state = this.resolveKeybindings();
    return state.bindings ??= state.live.map((entry) => entry.effective);
  }

  /** Chords that lost to an earlier binding; `mac` asks about the other platform, where `mod` is another key. */
  getKeybindingConflicts(mac?: boolean): readonly KeybindingConflict[] {
    return this.resolveKeybindings(mac).conflicts;
  }

  /** A command's default chords, live or replaced, in the order they were registered. */
  getDefaultKeybindings(commandId: string): ResolvedKeybinding[] {
    return this.keybindingEntries.filter((entry) => entry.tier === 0 && entry.binding.commandId === commandId).map((entry) => entry.binding);
  }

  /**
   * The live bindings of other commands a chord the user sets for `commandId`
   * would press the same keys as on this platform (or `mac`), where both
   * clauses can hold. The chord ranks as a replacing binding and, without a
   * `when`, takes the clause of the command's first default.
   */
  findKeybindingCollisions(candidate: UserKeybinding & { commandId: string }, mac = isMacPlatform()): KeybindingCollision[] {
    const chord = parseKeyChord(candidate.key);
    const when = candidate.when?.trim() || undefined;
    const ast = when ? parseWhen(when) : this.keybindingEntries.find((entry) => entry.tier === 0 && entry.binding.commandId === candidate.commandId)?.ast;
    if (!chord || (when && !ast)) return [];
    const specific = isSpecificWhen(ast, this.profile === "desktop");
    const keys = platformChordId(chord, mac);
    return this.resolveKeybindings(mac).live
      .filter((other) => other.binding.commandId !== candidate.commandId && platformChordId(other.binding.chord, mac) === keys && whenOverlaps(other.whenAst, ast))
      .map((other) => ({
        binding: other.effective,
        outcome: other.tier !== 1 ? (other.tier < 1 ? "wins" : "loses") : other.specific === specific ? "clash" : specific ? "wins" : "loses",
      }));
  }

  /** The display label of the chord bound to a command, if any. */
  keybindingLabel(commandId: string): string | undefined {
    for (const binding of this.getKeybindings()) if (binding.commandId === commandId) return binding.label;
    return undefined;
  }

  /**
   * The command a keydown event should run in `context` (read from the page by
   * default). Of the bindings whose chord and clause match, an override from
   * config.json beats a replacing binding beats a default; within that, a
   * clause that needs a context beats one that does not, then the first
   * registered. `modified` tells bare keys from chords with modifiers;
   * `specific` says the winner's clause needs a context, so it runs before
   * the focused element sees the key.
   */
  matchKeybinding(event: KeyboardEvent, page: (name: string) => boolean): { binding: ResolvedKeybinding; modified: boolean; specific: boolean } | undefined {
    const desktop = this.profile === "desktop";
    const context = (name: string) => name === DESKTOP_CONTEXT ? desktop : page(name);
    let best: LiveKeybinding | undefined;
    for (const entry of this.resolveKeybindings().live) {
      if (!chordMatchesEvent(entry.binding.chord, event)) continue;
      if (entry.whenAst && !evaluateWhen(entry.whenAst, context)) continue;
      if (!best || entry.tier > best.tier || (entry.tier === best.tier && entry.specific && !best.specific)) best = entry;
    }
    if (!best) return undefined;
    return { binding: best.effective, modified: isModified(best.binding.chord), specific: best.specific };
  }

}
