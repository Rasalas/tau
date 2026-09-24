import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";
import type { UiEnvironments } from "../shared/environments";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createPlatformEnvironments } from "./environments";

const list = (shown: string): UiEnvironments => ({ shown, environments: [], secureStorage: true });

describe("the machines a page reads", () => {
  it("asks the window once, then follows its events", async () => {
    const listEnvironments = vi.fn(async () => list("laptop"));
    const client = createFakeHostClient({ listEnvironments });
    const environments = createPlatformEnvironments(client);
    const heard = vi.fn();
    environments.subscribe(heard);
    await vi.waitFor(() => expect(environments.getSnapshot()?.shown).toBe("laptop"));
    client.emit({ type: "environments", environments: list("studio") } as HostEvent);
    expect(environments.getSnapshot()?.shown).toBe("studio");
    expect(heard).toHaveBeenCalledTimes(2);
    expect(listEnvironments).toHaveBeenCalledTimes(1);
  });

  it("stays empty where the window keeps no list", async () => {
    const environments = createPlatformEnvironments(createFakeHostClient());
    environments.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(environments.getSnapshot()).toBeUndefined();
  });
});
