import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { defaultHostConfigManager } from "./host-config.js";
import type { HostExtension } from "./host-extensions.js";
import { PiHost } from "./pi-host.js";

describe("the host's list of extensions turned off", () => {
  it("keeps a disabled kit's host half stopped at start, tells every client about a write, and starts the half when the list lets it go", async () => {
    const events: HostEvent[] = [];
    const starts = vi.fn();
    const kit: HostExtension = { id: "test.choice", name: "Choice", activate: () => { starts(); } };
    await defaultHostConfigManager.update({ disabledExtensions: ["test.choice"] }, "global");
    const host = new PiHost("/repo", (event) => events.push(event), {} as never, false, false, { hostExtensions: [kit] });
    await (host as unknown as { activateHostExtensions(): Promise<void> }).activateHostExtensions();
    expect(starts).not.toHaveBeenCalled();
    expect(host.listHostExtensions()).toEqual([expect.objectContaining({ id: "test.choice", active: false })]);

    await defaultHostConfigManager.update({ disabledExtensions: [] }, "global");
    const file = defaultHostConfigManager.filePath("global");
    host.configWritten([file]);
    expect(events).toContainEqual({ type: "config-changed", kind: "config", paths: [file] });
    await vi.waitFor(() => expect(host.listHostExtensions()).toEqual([expect.objectContaining({ id: "test.choice", active: true })]));
    expect(starts).toHaveBeenCalledTimes(1);
  });
});
