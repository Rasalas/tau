import type { ClientStorage, HostExtensionClient } from "tau";

export const OFFLINE_REASON = "Offline. Connect to this machine to make changes.";
const KEY = "host:tau.review.offline.v1";
const MAX_LISTS = 8;
const MAX_REQUESTS = 12;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
// A phone keeps every paired machine's cache in one store of about 5 MB, beside the drafts that must still fit.
const COMPACT_MAX_BYTES = 512 * 1024;
const COMPACT_MAX_ENTRY_BYTES = 256 * 1024;
// Opening a request reads each of its files; their saves reach storage as one write.
const PERSIST_DELAY_MS = 2_000;
const READS = new Set(["pr-view", "pr-comments", "pr-checks", "pr-files", "pr-file", "pr-stack", "pr-pipeline", "pr-linked-threads"]);
const LISTS = new Set(["pr-list", "pr-list-many"]);

interface Entry { key: string; group: string; at: number; value: unknown }

/** The client's claim, not its width: a phone or tablet keeps a much smaller cache than a desktop window drawn narrow. */
function limits(): { total: number; entry: number } {
  const compact = typeof document !== "undefined" && document.body?.dataset.client === "compact";
  return compact ? { total: COMPACT_MAX_BYTES, entry: COMPACT_MAX_ENTRY_BYTES } : { total: MAX_BYTES, entry: MAX_ENTRY_BYTES };
}

function cacheKey(command: string, input: unknown): string {
  const args = { ...(input as Record<string, unknown>) };
  delete args.fresh;
  if (Array.isArray(args.workspaces)) args.workspaces = [...args.workspaces].sort();
  return JSON.stringify([command, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);
}

// Only request reads enter this store; never uploads, authentication or host metadata.
function encode(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => /^(token|accessToken|refreshToken|password|credentials|authorization|accessKey)$/iu.test(key) ? undefined : item);
}

/** A bounded cache in the platform's machine-scoped storage. */
export class PullRequestCache {
  private entries: Entry[] = [];
  private connected: boolean;
  private readonly detailReads = new Map<string, object>();
  private stopped = false;
  private persisted = false;
  private listeners = new Set<() => void>();
  /** Each entry as stored, so a write joins strings and the byte bound adds lengths instead of encoding the cache again. */
  private encoded = new WeakMap<Entry, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onHide = () => { if (document.visibilityState === "hidden") this.flush(); };

  constructor(private storage: ClientStorage | undefined, connected = true) {
    this.connected = connected;
    try {
      const raw = storage?.get(KEY);
      this.persisted = raw !== null && raw !== undefined;
      if (raw && raw.length * 2 <= MAX_BYTES) {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries)) this.entries = entries.filter((entry): entry is Entry =>
          entry && typeof entry.key === "string" && typeof entry.group === "string" && Number.isFinite(entry.at) && entry.at > 0 && entry.at <= 8.64e15 && "value" in entry);
        for (const entry of this.entries) this.encoded.set(entry, encode(entry));
      }
    } catch { /* An unreadable cache does not block a live read. */ }
    const loaded = this.entries.length;
    this.trim();
    // A cache saved under a larger bound gives its space back now, not at the next read.
    if (this.entries.length < loaded) this.persist();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onHide);
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  isConnected = () => this.connected;
  setConnected(connected: boolean) {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const listener of this.listeners) listener();
  }
  stop() {
    this.flush();
    this.stopped = true;
    this.listeners.clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onHide);
  }

  /** Writes a save that is still waiting; the window going to the background does it too. */
  flush() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.persist();
  }

  peek<T>(command: string, input: unknown): { value: T; at: number } | undefined {
    const key = cacheKey(command, input);
    const entry = this.entries.find((item) => item.key === key);
    return entry ? { value: entry.value as T, at: entry.at } : undefined;
  }

  savedAt(url: string): number | undefined {
    const times = this.entries.filter((entry) => entry.group === url).map((entry) => entry.at);
    return times.length ? Math.min(...times) : undefined;
  }

  private persist() {
    if (this.stopped) return;
    try {
      // A removed machine must stay forgotten even if a read finishes late; its key list says so without reading the cache back.
      if (this.persisted && this.storage && !this.storage.keys(KEY).includes(KEY)) { this.stopped = true; return; }
      this.storage?.set(KEY, `[${this.entries.map((entry) => this.encoded.get(entry) ?? encode(entry)).join(",")}]`);
      this.persisted = Boolean(this.storage);
    } catch { /* Storage quotas do not fail a successful read. */ }
  }

  /** The first save writes at once, so a removal after it is seen; later ones wait and go together. */
  private schedule() {
    if (!this.persisted) { this.persist(); return; }
    this.timer ??= setTimeout(() => { this.timer = undefined; this.persist(); }, PERSIST_DELAY_MS);
  }

  private save(command: string, input: unknown, value: unknown) {
    if (this.stopped) return;
    // List rows also read pipelines; those must not displace opened requests.
    if (command === "pr-pipeline" && !this.peek("pr-view", { url: (input as { url: string }).url })) return;
    const key = cacheKey(command, input);
    const group = LISTS.has(command) ? `list:${key}` : String((input as { url?: string }).url);
    const entry = { key, group, at: Date.now(), value };
    const encoded = encode(entry);
    this.entries = this.entries.filter((item) => item.key !== key);
    if (encoded.length * 2 <= limits().entry) {
      const stored = JSON.parse(encoded) as Entry;
      this.encoded.set(stored, encoded);
      this.entries.push(stored);
    }
    this.trim();
    this.schedule();
  }

  private trim() {
    const groups = [...new Set(this.entries.map((entry) => entry.group).reverse())];
    const kept = new Set([...groups.filter((group) => group.startsWith("list:")).slice(0, MAX_LISTS), ...groups.filter((group) => !group.startsWith("list:")).slice(0, MAX_REQUESTS)]);
    this.entries = this.entries.filter((entry) => kept.has(entry.group));
    // The stored array: its brackets, its commas and each entry's own encoding.
    const length = (entry: Entry) => (this.encoded.get(entry)?.length ?? encode(entry).length) + 1;
    let size = 1 + this.entries.reduce((sum, entry) => sum + length(entry), 0);
    const { total } = limits();
    while (size * 2 > total && this.entries.length) {
      const oldest = this.entries[0]!.group;
      for (const entry of this.entries) if (entry.group === oldest) size -= length(entry);
      this.entries = this.entries.filter((entry) => entry.group !== oldest);
    }
  }

  async invoke(host: HostExtensionClient, command: string, input?: unknown): Promise<unknown> {
    const cachedRead = READS.has(command) || LISTS.has(command);
    if (!this.connected) {
      if (!cachedRead) throw new Error(OFFLINE_REASON);
      const cached = this.peek(command, input);
      if (!cached) throw new Error("Offline. This request has not been saved on this device.");
      if (command === "pr-view") {
        const group = String((input as { url: string }).url);
        this.entries = [...this.entries.filter((entry) => entry.group !== group), ...this.entries.filter((entry) => entry.group === group)];
        this.schedule();
      }
      return cached.value;
    }
    const url = (input as { url?: string } | undefined)?.url;
    const detailRead = command === "pr-view" && url ? {} : undefined;
    if (detailRead && url) this.detailReads.set(url, detailRead);
    try {
      const result = await host.invoke(command, input);
      if (command === "pr-update" && url && (result as { ref?: { url?: string } } | null)?.ref?.url === url) {
        this.detailReads.delete(url);
        this.save("pr-view", { url }, result);
      }
      if (cachedRead && (!detailRead || !url || this.detailReads.get(url) === detailRead)) this.save(command, input, result);
      return result;
    } finally {
      if (url && detailRead && this.detailReads.get(url) === detailRead) this.detailReads.delete(url);
    }
  }
}
