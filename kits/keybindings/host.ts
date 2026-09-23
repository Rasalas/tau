import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostExtension, HostExtensionContext, PiUserKeybindings } from "tau/host-extension";
import { KEYBINDINGS_HOST_EXTENSION_ID, type PiKeybindingsState, type PiShortcutsState, type UserKeybinding } from "./protocol.js";

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
    if (entries.length > 0 && entries.every((entry) => entry !== undefined)) bindings[action] = entries as Array<string | UserKeybinding>;
  }
  return bindings;
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
      context.registerCommand("pi-keybindings", async (): Promise<PiKeybindingsState> => ({ bindings: await readUserKeybindings(agentDir()) }));
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
