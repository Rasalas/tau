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

function scopedStore(scope: "host" | "project" | "remote") {
  const base = fakeHost();
  let remote: TauConfig = {};
  const client = {
    ...base.client,
    getEnvironmentConfig: vi.fn(async (_id: string) => ({ host: remote })),
    updateEnvironmentConfig: vi.fn(async (_id: string, patch: Partial<TauConfig>) => { remote = { ...remote, ...patch }; return {}; }),
    clearEnvironmentConfig: vi.fn(async (_id: string, keys: readonly string[]) => { remote = keys.reduce(withoutSetting, remote); return { host: remote }; }),
  };
  const store = new ConfigLayersStore(client);
  if (scope === "remote") store.editMachine({ id: "rex", name: "rex" });
  else store.edit(scope, app);
  return { ...base, client, store, read: scope === "remote" ? client.getEnvironmentConfig : client.getConfigLayers,
    update: scope === "remote" ? client.updateEnvironmentConfig : client.updateConfig,
    clear: scope === "remote" ? client.clearEnvironmentConfig : client.clearConfig,
    level: () => store.getSnapshot().layers[scope === "project" ? "project" : "host"],
  };
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
    expect(store.getSnapshot().error).toMatch(/connection to the machine/u);
  });

  it("takes a refused change back and says why", async () => {
    const { files, client } = fakeHost();
    client.updateConfig.mockRejectedValueOnce(new Error("disk full"));
    const store = new ConfigLayersStore(client);
    await store.write("showCosts", false);
    expect(files.host).toEqual({});
    expect(store.getSnapshot()).toMatchObject({ error: "disk full", layers: { host: {} } });
    await store.refresh();
    expect(store.getSnapshot().error).toBe("disk full");
    await store.retry();
    expect(store.getSnapshot().error).toBeUndefined();
    expect(files.host).toEqual({ showCosts: false });
  });

  it.each(["host", "project"] as const)("rolls back a refused %s write even when reloading also fails", async (editing) => {
    const { client } = fakeHost();
    const store = new ConfigLayersStore(client);
    store.edit(editing, app);
    await store.refresh();
    client.updateConfig.mockRejectedValueOnce(new Error("disk full"));
    client.getConfigLayers.mockRejectedValueOnce(new Error("offline"));
    await store.write("showCosts", false);
    expect(store.getSnapshot().layers[editing]).toEqual({});
    expect(store.getSnapshot().error).toBe("disk full");
  });

  it("keeps a newer optimistic write when an older write or read finishes", async () => {
    const { client, files } = fakeHost();
    const store = new ConfigLayersStore(client);
    await store.refresh();
    let finish!: () => void;
    client.updateConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { files.host = { transcriptDetail: "everything" }; resolve({}); }; }));
    const first = store.write("transcriptDetail", "everything");
    await vi.waitFor(() => expect(client.updateConfig).toHaveBeenCalledTimes(1));
    const second = store.write("transcriptDetail", "focused");
    finish();
    await first;
    expect(store.getSnapshot().layers.host.transcriptDetail).toBe("focused");
    await second;
    expect(files.host.transcriptDetail).toBe("focused");
  });

  it("ignores a failed write's error after choosing another scope", async () => {
    const { client } = fakeHost();
    const store = new ConfigLayersStore(client);
    await store.refresh();
    let fail!: (error: Error) => void;
    client.updateConfig.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const first = store.write("showCosts", false);
    await vi.waitFor(() => expect(client.updateConfig).toHaveBeenCalledTimes(1));
    store.edit("project", app);
    await store.refresh();
    fail(new Error("machine write refused"));
    await first;
    expect(store.getSnapshot().error).toBeUndefined();
    expect(store.getSnapshot().layers.project).toEqual({});
  });

  it("reports a refusal and rolls back before a slow recovery read finishes", async () => {
    const { store, client } = scopedStore("host");
    await store.refresh();
    client.updateConfig.mockRejectedValueOnce(new Error("disk full"));
    let finish!: (layers: ConfigLayers) => void;
    client.getConfigLayers.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const write = store.write("showCosts", false);
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ error: "disk full", layers: { host: {} }, pending: false }));
    finish({ host: {} });
    await write;
  });

  it("retries all refused keys when overlapping changes fail", async () => {
    const { store, client, files } = scopedStore("host");
    await store.refresh();
    client.updateConfig.mockRejectedValueOnce(new Error("disk full")).mockRejectedValueOnce(new Error("disk full"));
    await Promise.all([store.write("showCosts", false), store.write("hostBackground", true)]);
    expect(store.getSnapshot().layers.host).toEqual({});
    await store.retry();
    expect(files.host).toEqual({ showCosts: false, hostBackground: true });
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it("does not invalidate the next scope's read when a previous machine's write finishes", async () => {
    const { store, client } = scopedStore("remote");
    await store.refresh();
    let finishWrite!: () => void;
    client.updateEnvironmentConfig.mockImplementationOnce(() => new Promise((resolve) => { finishWrite = () => resolve({}); }));
    const write = store.write("showCosts", false);
    await vi.waitFor(() => expect(client.updateEnvironmentConfig).toHaveBeenCalledTimes(1));
    let finishRead!: (layers: ConfigLayers) => void;
    client.getConfigLayers.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    store.edit("project", app);
    finishWrite();
    await write;
    finishRead({ host: {}, project: { showCosts: true } });
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ loaded: true, layers: { project: { showCosts: true } } }));
  });

  describe.each(["host", "project", "remote"] as const)("%s write confirmation", (scope) => {
    it("rolls back a failed reset and can retry without losing another saved key", async () => {
      const { store, read, clear, level } = scopedStore(scope);
      await store.refresh();
      await store.write("showCosts", false);
      await store.write("hostBackground", true);
      clear.mockRejectedValueOnce(new Error("permission denied"));
      read.mockRejectedValueOnce(new Error("offline"));
      await store.clear("showCosts");
      expect(level()).toEqual({ showCosts: false, hostBackground: true });
      expect(store.getSnapshot()).toMatchObject({ error: "permission denied", pending: false });
      await store.retry();
      expect(level()).toEqual({ hostBackground: true });
      expect(store.getSnapshot().error).toBeUndefined();
    });

    it("retains an acknowledged write if the read fails and rolls a later refusal back to it", async () => {
      const { store, read, update, level } = scopedStore(scope);
      await store.refresh();
      read.mockRejectedValueOnce(new Error("offline"));
      await store.write("showCosts", false);
      expect(level()).toEqual({ showCosts: false });
      expect(store.getSnapshot().error).toBe("offline");
      update.mockRejectedValueOnce(new Error("disk full"));
      read.mockRejectedValueOnce(new Error("offline"));
      await store.write("showCosts", true);
      expect(level()).toEqual({ showCosts: false });
      expect(store.getSnapshot().error).toBe("disk full");
    });
  });

  it("captures queued destinations and keeps another machine's failure out of this project's settings", async () => {
    const { store, client, files } = scopedStore("remote");
    await store.refresh();
    let finish!: () => void;
    client.updateEnvironmentConfig.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({}); }));
    const remote = store.write("hostBackground", true);
    await vi.waitFor(() => expect(client.updateEnvironmentConfig).toHaveBeenCalledTimes(1));
    const queuedRemote = store.write("showCosts", false);
    client.updateEnvironmentConfig.mockRejectedValueOnce(new Error("rex offline"));
    store.edit("project", app);
    await store.refresh();
    const local = store.write("transcriptDetail", "everything");
    finish();
    await Promise.all([remote, queuedRemote, local]);
    expect(client.updateEnvironmentConfig).toHaveBeenLastCalledWith("rex", { showCosts: false });
    expect(client.updateConfig).toHaveBeenCalledExactlyOnceWith({ transcriptDetail: "everything" }, "project", app.workspaceId);
    expect(files.projects[app.workspaceId]).toEqual({ transcriptDetail: "everything" });
    expect(store.getSnapshot().error).toBeUndefined();
    expect(store.getSnapshot().layers.host).toEqual({});
  });

  it("discards an old project's read and error on switching projects", async () => {
    const { store, client } = scopedStore("project");
    await store.refresh();
    let finish!: (layers: ConfigLayers) => void;
    client.getConfigLayers.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldRead = store.refresh();
    store.edit("project", { workspaceId: "other", label: "other" });
    await store.refresh();
    finish({ host: {}, project: { showCosts: false } });
    await oldRead;
    expect(store.getSnapshot().layers.project).toEqual({});
    client.updateConfig.mockRejectedValueOnce(new Error("other refused"));
    await store.write("showCosts", false);
    expect(store.getSnapshot().error).toBe("other refused");
    store.edit("project", app);
    expect(store.getSnapshot().error).toBeUndefined();
    await store.refresh();
    expect(store.getSnapshot().layers.project).toEqual({});
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
