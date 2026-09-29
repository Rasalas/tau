import type { HostExtensionSummary } from "../shared/contracts";
import { methodAccess, READ_ONLY_REASON } from "../shared/host-method-access";
import { HOST_ERROR } from "../shared/host-transport";
import { HostRequestError } from "./host-connection";

/**
 * What a device paired Read only gets for a call the host would refuse: the
 * reason its disabled controls give, before anything is sent (ADR 0024).
 */
export function readOnlyRefusal(): HostRequestError {
  return new HostRequestError(READ_ONLY_REASON, HOST_ERROR.forbidden);
}

/** Whether a Read-only device may make this core call; kit commands are `ReadCommands`' to answer. */
export function readOnlyMayCall(method: string): boolean {
  return methodAccess(method) === "read";
}

const key = (extensionId: string, command: string) => `${extensionId}/${command}`;

/** A host half as the host lists it: running, or the reason it failed to start. */
export interface HostHalf {
  active: boolean;
  error?: string;
}

/**
 * The kit commands a Read-only device may call, from the host's extension
 * summaries. Loaded on first need; after a package change the old answer
 * holds for controls until the new one arrives, while a call waits for it.
 */
export class ReadCommands {
  private known: ReadonlySet<string> | undefined;
  /** Each host half by extension id: running, or why not. */
  private halves = new Map<string, HostHalf>();
  private loading: Promise<ReadonlySet<string>> | undefined;
  private stale = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly list: () => Promise<HostExtensionSummary[]>) {}

  /** Undefined until the host has answered once; asking starts the load. */
  allows(extensionId: string, command: string): boolean | undefined {
    if (!this.known || this.stale) void this.load().catch(() => undefined);
    return this.known?.has(key(extensionId, command));
  }

  /**
   * The host half of an extension as the host last listed it: undefined until
   * the host answered once, null when it lists no such half.
   */
  hostHalf(extensionId: string): HostHalf | null | undefined {
    if (!this.known || this.stale) void this.load().catch(() => undefined);
    if (!this.known) return undefined;
    return this.halves.get(extensionId) ?? null;
  }

  async check(extensionId: string, command: string): Promise<boolean> {
    return (await this.load()).has(key(extensionId, command));
  }

  /** Packages came or went; asked again only once something needs it. */
  invalidate(): void {
    if (!this.known && !this.loading) return;
    this.stale = true;
    this.loading = undefined;
    if (this.listeners.size > 0) void this.load().catch(() => undefined);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): Promise<ReadonlySet<string>> {
    if (this.known && !this.stale) return Promise.resolve(this.known);
    if (this.loading) return this.loading;
    const loading = this.list().then((summaries) => {
      const known = new Set(summaries.flatMap((summary) => (summary.readCommands ?? []).map((command) => key(summary.id, command))));
      if (this.loading === loading) {
        this.loading = undefined;
        this.known = known;
        this.halves = new Map(summaries.map((summary) => [summary.id, { active: summary.active, ...(summary.error ? { error: summary.error } : {}) }]));
        this.stale = false;
        for (const listener of this.listeners) listener();
      }
      return known;
    }, (error: unknown) => {
      if (this.loading === loading) this.loading = undefined;
      throw error;
    });
    this.loading = loading;
    return loading;
  }
}
