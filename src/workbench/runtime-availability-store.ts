import type { HostSnapshot, TauConfig, UiRuntimeBackend } from "../shared/contracts";
import { disabledRuntimeKinds } from "../shared/runtime-enabled";

/** What the store asks the host: the config a project resolves to, machine file and project file merged. */
export interface RuntimeAvailabilityPort {
  getConfig(workspaceId: string): Promise<TauConfig>;
}

const NONE: readonly string[] = [];

/**
 * Which runtimes each project turned off (ADR 0032), as the host resolves them.
 * A project is asked once when a draft or thread on screen belongs to it and
 * again whenever the host says its config changed. The host enforces the
 * answer; this only keeps the pickers from offering what would be refused.
 */
export class RuntimeAvailabilityStore {
  private readonly disabledBy = new Map<string, readonly string[]>();
  private readonly asked = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly port: RuntimeAvailabilityPort) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The kinds the project turned off; the same array until the answer changes. */
  disabled = (workspaceId: string | undefined): readonly string[] => (workspaceId ? this.disabledBy.get(workspaceId) ?? NONE : NONE);

  /** Asks the host the first time a project is on screen. */
  request(workspaceId: string | undefined): void {
    if (!workspaceId || this.asked.has(workspaceId)) return;
    this.asked.add(workspaceId);
    this.load(workspaceId);
  }

  /** Asks again every project already asked about: a config file changed. */
  refresh(): void {
    for (const workspaceId of this.asked) this.load(workspaceId);
  }

  private load(workspaceId: string): void {
    this.port.getConfig(workspaceId).then((config) => {
      const kinds = disabledRuntimeKinds(config);
      const held = this.disabledBy.get(workspaceId) ?? NONE;
      if (kinds.length === held.length && kinds.every((kind, index) => kind === held[index])) return;
      this.disabledBy.set(workspaceId, kinds.length ? kinds : NONE);
      for (const listener of this.listeners) listener();
    }, () => undefined);
  }
}

/** The snapshot with the runtimes `disabled` marked off in its backends; the same object when none is. */
export function withDisabledRuntimes(snapshot: HostSnapshot | undefined, disabled: readonly string[]): HostSnapshot | undefined {
  if (!snapshot?.runtimeBackends?.length || disabled.length === 0) return snapshot;
  const backends: UiRuntimeBackend[] = snapshot.runtimeBackends.map((backend) => (disabled.includes(backend.kind) ? { ...backend, disabled: true } : backend));
  return { ...snapshot, runtimeBackends: backends };
}
