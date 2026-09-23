import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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

    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "pi-keybindings")).resolves.toEqual({ bindings: { "app.session.new": ["ctrl+n"], "app.interrupt": ["escape", "ctrl+c"] }, path: join(agentDir, "keybindings.json") });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "shortcuts")).resolves.toEqual({ sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "pick (2 user bindings)", source: "persona.ts" }] });
    await registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+shift+p" });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "run-shortcut", { keys: "ctrl+x" })).rejects.toThrow("Pi has no shortcut for ctrl+x.");
    expect(ran).toEqual(["ctrl+shift+p", "ctrl+x"]);
    await expect(readPiUserKeybindings(join(agentDir, "missing"))).resolves.toEqual({});
  });

  it("reads entries with a when clause for Tau and keeps them from Pi", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-keys-"));
    await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({
      "terminal.split": { key: "mod+\\", when: "terminalFocus" },
      "runtime.new-session": ["ctrl+n", { key: "mod+t" }],
      "broken": [{ when: "x" }],
    }));
    const registry = await activateHostKit(createKeybindingsHostExtension(), { agentDir, thread: () => undefined });
    await expect(registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "pi-keybindings")).resolves.toMatchObject({ bindings: {
      "terminal.split": [{ key: "mod+\\", when: "terminalFocus" }],
      "runtime.new-session": ["ctrl+n", { key: "mod+t" }],
    } });
    // Pi reads strings only; an entry with an object in it is not Pi's.
    await expect(readPiUserKeybindings(agentDir)).resolves.toEqual({});
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

  describe("writing chords", () => {
    const setup = async (content?: unknown) => {
      const agentDir = await mkdtemp(join(tmpdir(), "tau-keys-"));
      if (content !== undefined) await writeFile(join(agentDir, "keybindings.json"), typeof content === "string" ? content : JSON.stringify(content));
      const published: PublishedKitEvent[] = [];
      const registry = await activateHostKit(createKeybindingsHostExtension(), { agentDir }, (event) => published.push(event));
      const read = async () => JSON.parse(await readFile(join(agentDir, "keybindings.json"), "utf8")) as unknown;
      const set = (input: unknown) => registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "set-chords", input);
      return { agentDir, registry, published, read, set };
    };

    it("sets a command's chords and keeps every other entry", async () => {
      const { agentDir, published, read, set } = await setup({ "app.exit": "ctrl+d", "terminal.split": "mod+e" });
      await set({ commandId: "runtime.new-session", chords: [{ key: "mod+t" }] });
      await set({ commandId: "terminal.split", chords: [{ key: "mod+\\" }, { key: "mod+shift+5", when: "terminalFocus" }] });
      expect(await read()).toEqual({
        "app.exit": "ctrl+d",
        "terminal.split": ["mod+\\", { key: "mod+shift+5", when: "terminalFocus" }],
        "runtime.new-session": "mod+t",
      });
      // No temp file stays behind, and every window hears of the change.
      expect(await readdir(agentDir)).toEqual(["keybindings.json"]);
      expect(published.map((event) => event.name)).toEqual(["changed", "changed"]);
    });

    it("creates the file, and gives a command its defaults back", async () => {
      const { read, set } = await setup();
      await set({ commandId: "review.toggle", chords: [{ key: "mod+g" }] });
      expect(await read()).toEqual({ "review.toggle": "mod+g" });
      await set({ commandId: "review.toggle", chords: null });
      expect(await read()).toEqual({});
    });

    it("keeps Pi's own key when Tau rebinds or resets the command it reaches", async () => {
      const { read, set } = await setup({ "app.session.new": "ctrl+n" });
      await set({ commandId: "runtime.new-session", chords: [{ key: "mod+t" }] });
      expect(await read()).toEqual({ "app.session.new": "ctrl+n", "runtime.new-session": "mod+t" });
      // An empty list, so Tau's defaults win over Pi's ctrl+n again.
      await set({ commandId: "runtime.new-session", chords: null });
      expect(await read()).toEqual({ "app.session.new": "ctrl+n", "runtime.new-session": [] });
    });

    it("resets every Tau entry and leaves Pi's actions to Pi", async () => {
      const { registry, read } = await setup({ "app.session.new": "ctrl+n", "app.exit": "ctrl+d", "review.toggle": "mod+g", "terminal.split": { key: "mod+e" } });
      await registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "reset-chords");
      expect(await read()).toEqual({ "app.session.new": "ctrl+n", "app.exit": "ctrl+d", "runtime.new-session": [] });
    });

    it("refuses to overwrite a file it cannot read, and bad input", async () => {
      const { agentDir, set } = await setup("{ not json");
      await expect(set({ commandId: "review.toggle", chords: [{ key: "mod+g" }] })).rejects.toThrow(/not a JSON object/u);
      expect(await readFile(join(agentDir, "keybindings.json"), "utf8")).toBe("{ not json");
      await expect(set({ chords: [] })).rejects.toThrow('"commandId"');
      await expect(set({ commandId: "x", chords: [{ when: "true" }] })).rejects.toThrow("needs a key");
    });

    it("writes where a symlink points and leaves the link in place", async () => {
      const dotfiles = await mkdtemp(join(tmpdir(), "tau-dotfiles-"));
      await writeFile(join(dotfiles, "keys.json"), JSON.stringify({ "app.exit": "ctrl+d" }));
      const agentDir = await mkdtemp(join(tmpdir(), "tau-keys-"));
      await mkdir(agentDir, { recursive: true });
      await symlink(join(dotfiles, "keys.json"), join(agentDir, "keybindings.json"));
      const registry = await activateHostKit(createKeybindingsHostExtension(), { agentDir });
      await registry.invoke(KEYBINDINGS_HOST_EXTENSION_ID, "set-chords", { commandId: "review.toggle", chords: [{ key: "mod+g" }] });
      expect((await lstat(join(agentDir, "keybindings.json"))).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(join(dotfiles, "keys.json"), "utf8"))).toEqual({ "app.exit": "ctrl+d", "review.toggle": "mod+g" });
      expect(await readdir(dotfiles)).toEqual(["keys.json"]);
    });
  });
});
