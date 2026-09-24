import { join } from "node:path";
import { readPersistedJson, writePersistedJson } from "tau/host-extension";
import { DEFAULT_MINI_PREFS, type PreviewDriver, type PreviewMiniPrefs } from "./protocol.js";
import { readMiniPrefs } from "./mini-prefs.js";

export { MINI_WIDTH_RANGE, readMiniPrefs } from "./mini-prefs.js";

const VERSION = 1;

/**
 * Who drives the preview or a window right now, so every client draws the
 * same thing, and where the floating preview sat for clients from before each
 * device kept its own (`<stateDir>/mini.json`; a new device starts from it).
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
