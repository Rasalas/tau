import type { RuntimeToolVersion, ThreadBackendKind } from "../shared/contracts.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RuntimeVersionsOptions {
  providers(): Iterable<HostRuntimeBackendProvider>;
  /** A backend answered with something new; the host republishes its catalog. */
  onChange(): void;
  log(label: string, detail?: string): void;
  now?(): number;
  maxAgeMs?: number;
}

/**
 * The version each registered backend reports for the program it drives.
 * Asking may spawn a process or reach a registry, so it never holds up a
 * snapshot: the first one goes without and a catalog update follows.
 */
export class RuntimeVersions {
  private readonly known = new Map<ThreadBackendKind, RuntimeToolVersion>();
  /** When each kind was last asked, and of which provider: a kind registered anew is asked again. */
  private readonly asked = new Map<ThreadBackendKind, { at: number; provider: HostRuntimeBackendProvider }>();

  constructor(private readonly options: RuntimeVersionsOptions) {}

  get(kind: ThreadBackendKind): RuntimeToolVersion | undefined {
    const version = this.known.get(kind);
    return version ? { ...version } : undefined;
  }

  /** Asks every backend it has not asked today, and one registered since. */
  refresh(): void {
    const now = (this.options.now ?? Date.now)();
    for (const provider of this.options.providers()) {
      if (!provider.version) continue;
      const asked = this.asked.get(provider.kind);
      if (asked?.provider === provider && now - asked.at < (this.options.maxAgeMs ?? DAY_MS)) continue;
      this.asked.set(provider.kind, { at: now, provider });
      void this.ask(provider);
    }
  }

  private async ask(provider: HostRuntimeBackendProvider): Promise<void> {
    let version: RuntimeToolVersion | undefined;
    try {
      version = await provider.version!();
    } catch (error) {
      this.options.log("runtime-version.failed", `${provider.kind}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const previous = this.known.get(provider.kind);
    if (JSON.stringify(previous) === JSON.stringify(version)) return;
    if (version) this.known.set(provider.kind, { ...version });
    else this.known.delete(provider.kind);
    this.options.onChange();
  }
}
