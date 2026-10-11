import type { TauConfig, ThreadBackendKind } from "../shared/contracts.js";
import { runtimeEnabled, runtimeOffMessage } from "../shared/runtime-enabled.js";

export interface RuntimeGatePort {
  /** The merged config of the project at `path` (machine file, then the project's); the machine's alone without one. */
  config(path: string | undefined): TauConfig;
  /** The project whose settings `cwd` follows: a linked worktree's repository, else `cwd`. */
  owner(cwd: string): Promise<string>;
  /** What the workbench calls the runtime. */
  label(kind: ThreadBackendKind): string;
  projectName(path: string): string;
  /** Every project the host knows, for telling whether anything still uses a runtime. */
  projectPaths(): readonly string[];
}

/** A start on a runtime the project turned off. */
export class RuntimeOffError extends Error {
  constructor(readonly kind: ThreadBackendKind, readonly project: string, message: string) {
    super(message);
  }
}

/**
 * Whether a runtime may start work in a folder (ADR 0032). The host asks it
 * wherever a turn starts or wakes; a thread on another machine is that
 * machine's to gate.
 */
export class RuntimeGate {
  constructor(private readonly port: RuntimeGatePort) {}

  async enabled(kind: ThreadBackendKind, cwd: string): Promise<boolean> {
    if (kind === "machine") return true;
    return runtimeEnabled(this.port.config(await this.port.owner(cwd)), kind);
  }

  /** Throws a `RuntimeOffError` when `kind` is off in the project `cwd` belongs to. */
  async assert(kind: ThreadBackendKind, cwd: string): Promise<void> {
    if (kind === "machine") return;
    const project = await this.port.owner(cwd);
    if (runtimeEnabled(this.port.config(project), kind)) return;
    throw new RuntimeOffError(kind, project, runtimeOffMessage(this.port.label(kind), this.port.projectName(project)));
  }

  /** Whether the runtime is on for this machine or for any project the host knows. */
  inUse(kind: ThreadBackendKind): boolean {
    if (runtimeEnabled(this.port.config(undefined), kind)) return true;
    return this.port.projectPaths().some((path) => runtimeEnabled(this.port.config(path), kind));
  }
}
