import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";
import type { UiEnvironmentThreadView, UiEnvironments } from "../shared/environments";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createPlatformEnvironments, LOOK_IN_RENEW_MS } from "./environments";
import { lookInMachine } from "./look-in";

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

  it("goes back to the window's own machine, reading the list when it has none yet", async () => {
    const openEnvironment = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      listEnvironments: async () => ({ shown: "studio", secureStorage: true, environments: [
        { id: "studio", name: "studio", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
        { id: "laptop", name: "laptop", local: true, status: "connected", threads: [], threadCount: 0, projects: [] },
      ] }),
      openEnvironment,
    });
    const environments = createPlatformEnvironments(client, { shownElsewhere: "studio" });
    expect(environments.shownElsewhere).toBe("studio");
    await environments.showLocal();
    expect(openEnvironment).toHaveBeenCalledWith("laptop");
  });
});

describe("looking in on another machine's thread", () => {
  const view = (revision: number, machine = "host-rex"): UiEnvironmentThreadView => ({
    machine, sessionId: "t9", machineName: "rex", status: "connected", indexed: true, revision,
  });

  it("holds one watch for every reader of a thread, renews it, and ends it with the last one", async () => {
    vi.useFakeTimers();
    try {
      const watchEnvironmentThread = vi.fn(async (_machine: string, _session: string, on: boolean) => (on ? view(0) : undefined));
      const client = createFakeHostClient({ watchEnvironmentThread });
      const environments = createPlatformEnvironments(client);
      const tab = vi.fn();
      const label = vi.fn();
      // Named as a kit may name it; the window answers the id.
      const stopTab = environments.watchThread!("rex", "t9", tab);
      await vi.waitFor(() => expect(tab).toHaveBeenCalledWith(view(0)));
      const stopLabel = environments.watchThread!("rex", "t9", label);
      expect(label).toHaveBeenCalledWith(view(0));
      expect(watchEnvironmentThread).toHaveBeenCalledTimes(1);
      client.emit({ type: "environment-thread", view: view(3) } as HostEvent);
      client.emit({ type: "environment-thread", view: view(4, "host-other") } as HostEvent);
      expect(tab).toHaveBeenLastCalledWith(view(3));
      expect(label).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(LOOK_IN_RENEW_MS);
      expect(watchEnvironmentThread).toHaveBeenCalledTimes(2);
      stopTab();
      expect(watchEnvironmentThread).toHaveBeenCalledTimes(2);
      stopLabel();
      expect(watchEnvironmentThread).toHaveBeenLastCalledWith("rex", "t9", false);
      await vi.advanceTimersByTimeAsync(LOOK_IN_RENEW_MS * 2);
      expect(watchEnvironmentThread).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the machine by id, and none for the machine the page shows", () => {
    const machines: UiEnvironments = { shown: "host-mini", secureStorage: true, environments: [
      { id: "host-mini", name: "mini", local: true, status: "connected", threads: [], threadCount: 0, projects: [] },
      { id: "host-rex", name: "rex", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
    ] };
    const known = { getSnapshot: () => machines };
    expect(lookInMachine(undefined, known)).toBeUndefined();
    expect(lookInMachine("host-mini", known)).toBeUndefined();
    expect(lookInMachine("mini", known)).toBeUndefined();
    expect(lookInMachine("REX", known)).toBe("host-rex");
    expect(lookInMachine("host-rex", known)).toBe("host-rex");
    expect(lookInMachine("elsewhere", known)).toBe("elsewhere");
    // Before the list arrives only the page's own address tells.
    expect(lookInMachine("host-rex", { getSnapshot: () => undefined, shownElsewhere: "host-rex" })).toBeUndefined();
    expect(lookInMachine("host-rex", { getSnapshot: () => undefined })).toBe("host-rex");
    expect(lookInMachine("host-rex", undefined)).toBe("host-rex");
  });
});
