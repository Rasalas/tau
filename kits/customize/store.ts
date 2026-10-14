import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CUSTOMIZE_LIMITS, EMPTY_STATE, type CustomizeState, type UserScript, type UserScriptTarget, type UserStyle } from "./protocol.js";

/** Why a write was refused; the text goes back to the client. */
export class CustomizeError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
// Part names and placements are `kind:id[/Field]` or a placement word; nothing that could leave a selector.
const NAME = /^[a-z][a-z-]*(?::[A-Za-z0-9_.:@-]+(?:\/[A-Za-z]+)?)?$/u;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CustomizeError(`${what} is malformed.`);
  return value as Record<string, unknown>;
}

function name(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > CUSTOMIZE_LIMITS.nameLength || !NAME.test(value)) throw new CustomizeError(`${what} is not a part name.`);
  return value;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw new CustomizeError(`${what} is missing.`);
  if (Buffer.byteLength(value) > max) throw new CustomizeError(`${what} is larger than ${Math.round(max / 1024)} KiB.`);
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new CustomizeError("An entry has no valid id.");
  return value;
}

function label(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : "Untitled";
}

function names(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CUSTOMIZE_LIMITS.names) throw new CustomizeError("hidden is malformed.");
  return [...new Set(value.map((entry) => name(entry, "A hidden part")))];
}

function numbers(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record(value, "order")).slice(0, CUSTOMIZE_LIMITS.names)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[name(key, "An ordered part")] = raw;
  }
  return out;
}

function placements(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record(value, "placement")).slice(0, CUSTOMIZE_LIMITS.names)) {
    out[name(key, "A moved part")] = name(raw, "A placement");
  }
  return out;
}

function style(value: unknown): UserStyle {
  const entry = record(value, "A style");
  return { id: id(entry.id), name: label(entry.name), css: text(entry.css, "A style", CUSTOMIZE_LIMITS.styleBytes), enabled: entry.enabled !== false };
}

function target(value: unknown): UserScriptTarget {
  const entry = record(value, "A script's target");
  if (entry.replace !== undefined) return { replace: name(entry.replace, "A script's part") };
  const placement = name(entry.placement, "A script's placement");
  return typeof entry.order === "number" && Number.isFinite(entry.order) ? { placement, order: entry.order } : { placement };
}

function script(value: unknown, previous: UserScript | undefined): UserScript {
  const entry = record(value, "A script");
  const html = text(entry.html, "A script", CUSTOMIZE_LIMITS.scriptBytes);
  const out: UserScript = {
    id: id(entry.id),
    name: label(entry.name),
    enabled: entry.enabled !== false,
    target: target(entry.target),
    html,
    revision: previous ? previous.revision + (previous.html === html ? 0 : 1) : 1,
  };
  if (typeof entry.maxHeight === "number" && entry.maxHeight >= 24 && entry.maxHeight <= 2000) out.maxHeight = Math.round(entry.maxHeight);
  return out;
}

function unique<T extends { id: string }>(entries: T[], what: string): T[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new CustomizeError(`Two ${what} share the id ${entry.id}.`);
    seen.add(entry.id);
  }
  return entries;
}

/** A client's whole state, checked; `previous` keeps each script's revision. */
export function readState(value: unknown, previous: CustomizeState = EMPTY_STATE): CustomizeState {
  const input = record(value, "The customizations");
  const styles = input.styles === undefined ? [] : Array.isArray(input.styles) ? input.styles : undefined;
  const scripts = input.scripts === undefined ? [] : Array.isArray(input.scripts) ? input.scripts : undefined;
  if (!styles || styles.length > CUSTOMIZE_LIMITS.styles) throw new CustomizeError("styles is malformed.");
  if (!scripts || scripts.length > CUSTOMIZE_LIMITS.scripts) throw new CustomizeError("scripts is malformed.");
  const before = new Map(previous.scripts.map((entry) => [entry.id, entry]));
  const state: CustomizeState = {
    version: 1,
    hidden: names(input.hidden),
    order: numbers(input.order),
    placement: placements(input.placement),
    styles: unique(styles.map(style), "styles"),
    scripts: unique(scripts.map((entry) => script(entry, before.get(record(entry, "A script").id as string))), "scripts"),
  };
  if (Buffer.byteLength(JSON.stringify(state)) > CUSTOMIZE_LIMITS.totalBytes) throw new CustomizeError("The customizations are too large.");
  return state;
}

/** `customizations.json` in the kit's state folder, written atomically. */
export class CustomizeStore {
  private state: CustomizeState | undefined;

  constructor(private readonly file: string) {}

  async get(): Promise<CustomizeState> {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      // A file it cannot read starts empty rather than blocking the window; the next write replaces it.
      this.state = readState(raw);
      // A stored script keeps the revision it was written with.
      const stored = record(raw, "file").scripts;
      if (Array.isArray(stored)) {
        for (const entry of this.state.scripts) {
          const match = stored.find((item) => typeof item === "object" && item !== null && (item as { id?: unknown }).id === entry.id) as { revision?: unknown } | undefined;
          if (typeof match?.revision === "number") entry.revision = match.revision;
        }
      }
    } catch {
      this.state = EMPTY_STATE;
    }
    return this.state;
  }

  async set(value: unknown): Promise<CustomizeState> {
    const next = readState(value, await this.get());
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.state = next;
    return next;
  }
}
