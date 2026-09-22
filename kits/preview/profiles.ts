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

function decode(value: unknown): PreviewProfiles | undefined {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listed = Array.isArray(fields.profiles) ? fields.profiles : [];
  const profiles = [...new Set([DEFAULT_PREVIEW_PROFILE, ...listed.flatMap((name) => normalizeProfileName(name) ?? [])])].slice(0, MAX_PROFILES);
  const active = normalizeProfileName(fields.active);
  return { profiles, active: active && profiles.includes(active) ? active : DEFAULT_PREVIEW_PROFILE };
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
    return { profiles: [...this.state.profiles], active: this.state.active };
  }

  /** Switches to a profile, making it first if it is new. */
  async use(input: unknown): Promise<PreviewProfiles> {
    const name = normalizeProfileName(input);
    if (!name) throw new Error("A profile needs a name of letters, digits or dashes.");
    await this.read();
    const profiles = this.state.profiles.includes(name) ? this.state.profiles : [...this.state.profiles, name];
    if (profiles.length > MAX_PROFILES) throw new Error(`Preview keeps ${MAX_PROFILES} profiles at most.`);
    this.state = { profiles, active: name };
    if (this.stateDir) await writePersistedJson(this.file, VERSION, { ...this.state }).catch(() => undefined);
    return this.snapshot();
  }
}
