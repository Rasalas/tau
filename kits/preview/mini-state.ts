import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import { DEFAULT_MINI_PREFS, type PreviewDriver, type PreviewMiniCorner, type PreviewMiniPrefs } from "./protocol.js";

const VERSION = 1;
export const MINI_WIDTH_RANGE = { min: 160, max: 560 } as const;
const CORNERS: readonly PreviewMiniCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function readMiniPrefs(value: unknown, base: PreviewMiniPrefs = DEFAULT_MINI_PREFS): PreviewMiniPrefs {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const corner = CORNERS.find((candidate) => candidate === fields.corner) ?? base.corner;
  const width = typeof fields.width === "number" && Number.isFinite(fields.width)
    ? Math.round(Math.min(MINI_WIDTH_RANGE.max, Math.max(MINI_WIDTH_RANGE.min, fields.width)))
    : base.width;
  return { corner, width };
}

/**
 * Who drives the preview or a window right now, and where the floating
 * preview sits. The host holds both so every client draws the same thing; the
 * corner and width outlive a restart in `<stateDir>/mini.json`.
 */
export class PreviewMiniState {
  private prefs: PreviewMiniPrefs = DEFAULT_MINI_PREFS;

  private current: PreviewDriver | undefined;

  private loaded: Promise<void> | undefined;

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  private get file(): string {
    return join(this.stateDir, "mini.json");
  }

  async load(): Promise<PreviewMiniPrefs> {
    this.loaded ??= this.stateDir
      ? readPersistedJson<PreviewMiniPrefs>(this.file, { expectedVersion: VERSION, decode: (value) => readMiniPrefs(value) })
        .then((read) => { if (read) this.prefs = read.data; })
        .catch(() => undefined)
      : Promise.resolve();
    await this.loaded;
    return this.prefs;
  }

  miniPrefs(): PreviewMiniPrefs {
    return this.prefs;
  }

  driver(): PreviewDriver | undefined {
    return this.current;
  }

  /** Answers whether anything a client draws changed. */
  drive(threadId: string, source: PreviewDriver["source"]): boolean {
    const previous = this.current;
    if (previous && previous.threadId === threadId && previous.source === source) return false;
    // Another thread or the other surface is a new drive; a hidden player shows again.
    this.current = { threadId, source, since: this.now() };
    return true;
  }

  /** The thread's turn ended: nothing is driven any more. */
  release(threadId: string): boolean {
    if (this.current?.threadId !== threadId) return false;
    this.current = undefined;
    return true;
  }

  dismiss(): boolean {
    if (!this.current || this.current.dismissed) return false;
    this.current = { ...this.current, dismissed: true };
    return true;
  }

  async setPrefs(input: unknown): Promise<PreviewMiniPrefs> {
    await this.load();
    this.prefs = readMiniPrefs(input, this.prefs);
    if (this.stateDir) await writePersistedJson(this.file, VERSION, { ...this.prefs }).catch(() => undefined);
    return this.prefs;
  }
}
