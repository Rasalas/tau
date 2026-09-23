import type {
  RuntimeCapabilities,
  ThreadBackendKind,
  UiModel,
  UiModelPrice,
  UiRuntimeCatalog,
  UiRuntimeCatalogStatus,
} from "../shared/contracts.js";
import type { HostCatalogModel, HostRuntimeNewThreadCatalog } from "./host-extensions.js";
import type { ModelPriceBook } from "./model-price-book.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/** 2 keeps `apiModelId`; a version-1 answer is served but asked again as if old. */
const VERSION = 2;
/** A client that opens a picker gets an answer this old as it is; an older one is asked again behind it. */
const FRESH_MS = 10 * 60_000;
/** At start an answer from disk younger than this stands; the programs are not started for it. */
const START_MAX_AGE_MS = 12 * 60 * 60_000;
/** Start-up has the machine to itself for this long. */
const START_DELAY_MS = 5_000;
/** A runtime that has not named its models by then is unavailable for now. */
const ASK_TIMEOUT_MS = 30_000;

/** One runtime that can say what a new thread of it may start on. */
export interface RuntimeCatalogSource {
  readonly kind: ThreadBackendKind;
  /** Who answers; a kind registered anew (another setup of its program) is asked again. */
  readonly owner: object;
  readonly capabilities?: RuntimeCapabilities;
  /** The answer already carries price and limits; the book is not consulted. */
  readonly complete?: boolean;
  load(): Promise<HostRuntimeNewThreadCatalog | undefined>;
}

export interface RuntimeCatalogsOptions {
  sources(): readonly RuntimeCatalogSource[];
  /** Pi's model data, for what a backend leaves out; undefined leaves it out. */
  priceBook(): Promise<ModelPriceBook | undefined>;
  /** Every client hears a catalog that changed. */
  publish(catalog: UiRuntimeCatalog): void;
  /** Where the catalogs outlive the process; memory only without one. */
  file?: string;
  /** Whether `start` asks the runtimes in the background; otherwise only clients make it ask. */
  automatic: boolean;
  log(label: string, detail?: string): void;
  logger?: PersistedJsonLogger;
  now?(): number;
  freshMs?: number;
  startMaxAgeMs?: number;
  startDelayMs?: number;
  timeoutMs?: number;
}

/** A catalog as the host holds it: each model keeps the provider's own id behind an alias, which clients never get. */
export type HeldRuntimeCatalog = Omit<UiRuntimeCatalog, "models" | "model"> & { models: HostCatalogModel[]; model?: HostCatalogModel };

interface Held {
  catalog: HeldRuntimeCatalog;
  /** When the runtime was last asked; `catalog.checkedAt` stays at the answer that last changed it. */
  askedAt: number;
  /** Undefined for an answer read from disk. */
  owner?: object;
}

/**
 * What every runtime offers a thread that does not exist yet, held by the
 * host in memory and on disk: a client gets it at once, stale or not, and a
 * stale one is asked again behind it (stale-while-revalidate). Programs are
 * asked one at a time in the background after start-up, and a catalog is
 * published only when it changed.
 */
export class RuntimeCatalogs {
  private readonly held = new Map<ThreadBackendKind, Held>();
  private readonly asking = new Map<ThreadBackendKind, Promise<HeldRuntimeCatalog>>();
  private restored?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private warmed = false;
  private disposed = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeCatalogsOptions) {}

  /**
   * Every registered runtime's catalog on hand, less those a client already
   * holds (`known`: kind to `checkedAt`); `revalidate` asks again, without
   * waiting, those that are no longer fresh.
   */
  async list(revalidate = false, known: Readonly<Record<string, number>> = {}): Promise<UiRuntimeCatalog[]> {
    await this.restore();
    const sources = this.options.sources();
    if (revalidate) for (const source of sources) if (this.stale(source, this.options.freshMs ?? FRESH_MS)) this.askLater(source);
    return sources.flatMap((source) => {
      const held = this.held.get(source.kind);
      const sent = held?.catalog.checkedAt !== undefined && known[source.kind] === held.catalog.checkedAt;
      return held && !sent ? [served(held.catalog, source)] : [];
    });
  }

  /** One runtime's catalog: what is held, revalidated when stale; asked and awaited when nothing is. */
  async get(kind: ThreadBackendKind): Promise<UiRuntimeCatalog | undefined> {
    await this.restore();
    const source = this.options.sources().find((candidate) => candidate.kind === kind);
    if (!source) return undefined;
    const held = this.held.get(kind);
    if (!held) return served(await this.ask(source), source);
    if (this.stale(source, this.options.freshMs ?? FRESH_MS)) this.askLater(source);
    return served(held.catalog, source);
  }

  /** Every catalog on hand, as held (with `apiModelId`); nothing is asked. */
  async onHand(): Promise<HeldRuntimeCatalog[]> {
    await this.restore();
    return [...this.held.values()].map((entry) => entry.catalog);
  }

  /** Reads the disk and, once start-up is over, asks every runtime whose answer is missing or old. */
  start(): void {
    void this.restore();
    if (!this.options.automatic || this.timer || this.warmed || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.warmed = true;
      void this.warm();
    }, this.options.startDelayMs ?? START_DELAY_MS);
    this.timer.unref?.();
  }

  /** Asks one runtime again now, however fresh its answer: what it may run on changed (a sign-in). */
  recheck(kind: ThreadBackendKind): void {
    const source = this.options.sources().find((candidate) => candidate.kind === kind);
    if (source && !this.disposed) this.askLater(source);
  }

  /** A backend registered or went; after start-up a new one is asked at once. */
  sourcesChanged(): void {
    if (this.warmed && !this.disposed) void this.warm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async warm(): Promise<void> {
    await this.restore();
    // One at a time: each may start its program.
    for (const source of this.options.sources()) {
      if (this.disposed) return;
      if (this.stale(source, this.options.startMaxAgeMs ?? START_MAX_AGE_MS)) await this.ask(source).catch(() => undefined);
    }
  }

  private stale(source: RuntimeCatalogSource, maxAgeMs: number): boolean {
    const held = this.held.get(source.kind);
    if (!held || (held.owner !== undefined && held.owner !== source.owner)) return true;
    return this.now() - held.askedAt >= maxAgeMs;
  }

  private askLater(source: RuntimeCatalogSource): void {
    void this.ask(source).catch(() => undefined);
  }

  private ask(source: RuntimeCatalogSource): Promise<HeldRuntimeCatalog> {
    const running = this.asking.get(source.kind);
    if (running) return running;
    const asked = this.answer(source).finally(() => {
      if (this.asking.get(source.kind) === asked) this.asking.delete(source.kind);
    });
    this.asking.set(source.kind, asked);
    return asked;
  }

  private async answer(source: RuntimeCatalogSource): Promise<HeldRuntimeCatalog> {
    const checkedAt = this.now();
    let next: HeldRuntimeCatalog;
    try {
      next = await this.normalized(source, await this.bounded(source), checkedAt);
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      this.options.log("runtime-catalog.failed", `${source.kind}: ${note}`);
      // A runtime that failed once keeps the models it named last; the note says why they may be old.
      const previous = this.held.get(source.kind)?.catalog;
      next = previous && previous.models.length > 0
        ? { ...previous, status: "unavailable", note, checkedAt }
        : { kind: source.kind, models: [], thinkingLevels: {}, status: "unavailable", note, checkedAt };
    }
    return this.keep(source, next);
  }

  private bounded(source: RuntimeCatalogSource): Promise<HostRuntimeNewThreadCatalog | undefined> {
    const timeoutMs = this.options.timeoutMs ?? ASK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`It did not name its models within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([source.load(), timeout]).finally(() => clearTimeout(timer));
  }

  private async normalized(source: RuntimeCatalogSource, answer: HostRuntimeNewThreadCatalog | undefined, checkedAt: number): Promise<HeldRuntimeCatalog> {
    const kind = source.kind;
    if (!answer) return { kind, models: [], thinkingLevels: {}, status: "unavailable", checkedAt };
    const { models, model, ...rest } = answer;
    // Nothing a runtime that cannot run offers is worth listing.
    if (rest.status === "not-installed" || rest.status === "sign-in-required") return { ...rest, kind, models: [], thinkingLevels: {}, checkedAt };
    const book = source.complete || models.length === 0 ? undefined : await this.options.priceBook().catch(() => undefined);
    const shown = (entry: HostCatalogModel): HostCatalogModel => {
      const filled = book ? book.enrich(entry) : withoutApiModelId(entry);
      return entry.apiModelId ? { ...filled, apiModelId: entry.apiModelId } : filled;
    };
    return { ...rest, kind, models: models.map(shown), ...(model ? { model: shown(model) } : {}), checkedAt };
  }

  private keep(source: RuntimeCatalogSource, next: HeldRuntimeCatalog): HeldRuntimeCatalog {
    const previous = this.held.get(source.kind)?.catalog;
    // An unchanged answer keeps its `checkedAt`, so a client that holds it is sent nothing.
    const catalog = previous && sameCatalog(previous, next) ? previous : next;
    this.held.set(source.kind, { catalog, askedAt: next.checkedAt ?? this.now(), owner: source.owner });
    if (catalog === next) this.options.publish(served(next, source));
    this.persist();
    return catalog;
  }

  private restore(): Promise<void> {
    const file = this.options.file;
    return this.restored ??= !file ? Promise.resolve() : readPersistedJson(file, {
      expectedVersion: VERSION,
      decode: decodeCatalogs,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    }).then((read) => {
      // An answer that came in while the file was read is newer than the file.
      const outdated = (read?.version ?? VERSION) < VERSION;
      for (const { catalog, askedAt } of read?.data ?? []) if (!this.held.has(catalog.kind)) this.held.set(catalog.kind, { catalog, askedAt: outdated ? 0 : askedAt });
    }, () => undefined);
  }

  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    this.writing = this.writing
      .then(() => {
        const held = [...this.held.values()];
        const askedAt = Object.fromEntries(held.map((entry) => [entry.catalog.kind, entry.askedAt]));
        return writePersistedJson(file, VERSION, { catalogs: held.map((entry) => entry.catalog), askedAt }, this.options.logger ? { logger: this.options.logger } : {});
      })
      .catch(() => undefined);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function served(catalog: HeldRuntimeCatalog, source: RuntimeCatalogSource): UiRuntimeCatalog {
  const { models, model, ...rest } = catalog;
  return {
    ...rest,
    models: models.map(withoutApiModelId),
    ...(model ? { model: withoutApiModelId(model) } : {}),
    ...(source.capabilities ? { runtimeCapabilities: source.capabilities } : {}),
  };
}

function withoutApiModelId(model: HostCatalogModel): UiModel {
  const { apiModelId: _id, ...shown } = model;
  return shown;
}

function sameCatalog(left: HeldRuntimeCatalog, right: HeldRuntimeCatalog): boolean {
  const { checkedAt: _left, ...a } = left;
  const { checkedAt: _right, ...b } = right;
  return JSON.stringify(a) === JSON.stringify(b);
}

const STATUSES = new Set<UiRuntimeCatalogStatus>(["not-installed", "sign-in-required", "unavailable"]);
const BILLING = new Set(["subscription", "api-key", "free", "local"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function decodePrice(value: unknown): UiModelPrice | undefined {
  const item = record(value);
  if (!item || !count(item.input) || !count(item.output)) return undefined;
  return {
    input: item.input,
    output: item.output,
    ...(count(item.cacheRead) ? { cacheRead: item.cacheRead } : {}),
    ...(count(item.cacheWrite) ? { cacheWrite: item.cacheWrite } : {}),
  };
}

function decodeModel(value: unknown): HostCatalogModel | undefined {
  const item = record(value);
  if (!item || !text(item.provider) || !text(item.id) || !text(item.name)) return undefined;
  const price = decodePrice(item.price);
  return {
    provider: item.provider,
    id: item.id,
    name: item.name,
    ...(item.login === "subscription" ? { login: "subscription" as const } : {}),
    ...(typeof item.billing === "string" && BILLING.has(item.billing) ? { billing: item.billing as UiModel["billing"] } : {}),
    ...(price ? { price } : {}),
    ...(count(item.contextWindow) ? { contextWindow: item.contextWindow } : {}),
    ...(count(item.maxOutput) ? { maxOutput: item.maxOutput } : {}),
    ...(typeof item.images === "boolean" ? { images: item.images } : {}),
    ...(typeof item.reasoning === "boolean" ? { reasoning: item.reasoning } : {}),
    ...(text(item.apiModelId) ? { apiModelId: item.apiModelId } : {}),
  };
}

function decodeCatalog(value: unknown): HeldRuntimeCatalog | undefined {
  const item = record(value);
  if (!item || !text(item.kind) || !Array.isArray(item.models)) return undefined;
  const levels = record(item.thinkingLevels) ?? {};
  const model = decodeModel(item.model);
  return {
    kind: item.kind,
    models: item.models.flatMap((entry) => decodeModel(entry) ?? []),
    ...(model ? { model } : {}),
    thinkingLevels: Object.fromEntries(Object.entries(levels).flatMap(([id, list]) => Array.isArray(list) ? [[id, list.filter(text)]] : [])),
    ...(text(item.note) ? { note: item.note } : {}),
    ...(typeof item.status === "string" && STATUSES.has(item.status as UiRuntimeCatalogStatus) ? { status: item.status as UiRuntimeCatalogStatus } : {}),
    ...(count(item.checkedAt) ? { checkedAt: item.checkedAt } : {}),
  };
}

/** The file as written by `persist`; entries it cannot read are left out. */
export function decodeCatalogs(value: unknown): Array<{ catalog: HeldRuntimeCatalog; askedAt: number }> | undefined {
  const list = record(value)?.catalogs;
  const asked = record(record(value)?.askedAt) ?? {};
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((entry) => {
    const catalog = decodeCatalog(entry);
    if (!catalog) return [];
    const askedAt = asked[catalog.kind];
    return [{ catalog, askedAt: count(askedAt) ? askedAt : catalog.checkedAt ?? 0 }];
  });
}
