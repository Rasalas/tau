import type { TauConfig } from "../shared/contracts";
import { withSetting, withoutSetting, type ConfigLayers } from "../shared/config-layers";
import { errorMessage } from "./error-message";
import type { HostClient } from "./host-client";

/** A project Settings can edit the project level of. */
export interface SettingsProject {
  /** How the host addresses it; a path works on a local host too. */
  workspaceId: string;
  label: string;
  /** Where it is, for telling the same project apart in a list. */
  path?: string;
}

/** Another machine whose own settings Settings can edit (K170). */
export interface SettingsMachine {
  id: string;
  name: string;
  /** Why a change there is refused (Read-only pairing, not reachable); the values still show. */
  blocked?: string;
}

export interface ConfigLayersSnapshot {
  /** The level a change is written to. */
  editing: "host" | "project";
  /** The project whose level is read, and written while `editing` is "project". */
  project?: SettingsProject;
  /** The other machine whose machine level is read and written; `editing` is then "host". */
  machine?: SettingsMachine;
  layers: ConfigLayers;
  loaded: boolean;
  error?: string;
  /** A setting on screen that a project may override: only then is a project worth offering. */
  projectSettings: boolean;
}

type ConfigLayersClient = Pick<HostClient, "getConfigLayers" | "updateConfig" | "clearConfig" | "getEnvironmentConfig" | "updateEnvironmentConfig" | "clearEnvironmentConfig">;

/**
 * The two levels Settings shows and writes: this machine's file and one
 * project's. A write lands in the level being edited, shows at once and is
 * then read back from the host; `onWritten` lets the client's own preferences
 * catch up with what now applies.
 */
export class ConfigLayersStore {
  private snapshot: ConfigLayersSnapshot = { editing: "host", layers: { host: {} }, loaded: false, projectSettings: false };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private projectRows = 0;

  constructor(
    private readonly client: ConfigLayersClient | undefined,
    private readonly onWritten: () => void = () => undefined,
  ) {}

  getSnapshot = (): ConfigLayersSnapshot => this.snapshot;

  /** A setting that a project may override is on screen; the returned function says it left. */
  declareProjectSetting(): () => void {
    this.projectRows += 1;
    if (this.projectRows === 1) this.set({ projectSettings: true });
    return () => {
      this.projectRows -= 1;
      if (this.projectRows === 0) this.set({ projectSettings: false });
    };
  }

  /** Without a host there is no level to write; callers fall back to the client's own copy. */
  get available(): boolean {
    return this.client !== undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The project the levels are read for; the host level stays the one edited. */
  setProject(project: SettingsProject | undefined): void {
    if (this.snapshot.project?.workspaceId === project?.workspaceId) return;
    this.set({ project, editing: project ? this.snapshot.editing : "host" });
    void this.refresh();
  }

  /** Edits the host level, or a project's; choosing a project also reads its level. */
  edit(editing: "host" | "project", project: SettingsProject | undefined = this.snapshot.project): void {
    const target = editing === "project" ? project : this.snapshot.project ?? project;
    if (editing === "project" && !target) return;
    const moved = target?.workspaceId !== this.snapshot.project?.workspaceId || this.snapshot.machine !== undefined;
    this.set({ editing, project: target, machine: undefined });
    if (moved) void this.refresh();
  }

  /** Edits another machine's own settings; a project belongs to this machine, so none is read. */
  editMachine(machine: SettingsMachine): void {
    const current = this.snapshot.machine;
    if (current?.id === machine.id) {
      if (current.name !== machine.name || current.blocked !== machine.blocked) this.set({ machine });
      return;
    }
    this.set({ editing: "host", machine, loaded: false, layers: { host: {} } });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.set({ loaded: true, error: "Settings need a host connection." });
      return;
    }
    const generation = ++this.generation;
    try {
      const layers = await this.target().getConfigLayers(this.snapshot.project?.workspaceId);
      if (generation === this.generation) this.set({ layers, loaded: true, error: undefined });
    } catch (error) {
      if (generation === this.generation) this.set({ loaded: true, error: errorMessage(error) });
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const { editing, project } = this.snapshot;
    this.applyLocally(editing, (level) => withSetting(level, key, value));
    await this.send(() => this.target().updateConfig(withSetting({}, key, value) as Partial<TauConfig>, editing === "project" ? "project" : "global", project?.workspaceId));
  }

  /** Removes the key from the level being edited, so the one below shows through. */
  async clear(key: string): Promise<void> {
    const { editing, project } = this.snapshot;
    this.applyLocally(editing, (level) => withoutSetting(level, key));
    await this.send(() => this.target().clearConfig([key], editing === "project" ? "project" : "global", project?.workspaceId));
  }

  /** The host being edited: this one, or another machine's own levels through it. */
  private target(): Pick<ConfigLayersClient, "getConfigLayers" | "updateConfig" | "clearConfig"> {
    const client = this.client!;
    const id = this.snapshot.machine?.id;
    if (id === undefined) return client;
    return {
      getConfigLayers: () => client.getEnvironmentConfig(id),
      updateConfig: (patch) => client.updateEnvironmentConfig(id, patch) as Promise<TauConfig>,
      clearConfig: (keys) => client.clearEnvironmentConfig(id, keys) as Promise<ConfigLayers>,
    };
  }

  private async send(call: () => Promise<unknown>): Promise<void> {
    if (!this.client) return;
    let failure: string | undefined;
    try {
      await call();
      this.onWritten();
    } catch (error) {
      failure = errorMessage(error);
    }
    // The read puts back what the host really holds, a refused change included.
    await this.refresh();
    if (failure) this.set({ error: failure });
  }

  private applyLocally(editing: "host" | "project", change: (level: TauConfig) => TauConfig): void {
    // A read already on its way predates this change.
    this.generation += 1;
    const layers = this.snapshot.layers;
    this.set({
      layers: editing === "project"
        ? { ...layers, project: change(layers.project ?? {}) }
        : { ...layers, host: change(layers.host) },
    });
  }

  private set(patch: Partial<ConfigLayersSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
