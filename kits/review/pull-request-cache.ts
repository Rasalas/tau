import type { ClientStorage, HostExtensionClient } from "tau";

export const OFFLINE_REASON = "Offline. Connect to this machine to make changes.";
const KEY = "host:tau.review.offline.v1";
const MAX_LISTS = 8;
const MAX_REQUESTS = 12;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const READS = new Set(["pr-view", "pr-comments", "pr-checks", "pr-files", "pr-file", "pr-stack", "pr-pipeline", "pr-linked-threads"]);
const LISTS = new Set(["pr-list", "pr-list-many"]);

interface Entry { key: string; group: string; at: number; value: unknown }

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
  private stopped = false;
  private persisted = false;
  private listeners = new Set<() => void>();

  constructor(private storage: ClientStorage | undefined, connected = true) {
    this.connected = connected;
    try {
      const raw = storage?.get(KEY);
      this.persisted = raw !== null && raw !== undefined;
      if (raw && raw.length * 2 <= MAX_BYTES) {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries)) this.entries = entries.filter((entry): entry is Entry =>
          entry && typeof entry.key === "string" && typeof entry.group === "string" && Number.isFinite(entry.at) && entry.at > 0 && entry.at <= 8.64e15 && "value" in entry);
      }
    } catch { /* An unreadable cache does not block a live read. */ }
    this.trim();
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  isConnected = () => this.connected;
  setConnected(connected: boolean) {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const listener of this.listeners) listener();
  }
  stop() { this.stopped = true; this.listeners.clear(); }

  peek<T>(command: string, input: unknown): { value: T; at: number } | undefined {
    const entry = this.entries.find((item) => item.key === cacheKey(command, input));
    return entry ? { value: entry.value as T, at: entry.at } : undefined;
  }

  savedAt(url: string): number | undefined {
    const times = this.entries.filter((entry) => entry.group === url).map((entry) => entry.at);
    return times.length ? Math.min(...times) : undefined;
  }

  private persist() {
    if (this.stopped) return;
    try {
      // A removed machine must stay forgotten even if a read finishes late.
      if (this.persisted && this.storage?.get(KEY) === null) { this.stopped = true; return; }
      this.storage?.set(KEY, encode(this.entries));
      this.persisted = Boolean(this.storage);
    } catch { /* Storage quotas do not fail a successful read. */ }
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
    if (encoded.length * 2 <= MAX_ENTRY_BYTES) this.entries.push(JSON.parse(encoded) as Entry);
    this.trim();
    this.persist();
  }

  private trim() {
    const groups = [...new Set(this.entries.map((entry) => entry.group).reverse())];
    const kept = new Set([...groups.filter((group) => group.startsWith("list:")).slice(0, MAX_LISTS), ...groups.filter((group) => !group.startsWith("list:")).slice(0, MAX_REQUESTS)]);
    this.entries = this.entries.filter((entry) => kept.has(entry.group));
    while (encode(this.entries).length * 2 > MAX_BYTES) {
      const oldest = this.entries[0]!.group;
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
        this.persist();
      }
      return cached.value;
    }
    const result = await host.invoke(command, input);
    if (cachedRead) this.save(command, input, result);
    return result;
  }
}
