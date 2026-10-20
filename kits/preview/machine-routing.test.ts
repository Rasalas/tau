import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPreviewHostExtension } from "./host.js";
import { EMPTY_PREVIEW_STATE, PREVIEW_HOST_EXTENSION_ID } from "./protocol.js";

describe("Preview on a thread's home machine", () => {
  it("routes to the active machine and presents its browser as frames", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-preview-routing-"));
    const registry = await activateHostKit(createPreviewHostExtension(async () => undefined), {
      stateDir,
      registerTurnObserver: () => () => undefined,
      findCommand: () => undefined,
    });
    try {
      const routing = registry.machineRoutingFor(PREVIEW_HOST_EXTENSION_ID);
      expect(routing).toBeDefined();
      const adapter = routing!.policy.create!({ activeMachine: () => "rex" } as never);
      expect(adapter.route?.({ url: "http://127.0.0.1:4179/?variant=A" })).toBe("rex");
      expect(await adapter.remoteResult?.("rex", "open", {}, { ...EMPTY_PREVIEW_STATE, surface: "window", url: "http://127.0.0.1:4179/?variant=A" })).toMatchObject({ surface: "headless", url: "http://127.0.0.1:4179/?variant=A" });
      adapter.dispose?.();
    } finally { await registry.dispose(); await rm(stateDir, { recursive: true, force: true }); }
  });
});
