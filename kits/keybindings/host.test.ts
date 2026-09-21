import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createKeybindingsHostExtension, readPiUserKeybindings } from "./host.js";
import { KEYBINDINGS_HOST_EXTENSION_ID } from "./protocol.js";

describe("Keybindings host extension", () => {
  it("reads the user's keybindings.json and routes Pi shortcuts to the thread", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-keys-"));
    await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.session.new": "ctrl+n", "app.interrupt": ["escape", "ctrl+c"], "app.exit": 7 }));
    const ran: string[] = [];
    const thread = {
      sessionId: "s1",
      shortcuts: (bindings: Record<string, unknown>) => [{ keys: "ctrl+shift+p", description: `pick (${Object.keys(bindings).length} user bindings)`, source: "persona.ts" }],
      runShortcut: async (keys: string) => { ran.push(keys); return keys === "ctrl+shift+p"; },
    } as unknown as HostThread;
    const registry = await activateHostKit(createKeybindingsHostExtension(), { agentDir, thread: () => thread });

    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "pi-keybindings")).resolves.toEqual({ bindings: { "app.session.new": ["ctrl+n"], "app.interrupt": ["escape", "ctrl+c"] } });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "shortcuts")).resolves.toEqual({ sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "pick (2 user bindings)", source: "persona.ts" }] });
    await registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+shift+p" });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+x" })).rejects.toThrow("Pi has no shortcut for ctrl+x.");
    expect(ran).toEqual(["ctrl+shift+p", "ctrl+x"]);
    await expect(readPiUserKeybindings(join(agentDir, "missing"))).resolves.toEqual({});
  });

  it("answers with no shortcuts while no thread is open", async () => {
    const registry = await activateHostKit(createKeybindingsHostExtension(), { thread: () => undefined });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "shortcuts")).resolves.toEqual({ shortcuts: [] });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+x" })).rejects.toThrow("No thread is open for this shortcut.");
  });

  it("tells its desktop half when the host saw keybindings.json change, and nothing else", async () => {
    let notify: ((change: { kind: string; paths: readonly string[] }) => void) | undefined;
    const published: PublishedKitEvent[] = [];
    await activateHostKit(
      createKeybindingsHostExtension(),
      { observeConfigChanges: (listener) => { notify = listener; return () => { notify = undefined; }; } },
      (event) => published.push(event),
    );

    notify?.({ kind: "themes", paths: ["/home/.tau/themes/acid.css"] });
    expect(published).toEqual([]);

    notify?.({ kind: "keybindings", paths: ["/agent/keybindings.json"] });
    expect(published).toEqual([{
      type: "extension-event",
      extensionId: KEYBINDINGS_HOST_EXTENSION_ID,
      name: "changed",
      payload: { paths: ["/agent/keybindings.json"] },
    }]);
  });

  it("is denied the thread it did not ask for", async () => {
    const registry = await activateHostKit({ ...createKeybindingsHostExtension(), permissions: [] }, { thread: () => undefined });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "shortcuts")).rejects.toThrow(/lacks permission sessions/u);
  });
});
