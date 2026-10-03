import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";
import { verifyReleaseSignature } from "./release-feed.js";

/**
 * Tau's signed model catalog (K124): models Pi's bundled list does not know
 * yet, published beside the website and signed with the release key, so a
 * new model reaches Pi without a Tau release. It only adds: a model Pi
 * already names keeps Pi's entry. Without a valid signature a download is
 * ignored; offline the last good one stays.
 */

export const MODEL_CATALOG_URL = "https://rasalas.github.io/tau/catalog/models.json";
const MAX_BYTES = 1_000_000;
const MAX_MODELS = 2_000;
const DAY_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const FILE_VERSION = 1;
const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface ModelCatalogPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCatalogEntry {
  /** Pi's provider id: `openai`, `openai-codex`, `anthropic`. */
  provider: string;
  id: string;
  name: string;
  /** A model of the same provider whose API, address and settings the new one shares; the provider's newest otherwise. */
  like?: string;
  contextWindow?: number;
  maxOutput?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  /** The Pi thinking levels it takes; the others are off. */
  thinkingLevels?: string[];
  /** US dollars per million tokens; without it the model shows no cost. */
  price?: ModelCatalogPrice;
  /** When it came out (YYYY-MM-DD). */
  since?: string;
  /** Where the facts come from (https). */
  source?: string;
}

export interface ModelCatalog {
  schema: 1;
  /** Only a higher revision replaces the one held. */
  revision: number;
  models: ModelCatalogEntry[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const amount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000_000;

function problem(where: string, what: string): never {
  throw new Error(`Model catalog: ${where} ${what}.`);
}

function parsePrice(value: unknown, where: string): ModelCatalogPrice {
  const price = record(value) ?? problem(where, "price must be an object");
  if (!amount(price.input, 10_000) || !amount(price.output, 10_000)) problem(where, "price needs input and output in dollars per million tokens");
  for (const key of ["cacheRead", "cacheWrite"] as const) if (price[key] !== undefined && !amount(price[key], 10_000)) problem(where, `price ${key} is not an amount`);
  return {
    input: price.input,
    output: price.output,
    ...(price.cacheRead !== undefined ? { cacheRead: price.cacheRead as number } : {}),
    ...(price.cacheWrite !== undefined ? { cacheWrite: price.cacheWrite as number } : {}),
  };
}

function parseEntry(value: unknown, index: number): ModelCatalogEntry {
  const where = `models[${index}]`;
  const entry = record(value) ?? problem(where, "is not an object");
  const known = new Set(["provider", "id", "name", "like", "contextWindow", "maxOutput", "input", "reasoning", "thinkingLevels", "price", "since", "source"]);
  for (const key of Object.keys(entry)) if (!known.has(key)) problem(where, `has an unknown field ${key}`);
  if (typeof entry.provider !== "string" || !ID.test(entry.provider)) problem(where, "needs a provider id");
  if (typeof entry.id !== "string" || !ID.test(entry.id)) problem(where, "needs a model id");
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120) problem(where, "needs a name");
  if (entry.like !== undefined && (typeof entry.like !== "string" || !ID.test(entry.like))) problem(where, "like is not a model id");
  if (entry.contextWindow !== undefined && !whole(entry.contextWindow)) problem(where, "contextWindow is not a token count");
  if (entry.maxOutput !== undefined && !whole(entry.maxOutput)) problem(where, "maxOutput is not a token count");
  if (entry.input !== undefined && (!Array.isArray(entry.input) || entry.input.length === 0 || entry.input.some((kind) => kind !== "text" && kind !== "image"))) problem(where, "input takes text and image");
  if (entry.reasoning !== undefined && typeof entry.reasoning !== "boolean") problem(where, "reasoning is true or false");
  if (entry.thinkingLevels !== undefined && (!Array.isArray(entry.thinkingLevels) || entry.thinkingLevels.some((level) => !(THINKING as readonly unknown[]).includes(level)))) problem(where, `thinkingLevels take ${THINKING.join(", ")}`);
  if (entry.since !== undefined && (typeof entry.since !== "string" || !DATE.test(entry.since))) problem(where, "since is not a date");
  if (entry.source !== undefined && (typeof entry.source !== "string" || !/^https:\/\/[^\s]+$/u.test(entry.source) || entry.source.length > 500)) problem(where, "source is not an https address");
  return {
    provider: entry.provider,
    id: entry.id,
    name: entry.name.trim(),
    ...(entry.like !== undefined ? { like: entry.like as string } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow as number } : {}),
    ...(entry.maxOutput !== undefined ? { maxOutput: entry.maxOutput as number } : {}),
    ...(entry.input !== undefined ? { input: [...entry.input as Array<"text" | "image">] } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning as boolean } : {}),
    ...(entry.thinkingLevels !== undefined ? { thinkingLevels: [...entry.thinkingLevels as string[]] } : {}),
    ...(entry.price !== undefined ? { price: parsePrice(entry.price, where) } : {}),
    ...(entry.since !== undefined ? { since: entry.since as string } : {}),
    ...(entry.source !== undefined ? { source: entry.source as string } : {}),
  };
}

/** The catalog in `text`, checked field by field; anything else throws. Only data, never code. */
export function parseModelCatalog(text: string): ModelCatalog {
  if (text.length > MAX_BYTES) problem("the file", `is larger than ${MAX_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    problem("the file", "is not JSON");
  }
  const catalog = record(json) ?? problem("the file", "is not an object");
  if (catalog.schema !== 1) problem("schema", "must be 1");
  if (!whole(catalog.revision)) problem("revision", "must be a positive whole number");
  if (!Array.isArray(catalog.models) || catalog.models.length > MAX_MODELS) problem("models", `must be a list of at most ${MAX_MODELS}`);
  const models = catalog.models.map(parseEntry);
  const seen = new Set<string>();
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) problem(key, "is listed twice");
    seen.add(key);
  }
  return { schema: 1, revision: catalog.revision, models };
}

/** A catalog whose signature one of `keys` made over exactly these bytes. */
export function verifyModelCatalog(text: string, signature: string, keys: readonly string[]): ModelCatalog {
  if (!verifyReleaseSignature(text, signature, keys)) throw new Error("The model catalog is not signed by Tau's release key.");
  return parseModelCatalog(text);
}

/**
 * The keys a host trusts for the catalog. A local test catalog
 * (`TAU_MODEL_CATALOG_URL`) may name the key it is signed with
 * (`TAU_MODEL_CATALOG_KEY`); the release keys then do not count.
 */
export function modelCatalogKeys(env: NodeJS.ProcessEnv, built: readonly string[]): readonly string[] {
  const key = env.TAU_MODEL_CATALOG_KEY?.trim();
  return env.TAU_MODEL_CATALOG_URL?.trim() && key ? [key] : built;
}

function modelFrom(template: Model<Api>, entry: ModelCatalogEntry): Model<Api> {
  let thinkingLevelMap = template.thinkingLevelMap;
  if (entry.thinkingLevels) {
    const taken = new Set(entry.thinkingLevels);
    thinkingLevelMap = { ...(template.thinkingLevelMap?.off !== undefined ? { off: template.thinkingLevelMap.off } : {}) };
    for (const level of THINKING) {
      if (!taken.has(level)) thinkingLevelMap[level] = null;
      else if (template.thinkingLevelMap?.[level] !== undefined) thinkingLevelMap[level] = template.thinkingLevelMap[level];
    }
  }
  const { price } = entry;
  return {
    ...template,
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow ?? template.contextWindow,
    maxTokens: entry.maxOutput ?? template.maxTokens,
    input: entry.input ?? template.input,
    reasoning: entry.reasoning ?? template.reasoning,
    // Zero is Pi's "unknown": a model without a price shows none rather than the template's.
    cost: { input: price?.input ?? 0, output: price?.output ?? 0, cacheRead: price?.cacheRead ?? 0, cacheWrite: price?.cacheWrite ?? 0 },
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/** The catalog's models for `provider` that it does not list itself, built on one of its own. */
export function catalogModelsFor(provider: Pick<Provider, "id" | "getModels">, catalog: ModelCatalog | undefined, known: readonly Model<Api>[] = provider.getModels()): Model<Api>[] {
  if (!catalog || known.length === 0) return [];
  return catalog.models.flatMap((entry) => {
    if (entry.provider !== provider.id || known.some((model) => model.id === entry.id)) return [];
    const template = (entry.like ? known.find((model) => model.id === entry.like) : undefined) ?? known.at(-1)!;
    return [modelFrom(template, entry)];
  });
}

const originals = new WeakMap<Provider, Provider>();

/**
 * The provider with the catalog's models after its own, read each time so a
 * list the provider refreshes (Pi's own remote catalog) keeps winning.
 * Undefined when the catalog adds nothing to it.
 */
export function withModelCatalog(provider: Provider, catalog: ModelCatalog | undefined): Provider | undefined {
  const base = originals.get(provider) ?? provider;
  if (!catalog?.models.some((entry) => entry.provider === base.id)) return undefined;
  const wrapped: Provider = {
    ...base,
    getModels: () => {
      const own = base.getModels();
      return [...own, ...catalogModelsFor(base, catalog, own)];
    },
    getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()), ...catalogModelsFor(base, catalog)],
  };
  originals.set(wrapped, base);
  return wrapped;
}

/** The provider as Pi built it, without what `withModelCatalog` added. */
export function withoutModelCatalog(provider: Provider): Provider {
  return originals.get(provider) ?? provider;
}

/** When a catalog model came out, by id, for the "new" marks. */
export function catalogReleaseDate(catalog: ModelCatalog | undefined, id: string): string | undefined {
  return catalog?.models.find((entry) => entry.id === id && entry.since)?.since;
}

interface Held {
  text: string;
  signature: string;
  checkedAt: number;
}

function decodeHeld(value: unknown): Held | undefined {
  const item = record(value);
  if (!item || typeof item.text !== "string" || typeof item.signature !== "string") return undefined;
  return { text: item.text, signature: item.signature, checkedAt: typeof item.checkedAt === "number" ? item.checkedAt : 0 };
}

export interface SignedModelCatalogOptions {
  keys: readonly string[];
  /** The last good catalog and its signature, checked again on every read. */
  file?: string;
  url?: string;
  fetch?: typeof globalThis.fetch;
  now?(): number;
  maxAgeMs?: number;
  log(label: string, detail?: string): void;
}

/**
 * The catalog this host uses: the last good file from disk at once, a fresh
 * one from the website at most once a day. A download without a valid
 * signature, one that does not parse, or one with a lower revision leaves the
 * held catalog in place.
 */
export class SignedModelCatalog {
  private held?: { catalog: ModelCatalog; checkedAt: number };
  private loaded?: Promise<void>;
  private refreshing?: Promise<boolean>;

  constructor(private readonly options: SignedModelCatalogOptions) {}

  current(): ModelCatalog | undefined {
    return this.held?.catalog;
  }

  load(): Promise<void> {
    const file = this.options.file;
    return this.loaded ??= !file ? Promise.resolve() : readPersistedJson(file, { expectedVersion: FILE_VERSION, decode: decodeHeld, logger: { warn: () => undefined } }).then((read) => {
      const saved = read?.data;
      if (!saved || this.held) return;
      try {
        this.held = { catalog: verifyModelCatalog(saved.text, saved.signature, this.options.keys), checkedAt: saved.checkedAt };
      } catch (error) {
        this.options.log("model-catalog.disk-refused", error instanceof Error ? error.message : String(error));
      }
    }, () => undefined);
  }

  /** Fetches when the held one is a day old (or `force`); true when a newer revision came in. */
  refresh(force = false): Promise<boolean> {
    return this.refreshing ??= this.fetchNewer(force).finally(() => { this.refreshing = undefined; });
  }

  private async fetchNewer(force: boolean): Promise<boolean> {
    await this.load();
    const now = (this.options.now ?? Date.now)();
    if (!force && this.held && now - this.held.checkedAt < (this.options.maxAgeMs ?? DAY_MS)) return false;
    const url = this.options.url ?? MODEL_CATALOG_URL;
    const fetcher = this.options.fetch ?? globalThis.fetch;
    try {
      const [text, signature] = await Promise.all([bounded(fetcher, url), bounded(fetcher, `${url}.sig`)]);
      const catalog = verifyModelCatalog(text, signature, this.options.keys);
      const held = this.held?.catalog;
      if (held && catalog.revision < held.revision) throw new Error(`revision ${catalog.revision} is older than the held ${held.revision}`);
      const newer = !held || catalog.revision > held.revision;
      this.held = { catalog: newer ? catalog : held, checkedAt: now };
      if (this.options.file) {
        const saved = newer ? { text, signature, checkedAt: now } : undefined;
        if (saved) await writePersistedJson(this.options.file, FILE_VERSION, saved, { logger: { warn: () => undefined } }).catch(() => undefined);
      }
      if (newer) this.options.log("model-catalog.revision", `${catalog.revision}: ${catalog.models.length} models`);
      return newer;
    } catch (error) {
      this.options.log("model-catalog.refused", error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

async function bounded(fetcher: typeof globalThis.fetch, url: string): Promise<string> {
  if (url.startsWith("file:")) return readFile(new URL(url), "utf8");
  const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json, text/plain" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
  return text;
}
