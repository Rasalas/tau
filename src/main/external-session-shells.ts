import type { UiProject, UiSession, UiThreadUsage } from "../shared/contracts.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { cleanThreadTitle, firstSentence, safeSessionTitle, visibleTitleText } from "./host-messages.js";
import { externalThreadPath } from "./pi-host-support.js";
import { hasThreadUsage } from "./session-usage.js";
import type { UsageTally } from "./usage-pricing.js";

type ProviderRecords = Awaited<ReturnType<HostRuntimeBackendProvider["listThreads"]>>;
type ListingResult = { records: ProviderRecords } | { error: unknown };
interface PendingListing { promise: Promise<ListingResult>; result?: ListingResult; timedOut: boolean }

/** One unresolved call per provider, even when recovery scans outpace it. */
export class ExternalSessionListings {
  private readonly pending = new Map<HostRuntimeBackendProvider, PendingListing>();
  private closed = false;
  constructor(private readonly onLateResult?: (provider: HostRuntimeBackendProvider) => void) {}
  retain(providers: readonly HostRuntimeBackendProvider[]): void {
    const retained = new Set(providers);
    for (const provider of this.pending.keys()) if (!retained.has(provider)) this.pending.delete(provider);
  }
  async read(provider: HostRuntimeBackendProvider, timeoutMs: number): Promise<ListingResult> {
    if (this.closed) return { error: new Error("Thread listing is closed") };
    let pending = this.pending.get(provider);
    if (pending?.result) { this.pending.delete(provider); return pending.result; }
    if (pending?.timedOut) return { error: new Error(`Thread listing still pending for ${provider.kind}`) };
    if (!pending) {
      pending = { promise: undefined as never, timedOut: false };
      const entry = pending;
      let request: Promise<ProviderRecords>;
      try { request = provider.listThreads(); } catch (error) { request = Promise.reject(error); }
      entry.promise = Promise.resolve(request).then((records): ListingResult => ({ records }), (error): ListingResult => ({ error })).then((result) => {
        // A replaced/unregistered provider's late result has no authority.
        if (!this.closed && this.pending.get(provider) === entry) {
          entry.result = result;
          if (entry.timedOut) this.onLateResult?.(provider);
        }
        return result;
      });
      this.pending.set(provider, entry);
    }
    const entry = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([entry.promise, new Promise<ListingResult>((resolve) => {
      timer = setTimeout(() => { entry.timedOut = true; resolve({ error: new Error(`Thread listing timed out for ${provider.kind}`) }); }, timeoutMs);
    })]);
    clearTimeout(timer);
    if (!entry.timedOut && this.pending.get(provider) === entry) this.pending.delete(provider);
    return result;
  }
  dispose(): void { this.closed = true; this.pending.clear(); }
}

export async function loadExternalSessionShells(options: {
  safeMode: boolean;
  providers: Iterable<HostRuntimeBackendProvider>;
  listings?: ExternalSessionListings;
  timeoutMs?: number;
  projectName(cwd: string): string;
  projectLabel(cwd: string): string | undefined;
  onProject?(threadId: string, project: Pick<UiProject, "name" | "icon"> & { listed?: boolean }): void;
  isCurrent?(provider: HostRuntimeBackendProvider): boolean;
  onUnavailable?(provider: HostRuntimeBackendProvider): void;
  onReady?(provider: HostRuntimeBackendProvider, shells: UiSession[]): void;
  onError(provider: HostRuntimeBackendProvider, error: unknown): void;
  /** Prices a thread's tallies for its shell; without it a shell carries no cost. */
  usage?(path: string, tallies: readonly UsageTally[]): UiThreadUsage | undefined;
}): Promise<UiSession[]> {
  if (options.safeMode) return [];
  const providers = [...options.providers];
  const listings = options.listings ?? new ExternalSessionListings();
  listings.retain(providers);
  const results = new Array<UiSession[]>(providers.length);
  const projects = new Array<Array<[string, Pick<UiProject, "name" | "icon"> & { listed?: boolean }]>>(providers.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
    while (next < providers.length) {
      const index = next++;
      const provider = providers[index]!;
      const result = await listings.read(provider, options.timeoutMs ?? 1_000);
      if (options.isCurrent && !options.isCurrent(provider)) { results[index] = []; continue; }
      if ("error" in result) {
        options.onError(provider, result.error);
        options.onUnavailable?.(provider);
        results[index] = [];
        continue;
      }
      const shells: UiSession[] = [];
      projects[index] = [];
      for (const record of result.records) {
        if (record.project) projects[index]!.push([record.threadId, record.project]);
        const firstUser = record.messages.find((message) => message.role === "user");
        const modelProvider = record.model?.provider ?? provider.modelProvider;
        const path = externalThreadPath(provider.kind, record.threadId);
        const usage = record.usage?.length ? options.usage?.(path, record.usage) : undefined;
        shells.push({
          id: record.threadId, path,
          title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
          modifiedAt: record.updatedAt,
          ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
          projectPath: record.cwd,
          projectName: record.project?.name ?? options.projectName(record.cwd),
          ...(record.project?.listed === false ? { projectless: true } : {}),
          projectLabel: options.projectLabel(record.cwd),
          ...(record.workspace ? { workspaceId: record.workspace.workspaceId, projectDisplayPath: record.workspace.displayPath } : {}),
          messageCount: record.messageCount ?? record.messages.length,
          ...(record.machine ? { machine: { ...record.machine } } : {}),
          backendKind: provider.kind,
          ...(modelProvider ? { modelProvider } : {}),
          ...(record.model?.id ? { model: record.model.id } : {}),
          ...(hasThreadUsage(usage) ? { usage } : {}),
        });
      }
      results[index] = shells;
      options.onReady?.(provider, shells);
    }
  }));
  for (const entries of projects) for (const [id, project] of entries ?? []) options.onProject?.(id, project);
  return results.flat();
}
