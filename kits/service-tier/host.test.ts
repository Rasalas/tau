import { describe, expect, it } from "vitest";
import type { HostThread } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createServiceTierHostExtension } from "./host.js";
import { SERVICE_TIER_HOST_EXTENSION_ID } from "./protocol.js";

async function harness(modelApi?: string) {
  const events: PublishedKitEvent[] = [];
  const runtimeExtensions: string[] = [];
  const registry = await activateHostKit(createServiceTierHostExtension(), {
    thread: () => ({ modelApi: () => modelApi }) as HostThread,
    registerRuntimeExtension: (name) => { runtimeExtensions.push(name); return () => undefined; },
  }, (event) => events.push(event));
  return { registry, events, runtimeExtensions };
}

describe("Service Tier host extension", () => {
  it("reports availability from the active model's API and publishes tier changes", async () => {
    const { registry, events, runtimeExtensions } = await harness("openai-responses");
    expect(runtimeExtensions).toEqual(["tau-service-tier"]);
    await expect(registry.invoke(SERVICE_TIER_HOST_EXTENSION_ID, "state")).resolves.toEqual({ tier: "standard", available: true });
    await expect(registry.invoke(SERVICE_TIER_HOST_EXTENSION_ID, "set-tier", { tier: "fast" })).resolves.toEqual({ tier: "fast", available: true });
    expect(events).toEqual([{ type: "extension-event", extensionId: SERVICE_TIER_HOST_EXTENSION_ID, name: "state", payload: { tier: "fast", available: true } }]);
    await expect(registry.invoke(SERVICE_TIER_HOST_EXTENSION_ID, "set-tier", { tier: "turbo" })).rejects.toThrow("Service tier must be standard or fast.");
  });

  it("is unavailable for APIs without a priority tier", async () => {
    const { registry } = await harness("anthropic-messages");
    await expect(registry.invoke(SERVICE_TIER_HOST_EXTENSION_ID, "state")).resolves.toEqual({ tier: "standard", available: false });
  });

  it("does not activate without the permissions its manifest declares", async () => {
    const registry = await activateHostKit({ ...createServiceTierHostExtension(), permissions: ["sessions"] });
    expect(registry.isActive(SERVICE_TIER_HOST_EXTENSION_ID)).toBe(false);
  });
});
