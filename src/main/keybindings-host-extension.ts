import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { KEYBINDINGS_HOST_EXTENSION_ID, type PiKeybindingsState, type PiShortcutsState, type PiUserKeybindings } from "../shared/keybindings-protocol.js";
import type { HostExtension, HostExtensionContext } from "./host-extensions.js";

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

const optionalString = (input: unknown, key: string): string | undefined => {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * Host entry of the Runtime Controls extension: Pi's keybindings.json and the
 * shortcuts Pi extensions registered, so the workbench can honour both.
 */
export function createKeybindingsHostExtension(options: { agentDir?: string } = {}): HostExtension {
  return {
    id: KEYBINDINGS_HOST_EXTENSION_ID,
    name: "Runtime Controls",
    permissions: ["sessions"],
    activate(context: HostExtensionContext) {
      const agentDir = () => options.agentDir ?? getAgentDir();
      context.registerCommand("pi-keybindings", async (): Promise<PiKeybindingsState> => {
        const user = await readPiUserKeybindings(agentDir());
        const bindings: Record<string, string[]> = {};
        for (const [action, keys] of Object.entries(user)) {
          if (keys === undefined) continue;
          bindings[action] = Array.isArray(keys) ? keys : [keys];
        }
        return { bindings };
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
    },
  };
}
