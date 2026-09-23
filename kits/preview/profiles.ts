import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import { DEFAULT_PREVIEW_PROFILE, type PreviewProfiles } from "./protocol.js";

const VERSION = 1;
const MAX_PROFILES = 20;

/** The partition the default profile always had, so its cookies survive the feature. */
const DEFAULT_PARTITION = "persist:tau-preview";

/**
 * A profile name as a partition can carry it: lower case, digits and dashes,
 * 32 at most. Answers `undefined` for a name with nothing usable in it.
 */
export function normalizeProfileName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const name = input.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);
  return name || undefined;
}

/** `persist:` keeps a profile's cookies and storage on disk across restarts. */
export function profilePartition(name: string): string {
  return name === DEFAULT_PREVIEW_PROFILE ? DEFAULT_PARTITION : `${DEFAULT_PARTITION}-${name}`;
}

const MAX_NAME = 40;

/** A name as the user wrote it, trimmed and cut to 40 characters. */
function displayName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const name = input.replace(/\s+/gu, " ").trim().slice(0, MAX_NAME);
  return name || undefined;
}

function decode(value: unknown): PreviewProfiles | undefined {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listed = Array.isArray(fields.profiles) ? fields.profiles : [];
  const profiles = [...new Set([DEFAULT_PREVIEW_PROFILE, ...listed.flatMap((name) => normalizeProfileName(name) ?? [])])].slice(0, MAX_PROFILES);
  const active = normalizeProfileName(fields.active);
  const stored = fields.names && typeof fields.names === "object" ? fields.names as Record<string, unknown> : {};
  const names = Object.fromEntries(profiles.flatMap((id) => {
    const name = displayName(stored[id]);
    return name && name !== id ? [[id, name]] : [];
  }));
  return { profiles, active: active && profiles.includes(active) ? active : DEFAULT_PREVIEW_PROFILE, ...(Object.keys(names).length > 0 ? { names } : {}) };
}

/** The profiles the user made and the one in use, in `<stateDir>/profiles.json`. */
export class PreviewProfileStore {
  private state: PreviewProfiles = { profiles: [DEFAULT_PREVIEW_PROFILE], active: DEFAULT_PREVIEW_PROFILE };

  private loaded: Promise<void> | undefined;

  constructor(private readonly stateDir: string) {}

  private get file(): string {
    return join(this.stateDir, "profiles.json");
  }

  async read(): Promise<PreviewProfiles> {
    this.loaded ??= readPersistedJson<PreviewProfiles>(this.file, { expectedVersion: VERSION, decode })
      .then((read) => { if (read) this.state = read.data; })
      .catch(() => undefined);
    await this.loaded;
    return this.snapshot();
  }

  snapshot(): PreviewProfiles {
    const names = this.state.names ? { ...this.state.names } : undefined;
    return { profiles: [...this.state.profiles], active: this.state.active, ...(names ? { names } : {}) };
  }

  private async save(): Promise<PreviewProfiles> {
    if (this.stateDir) await writePersistedJson(this.file, VERSION, { ...this.snapshot() }).catch(() => undefined);
    return this.snapshot();
  }

  /**
   * Switches to a profile by id or by the name the user gave it; a name that
   * is neither makes a new profile, whose id comes from the name.
   */
  async use(input: unknown): Promise<PreviewProfiles> {
    await this.read();
    const named = displayName(input);
    const byName = named ? Object.entries(this.state.names ?? {}).find(([, name]) => name.toLowerCase() === named.toLowerCase())?.[0] : undefined;
    const id = byName ?? normalizeProfileName(input);
    if (!id) throw new Error("A profile needs a name of letters, digits or dashes.");
    const created = !this.state.profiles.includes(id);
    const profiles = created ? [...this.state.profiles, id] : this.state.profiles;
    if (profiles.length > MAX_PROFILES) throw new Error(`Preview keeps ${MAX_PROFILES} profiles at most.`);
    const names = { ...this.state.names };
    if (created && named && named !== id) names[id] = named;
    this.state = { profiles, active: id, ...(Object.keys(names).length > 0 ? { names } : {}) };
    return this.save();
  }

  /** Renames a profile; its id, and with it its cookies and storage, stay. */
  async rename(idInput: unknown, nameInput: unknown): Promise<PreviewProfiles> {
    await this.read();
    const id = normalizeProfileName(idInput);
    if (!id || !this.state.profiles.includes(id)) throw new Error("There is no such profile.");
    const name = displayName(nameInput);
    if (!name) throw new Error("A profile needs a name.");
    const taken = this.state.profiles.some((other) => other !== id && (this.state.names?.[other] ?? other).toLowerCase() === name.toLowerCase());
    if (taken) throw new Error(`A profile is already called “${name}”.`);
    const names = { ...this.state.names };
    if (name === id) delete names[id];
    else names[id] = name;
    this.state = { ...this.state, names };
    return this.save();
  }

  /** Forgets a profile; the default one stays. The caller clears its partition. */
  async remove(idInput: unknown): Promise<PreviewProfiles> {
    await this.read();
    const id = normalizeProfileName(idInput);
    if (id === DEFAULT_PREVIEW_PROFILE) throw new Error("The default profile cannot be deleted.");
    if (!id || !this.state.profiles.includes(id)) throw new Error("There is no such profile.");
    const names = { ...this.state.names };
    delete names[id];
    this.state = {
      profiles: this.state.profiles.filter((other) => other !== id),
      active: this.state.active === id ? DEFAULT_PREVIEW_PROFILE : this.state.active,
      ...(Object.keys(names).length > 0 ? { names } : {}),
    };
    return this.save();
  }
}

