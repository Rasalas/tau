import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { HostExtension, HostExtensionContext, PiUserKeybindings } from "tau/host-extension";
import { KEYBINDINGS_HOST_EXTENSION_ID, PI_ACTION_COMMANDS, isPiAction, type PiKeybindingsState, type PiShortcutsState, type SetChordsInput, type UserKeybinding } from "./protocol.js";

/** The user's entries in Pi's keybindings.json; a missing or broken file counts as empty. */
export async function readPiUserKeybindings(agentDir: string): Promise<PiUserKeybindings> {
  let raw: string;
  try {
    raw = await readFile(join(agentDir, "keybindings.json"), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const bindings: PiUserKeybindings = {};
  for (const [action, keys] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof keys === "string") bindings[action] = keys;
    else if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) bindings[action] = keys as string[];
  }
  return bindings;
}

function userKeybinding(value: unknown): string | UserKeybinding | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const { key, when } = value as Record<string, unknown>;
  if (typeof key !== "string") return undefined;
  return typeof when === "string" ? { key, when } : { key };
}

/**
 * Every entry of keybindings.json as Tau reads it: Pi's strings, and objects
 * with a `when` clause, alone or in an array.
 */
export async function readUserKeybindings(agentDir: string): Promise<PiKeybindingsState["bindings"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(agentDir, "keybindings.json"), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const bindings: PiKeybindingsState["bindings"] = {};
  for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entries = (Array.isArray(value) ? value : [value]).map(userKeybinding);
    // `[]` stays: under a command id it means "Tau's defaults", beating a Pi action's key.
    if (entries.every((entry) => entry !== undefined)) bindings[action] = entries as Array<string | UserKeybinding>;
  }
  return bindings;
}

/**
 * Rewrites keybindings.json through `edit`, keeping every entry it does not
 * touch. The new file replaces the old one in a single rename, next to where a
 * symlink points, so a dotfiles checkout keeps the change. A file that is not
 * a JSON object is left alone.
 */
export async function editKeybindingsFile(agentDir: string, edit: (file: Record<string, unknown>) => void): Promise<void> {
  const link = join(agentDir, "keybindings.json");
  const path = await realpath(link).catch(() => link);
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let file: unknown = {};
  if (raw.trim()) {
    try {
      file = JSON.parse(raw);
    } catch {
      file = undefined;
    }
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`${path} is not a JSON object; fix it by hand before recording chords.`);
  edit(file as Record<string, unknown>);
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.keybindings.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

const written = (chord: UserKeybinding): string | UserKeybinding => (chord.when ? { key: chord.key, when: chord.when } : chord.key);

/** Whether the file names `commandId` through one of Pi's own actions. */
const piActionFor = (file: Record<string, unknown>, commandId: string) => Object.keys(file).some((key) => PI_ACTION_COMMANDS.get(key) === commandId);

/** A command's chords as the file holds them; `null` gives the command Tau's defaults. */
export function setChords(file: Record<string, unknown>, { commandId, chords }: SetChordsInput): void {
  if (chords?.length) file[commandId] = chords.length === 1 ? written(chords[0]!) : chords.map(written);
  // An empty list still outranks a Pi action that names the command, so the defaults come back.
  else if (piActionFor(file, commandId)) file[commandId] = [];
  else delete file[commandId];
}

/** Every command back to Tau's defaults; Pi's own actions keep their keys for Pi. */
export function resetChords(file: Record<string, unknown>): void {
  for (const key of Object.keys(file)) if (!isPiAction(key)) delete file[key];
  for (const key of Object.keys(file)) {
    const commandId = PI_ACTION_COMMANDS.get(key);
    if (commandId) file[commandId] = [];
  }
}

function setChordsInput(input: unknown): SetChordsInput {
  const { commandId, chords } = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof commandId !== "string" || !commandId) throw new Error('set-chords needs "commandId".');
  if (chords === null) return { commandId, chords: null };
  if (!Array.isArray(chords)) throw new Error('set-chords needs "chords": a list, or null for the defaults.');
  return {
    commandId,
    chords: chords.map((chord) => {
      const { key, when } = (chord && typeof chord === "object" ? chord : {}) as Record<string, unknown>;
      if (typeof key !== "string" || !key.trim()) throw new Error("set-chords: every chord needs a key.");
      if (when !== undefined && typeof when !== "string") throw new Error("set-chords: a when clause is a string.");
      return when?.trim() ? { key: key.trim(), when: when.trim() } : { key: key.trim() };
    }),
  };
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

const optionalString = (input: unknown, key: string): string | undefined => {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * Keybindings' host entry: Pi's keybindings.json and the shortcuts Pi
 * extensions registered, so the workbench can honour both.
 */
export function createKeybindingsHostExtension(): HostExtension {
  return {
    id: KEYBINDINGS_HOST_EXTENSION_ID,
    name: "Keybindings",
    activate(context: HostExtensionContext) {
      const agentDir = () => context.services.agentDir;
      // The host watches `keybindings.json` but re-reads nothing for this kit:
      // it says the file moved, and the commands below read it again.
      const stopWatching = context.services.observeConfigChanges((change) => {
        if (change.kind !== "keybindings") return;
        context.emit("changed", { paths: [...change.paths] });
      });
      context.registerCommand("pi-keybindings", async (): Promise<PiKeybindingsState> => ({
        bindings: await readUserKeybindings(agentDir()),
        path: displayPath(join(agentDir(), "keybindings.json")),
      }));
      // Said at once, so every window rebinds even where the watcher is off.
      const edited = () => context.emit("changed", { paths: [join(agentDir(), "keybindings.json")] });
      context.registerCommand("set-chords", async (input) => {
        const change = setChordsInput(input);
        await editKeybindingsFile(agentDir(), (file) => setChords(file, change));
        edited();
      });
      context.registerCommand("reset-chords", async () => {
        await editKeybindingsFile(agentDir(), resetChords);
        edited();
      });
      context.registerCommand("shortcuts", async (input): Promise<PiShortcutsState> => {
        const thread = context.services.thread(optionalString(input, "sessionId"));
        if (!thread) return { shortcuts: [] };
        return { sessionId: thread.sessionId, shortcuts: thread.shortcuts(await readPiUserKeybindings(agentDir())) };
      });
      context.registerCommand("run-shortcut", async (input) => {
        const keys = optionalString(input, "keys");
        if (!keys) throw new Error('Keybindings command needs "keys".');
        const thread = context.services.thread(optionalString(input, "sessionId"));
        if (!thread) throw new Error("No thread is open for this shortcut.");
        if (!await thread.runShortcut(keys, await readPiUserKeybindings(agentDir()))) throw new Error(`Pi has no shortcut for ${keys}.`);
      });
      return stopWatching;
    },
  };
}

export default createKeybindingsHostExtension;
