import type { HostSnapshot, ThreadBackendKind, UiModel, UiRuntimeCatalog, UiRuntimeCatalogStatus } from "../shared/contracts";
import type { NewThreadDraft } from "./draft-store";

export type RuntimeCatalogEntry =
  | { status: "loading" }
  | { status: "ready"; catalog: UiRuntimeCatalog }
  /** `reason` is the host's status for it, when the runtime said why. */
  | { status: "unavailable"; message?: string; reason?: UiRuntimeCatalogStatus; catalog?: UiRuntimeCatalog };

/** What the store asks the host; `HostClient` answers both. */
export interface RuntimeCatalogPort {
  runtimeCatalog(kind: ThreadBackendKind): Promise<UiRuntimeCatalog | undefined>;
  runtimeCatalogs(revalidate: boolean, known: Record<string, number>): Promise<UiRuntimeCatalog[]>;
}

const MAX_AGE_MS = 2 * 60 * 1000;
const EMPTY: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> = new Map();

/** A catalog with models is ready even when its last refresh failed; one without says why. */
export function catalogEntry(catalog: UiRuntimeCatalog | undefined): RuntimeCatalogEntry {
  if (!catalog) return { status: "unavailable" };
  if (catalog.models.length > 0 || (!catalog.note && !catalog.status)) return { status: "ready", catalog };
  return { status: "unavailable", ...(catalog.note ? { message: catalog.note } : {}), ...(catalog.status ? { reason: catalog.status } : {}), catalog };
}

/**
 * What each runtime offers a thread that does not exist yet, as the host
 * holds it. A picker that opens asks for every catalog the store does not
 * hold yet and makes the host revalidate the old ones; the host's
 * `runtime-catalog` events (`apply`) keep the rest current. A draft bound
 * for one runtime asks for that one, at most every two minutes.
 */
export class RuntimeCatalogStore {
  private readonly entries = new Map<ThreadBackendKind, { entry: RuntimeCatalogEntry; at: number }>();
  private readonly listeners = new Set<() => void>();
  private view: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> = EMPTY;
  private listing: Promise<void> | undefined;

  constructor(private readonly port: RuntimeCatalogPort, private readonly now: () => number = Date.now) {}

  get = (kind: ThreadBackendKind): RuntimeCatalogEntry | undefined => this.entries.get(kind)?.entry;

  /** Every runtime's entry; the same map until one changes. */
  all = (): ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Asks the host unless a fresh answer or a request is already there. */
  request(kind: ThreadBackendKind): void {
    const held = this.entries.get(kind);
    if (held && (held.entry.status === "loading" || this.now() - held.at < MAX_AGE_MS)) return;
    this.put(kind, { status: "loading" });
    this.port.runtimeCatalog(kind).then(
      (catalog) => this.put(kind, catalogEntry(catalog)),
      (error: unknown) => this.put(kind, { status: "unavailable", message: error instanceof Error ? error.message : String(error) }),
    );
  }

  /**
   * A picker opened: every catalog not held yet, and the host asks again the
   * ones some minutes old. Resolves once the host answered with what it holds.
   */
  refresh(): Promise<void> {
    if (this.listing) return this.listing;
    const known: Record<string, number> = {};
    for (const [kind, { entry }] of this.entries) {
      const checkedAt = entry.status === "loading" ? undefined : entry.catalog?.checkedAt;
      if (checkedAt !== undefined) known[kind] = checkedAt;
    }
    const listing = this.port.runtimeCatalogs(true, known).then(
      (catalogs) => { for (const catalog of catalogs) this.apply(catalog); },
      () => undefined,
    ).finally(() => { if (this.listing === listing) this.listing = undefined; });
    this.listing = listing;
    return listing;
  }

  /** A catalog the host sent, asked for or not. */
  apply(catalog: UiRuntimeCatalog): void {
    this.put(catalog.kind, catalogEntry(catalog));
  }

  private put(kind: ThreadBackendKind, entry: RuntimeCatalogEntry): void {
    this.entries.set(kind, { entry, at: this.now() });
    this.view = new Map([...this.entries].map(([key, held]) => [key, held.entry]));
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The snapshot a draft bound for another runtime shows its composer: that
 * runtime's models and levels, with what the draft chose already applied.
 * Without a catalog the snapshot stays as it was, and the composer's pickers
 * stay off for the draft.
 */
export function draftRuntimeSnapshot(snapshot: HostSnapshot, draft: NewThreadDraft, runtime: ThreadBackendKind, entry: RuntimeCatalogEntry | undefined): HostSnapshot {
  if (entry?.status !== "ready") return snapshot;
  const { catalog } = entry;
  const chosen = (draft.selectionRuntime ?? "pi") === runtime;
  const model: UiModel | undefined = (chosen && draft.model && catalog.models.find((candidate) => candidate.id === draft.model!.id && candidate.provider === draft.model!.provider)) || catalog.model;
  const levels = model ? catalog.thinkingLevels[model.id] ?? [] : [];
  const level = chosen && draft.thinkingLevel && levels.includes(draft.thinkingLevel) ? draft.thinkingLevel : levels[0];
  const { contextUsage: _context, usage: _usage, model: _visible, ...rest } = snapshot;
  return {
    ...rest,
    backendKind: runtime,
    models: [...catalog.models],
    ...(model ? { model } : {}),
    thinkingLevel: level ?? "",
    thinkingLevels: [...levels],
    ...(catalog.runtimeCapabilities ? { runtimeCapabilities: catalog.runtimeCapabilities } : {}),
  };
}
