import { describe, expect, it, vi } from "vitest";
import type { TauConfig } from "../shared/contracts";
import { withSetting, withoutSetting, type ConfigLayers } from "../shared/config-layers";
import { ConfigLayersStore } from "./config-layers-store";

/** A host with two files in memory, answering the way HostConfigManager does. */
function fakeHost() {
  const files: { host: TauConfig; projects: Record<string, TauConfig> } = { host: {}, projects: {} };
  const layers = (workspaceId?: string): ConfigLayers => workspaceId
    ? { host: files.host, project: files.projects[workspaceId] ?? {}, projectPath: workspaceId }
    : { host: files.host };
  const merge = (level: TauConfig, patch: Partial<TauConfig>) => Object.entries(patch).reduce<TauConfig>((next, [key, value]) =>
    typeof value === "object" && value && !Array.isArray(value)
      ? Object.entries(value).reduce((inner, [entry, entryValue]) => withSetting(inner, `${key}.${entry}`, entryValue), next)
      : withSetting(next, key, value), level);
  const client = {
    getConfigLayers: vi.fn(async (workspaceId?: string) => layers(workspaceId)),
    updateConfig: vi.fn(async (patch: Partial<TauConfig>, scope?: "global" | "project", workspaceId?: string) => {
      if (scope === "project" && workspaceId) files.projects[workspaceId] = merge(files.projects[workspaceId] ?? {}, patch);
      else files.host = merge(files.host, patch);
      return {};
    }),
    clearConfig: vi.fn(async (keys: readonly string[], scope?: "global" | "project", workspaceId?: string) => {
      if (scope === "project" && workspaceId) files.projects[workspaceId] = keys.reduce(withoutSetting, files.projects[workspaceId] ?? {});
      else files.host = keys.reduce(withoutSetting, files.host);
      return layers(workspaceId);
    }),
  };
  return { files, client };
}

const app = { workspaceId: "/work/app", label: "app" };

describe("ConfigLayersStore", () => {
  it("writes to the host level until a project is chosen, then to that project's file", async () => {
    const { files, client } = fakeHost();
    const written = vi.fn();
    const store = new ConfigLayersStore(client, written);
    store.setProject(app);
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ editing: "host", project: app, loaded: true });

    await store.write("showCosts", false);
    expect(files.host).toEqual({ showCosts: false });
    expect(client.updateConfig).toHaveBeenLastCalledWith({ showCosts: false }, "global", "/work/app");

    store.edit("project");
    await store.write("values.tau.appearance.density", "compact");
    expect(files.projects["/work/app"]).toEqual({ values: { "tau.appearance.density": "compact" } });
    expect(store.getSnapshot().layers.project).toEqual({ values: { "tau.appearance.density": "compact" } });
    expect(written).toHaveBeenCalledTimes(2);
  });

  it("shows a change before the host answers, and clears an override to inherit again", async () => {
    const { files, client } = fakeHost();
    const store = new ConfigLayersStore(client);
    store.edit("project", app);
    await store.refresh();
    const pending = store.write("transcriptDetail", "everything");
    expect(store.getSnapshot().layers.project).toEqual({ transcriptDetail: "everything" });
    await pending;

    await store.clear("transcriptDetail");
    expect(files.projects["/work/app"]).toEqual({});
    expect(client.clearConfig).toHaveBeenCalledWith(["transcriptDetail"], "project", "/work/app");
  });

  it("will not edit a project level without a project, and says when there is no host", async () => {
    const store = new ConfigLayersStore(undefined);
    store.edit("project");
    expect(store.getSnapshot().editing).toBe("host");
    await store.refresh();
    expect(store.getSnapshot().error).toMatch(/host connection/u);
  });

  it("takes a refused change back and says why", async () => {
    const { files, client } = fakeHost();
    client.updateConfig.mockRejectedValueOnce(new Error("disk full"));
    const store = new ConfigLayersStore(client);
    await store.write("showCosts", false);
    expect(files.host).toEqual({});
    expect(store.getSnapshot()).toMatchObject({ error: "disk full", layers: { host: {} } });
    await store.refresh();
    expect(store.getSnapshot().error).toBeUndefined();
  });

  describe("another machine's levels", () => {
    function withMachine() {
      const base = fakeHost();
      const rex: { host: TauConfig } = { host: { hostBackground: true } };
      const client = {
        ...base.client,
        getEnvironmentConfig: vi.fn(async (_machine: string) => ({ host: rex.host })),
        updateEnvironmentConfig: vi.fn(async (_machine: string, patch: Partial<TauConfig>) => { rex.host = { ...rex.host, ...patch }; return {}; }),
        clearEnvironmentConfig: vi.fn(async (_machine: string, keys: readonly string[]) => { rex.host = keys.reduce(withoutSetting, rex.host); return {}; }),
      };
      return { ...base, client, rex };
    }

    it("reads and writes that machine's host level, never this machine's files or a project's", async () => {
      const { files, client, rex } = withMachine();
      const store = new ConfigLayersStore(client);
      store.setProject(app);
      store.editMachine({ id: "rex", name: "rex" });
      await vi.waitFor(() => expect(store.getSnapshot().layers).toEqual({ host: { hostBackground: true } }));
      expect(store.getSnapshot()).toMatchObject({ editing: "host", machine: { id: "rex" } });

      await store.write("hostBackground", false);
      expect(client.updateEnvironmentConfig).toHaveBeenCalledWith("rex", { hostBackground: false });
      expect(rex.host).toEqual({ hostBackground: false });
      await store.clear("hostBackground");
      expect(client.clearEnvironmentConfig).toHaveBeenCalledWith("rex", ["hostBackground"]);
      expect(store.getSnapshot().layers).toEqual({ host: {} });
      expect(files.host).toEqual({});
      expect(client.updateConfig).not.toHaveBeenCalled();
    });

    it("goes back to this machine's levels when this machine or a project is chosen", async () => {
      const { files, client } = withMachine();
      files.host = { showCosts: false };
      const store = new ConfigLayersStore(client);
      store.editMachine({ id: "rex", name: "rex" });
      await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
      store.edit("project", app);
      expect(store.getSnapshot().machine).toBeUndefined();
      await vi.waitFor(() => expect(store.getSnapshot().layers.project).toEqual({}));
      store.editMachine({ id: "rex", name: "rex" });
      store.edit("host");
      await vi.waitFor(() => expect(store.getSnapshot().layers.host).toEqual({ showCosts: false }));
    });

    it("says why a machine cannot be reached, and follows a change of its access without reading again", async () => {
      const { client } = withMachine();
      client.getEnvironmentConfig.mockRejectedValueOnce(new Error("rex is not reachable right now."));
      const store = new ConfigLayersStore(client);
      store.editMachine({ id: "rex", name: "rex" });
      await vi.waitFor(() => expect(store.getSnapshot().error).toBe("rex is not reachable right now."));
      await store.refresh();
      store.editMachine({ id: "rex", name: "rex", blocked: "Read only" });
      expect(store.getSnapshot().machine?.blocked).toBe("Read only");
      expect(client.getEnvironmentConfig).toHaveBeenCalledTimes(2);
    });
  });

  it("counts the rows on screen that a project may override", () => {
    const store = new ConfigLayersStore(fakeHost().client);
    const first = store.declareProjectSetting();
    const second = store.declareProjectSetting();
    expect(store.getSnapshot().projectSettings).toBe(true);
    first();
    expect(store.getSnapshot().projectSettings).toBe(true);
    second();
    expect(store.getSnapshot().projectSettings).toBe(false);
  });
});
