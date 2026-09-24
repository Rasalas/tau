// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../src/main/test-support/host-kit-harness.js";
import { createKitHarness, setHostClient } from "../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../src/renderer/test-support/fake-host-client.js";
import access from "./access/desktop.js";
import { createAccessHostExtension } from "./access/host.js";
import preview from "./preview/desktop.js";
import { createPreviewHostExtension } from "./preview/host.js";
import snapshots from "./snapshots/desktop.js";
import { createSnapShotsHostExtension } from "./snapshots/host.js";
import { DEFAULT_SHORTCUT } from "./snapshots/protocol.js";

const directories: string[] = [];
afterEach(async () => {
  setHostClient(undefined);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The host's config, as the kits' host halves and a client's sync read it. */
const HOST_SETTINGS: Record<string, { options: Record<string, boolean>; values: Record<string, string> }> = {
  "tau.access": { options: {}, values: { level: "read-only" } },
  "tau.preview": { options: { "recording-keys": true }, values: { "default-zoom": "2" } },
  "tau.snapshots": { options: { "shortcut-enabled": true }, values: {} },
};

describe("a fresh device joins a host whose settings differ from the defaults", () => {
  it("leaves the host's values alone, before its preferences arrive and after", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-fresh-device-"));
    directories.push(stateDir);
    const shortcuts: unknown[] = [];
    const published: string[] = [];
    const registry = await activateHostKit(createAccessHostExtension(), {
      stateDir,
      log: () => undefined,
      settings: (async (id: string) => HOST_SETTINGS[id] ?? { options: {}, values: {} }) as never,
      registerRuntimeExtension: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      setPermissionLevel: () => undefined,
      callClient: (async (_id: string, command: string, input: unknown) => { if (command === "shortcut") shortcuts.push(input); return {}; }) as never,
    }, (event) => published.push(`${event.extensionId}/${event.name}`));
    await registry.activate(createPreviewHostExtension(async () => undefined));
    await registry.activate(createSnapShotsHostExtension());

    const hostClient = createFakeHostClient({
      getConfig: async () => ({
        values: { "tau.access.level": "read-only", "tau.preview.default-zoom": "2" },
        options: { "tau.preview.recording-keys": true, "tau.snapshots.shortcut-enabled": true },
      }),
    });
    setHostClient(hostClient);
    const sent: string[] = [];
    const { registry: client, preferences } = createKitHarness(async (id, command, input) => {
      sent.push(`${id}/${command}`);
      return registry.invoke(id, command, input);
    });
    for (const kit of [access, preview, snapshots]) client.activate(kit);
    await settle();
    preferences.bindHost(hostClient);
    await vi.waitFor(() => expect(preferences.value("tau.access", "level")).toBe("read-only"));
    await settle();

    // Not even for a moment: the gate never left the host's level.
    expect(published).not.toContain("tau.access/level");
    await expect(registry.invoke("tau.access", "level")).resolves.toBe("read-only");
    await expect(registry.invoke("tau.preview", "current-defaults")).resolves.toMatchObject({ zoom: 2, recording: { showKeys: true } });
    // The window is armed with the host's shortcut, not this client's "off".
    expect(shortcuts).toEqual([{ accelerator: DEFAULT_SHORTCUT, accessibility: true }]);
    expect(sent).not.toContain("tau.access/set-level");
    expect(sent).not.toContain("tau.preview/defaults");
    expect(hostClient.calls.filter((call) => call.method === "updateConfig" || call.method === "clearConfig")).toEqual([]);
  });
});
