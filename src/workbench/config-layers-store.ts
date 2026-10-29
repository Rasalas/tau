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
  /** At least one change to these levels is still being saved. */
  pending?: boolean;
  /** A setting on screen that a project may override: only then is a project worth offering. */
  projectSettings: boolean;
}

interface PendingWrite {
  editing: "host" | "project";
  project?: SettingsProject;
  machine?: SettingsMachine;
  scopeVersion: number;
  key: string;
  change(level: TauConfig): TauConfig;
  call(): Promise<unknown>;
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
  private confirmed: ConfigLayers = { host: {} };
  private readonly writes: PendingWrite[] = [];
  private queue: Promise<void> = Promise.resolve();
  private scopeVersion = 0;
  private readonly failures = new Map<string, { write: PendingWrite; error: string }>();

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
    this.move({ project, editing: project ? this.snapshot.editing : "host" });
  }

  /** Edits the host level, or a project's; choosing a project also reads its level. */
  edit(editing: "host" | "project", project: SettingsProject | undefined = this.snapshot.project): void {
    const target = editing === "project" ? project : this.snapshot.project ?? project;
    if (editing === "project" && !target) return;
    this.move({ editing, project: target, machine: undefined });
  }

  /** Edits another machine's own settings; a project belongs to this machine, so none is read. */
  editMachine(machine: SettingsMachine): void {
    const current = this.snapshot.machine;
    if (current?.id === machine.id) {
      if (current.name !== machine.name || current.blocked !== machine.blocked) this.set({ machine });
      return;
    }
    this.move({ editing: "host", machine });
  }

  /** A scope change drops its error; outstanding writes keep their original destination. */
  private move(patch: Partial<ConfigLayersSnapshot>): void {
    const before = this.snapshot;
    const next = { ...before, ...patch };
    const moved = before.machine?.id !== next.machine?.id || before.project?.workspaceId !== next.project?.workspaceId;
    const changedScope = moved || before.editing !== next.editing;
    if (changedScope) {
      this.scopeVersion += 1;
      this.generation += 1;
      this.failures.clear();
    }
    if (moved) this.confirmed = { host: {} };
    this.snapshot = next;
    this.publish({ ...(changedScope ? { error: undefined } : {}), ...(moved ? { loaded: false } : {}) });
    if (changedScope) void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.read();
  }

  private async read(): Promise<void> {
    if (!this.client) {
      this.set({ loaded: true, error: "Settings need a connection to the machine." });
      return;
    }
    const generation = ++this.generation;
    try {
      const layers = await this.target().getConfigLayers(this.snapshot.project?.workspaceId);
      if (generation === this.generation) {
        this.confirmed = layers;
        this.publish({ loaded: true, ...(this.failures.size ? {} : { error: undefined }) });
      }
    } catch (error) {
      if (generation === this.generation) this.set({ loaded: true, ...(this.failures.size ? {} : { error: errorMessage(error) }) });
    }
  }

  write(key: string, value: unknown): Promise<void> {
    const { editing, project, machine } = this.snapshot;
    const target = this.target();
    return this.enqueue({ editing, project, machine, key, scopeVersion: this.scopeVersion,
      change: (level) => withSetting(level, key, value),
      call: () => target.updateConfig(withSetting({}, key, value) as Partial<TauConfig>, editing === "project" ? "project" : "global", project?.workspaceId),
    });
  }

  /** Removes the key from the level being edited, so the one below shows through. */
  clear(key: string): Promise<void> {
    const { editing, project, machine } = this.snapshot;
    const target = this.target();
    return this.enqueue({ editing, project, machine, key, scopeVersion: this.scopeVersion,
      change: (level) => withoutSetting(level, key),
      call: () => target.clearConfig([key], editing === "project" ? "project" : "global", project?.workspaceId),
    });
  }

  /** Retries the refused change, or reads the levels again after a failed read. */
  retry = async (): Promise<void> => {
    const failures = [...this.failures.values()];
    if (failures.length) await Promise.all(failures.map(({ write }) => this.enqueue({ ...write, scopeVersion: this.scopeVersion })));
    else await this.refresh();
  };

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

  private enqueue(write: PendingWrite): Promise<void> {
    if (!this.client) return Promise.resolve();
    this.failures.delete(write.key);
    this.generation += 1;
    this.writes.push(write);
    this.publish({ error: [...this.failures.values()].at(-1)?.error });
    // Keep acknowledgements in the same order as the person's edits, including resets.
    const result = this.queue.then(() => this.send(write));
    this.queue = result;
    return result;
  }

  private matches(write: PendingWrite): boolean {
    return write.machine?.id === this.snapshot.machine?.id
      && (write.editing === "host" || write.project?.workspaceId === this.snapshot.project?.workspaceId);
  }

  private apply(layers: ConfigLayers, write: PendingWrite): ConfigLayers {
    return write.editing === "project"
      ? { ...layers, project: write.change(layers.project ?? {}) }
      : { ...layers, host: write.change(layers.host) };
  }

  private async send(write: PendingWrite): Promise<void> {
    let failure: string | undefined;
    try {
      await write.call();
      if (this.matches(write)) this.confirmed = this.apply(this.confirmed, write);
      this.onWritten();
    } catch (error) {
      failure = errorMessage(error);
    }
    const current = write.scopeVersion === this.scopeVersion;
    if (this.matches(write) && (!failure || current)) this.generation += 1;
    this.writes.splice(this.writes.indexOf(write), 1);
    if (failure && current
      && !this.writes.some((next) => next.scopeVersion === write.scopeVersion && next.key === write.key)) {
      this.failures.set(write.key, { write, error: failure });
    }
    // Roll back and report the refusal before a read that may fail or take time.
    this.publish(this.failures.size ? { error: [...this.failures.values()].at(-1)?.error } : {});
    if (!this.matches(write) || (!current && failure)) return;
    await this.read();
  }

  private publish(patch: Partial<ConfigLayersSnapshot> = {}): void {
    const pending = this.writes.filter((write) => this.matches(write));
    this.set({ layers: pending.reduce((layers, write) => this.apply(layers, write), this.confirmed), pending: pending.length > 0, ...patch });
  }

  private set(patch: Partial<ConfigLayersSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
