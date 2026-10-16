import { readdir } from "node:fs/promises";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { connectionFingerprint } from "./connection-consent.js";
import type { ServerFolderListing, ServerFolderMatch } from "./folder-protocol.js";
import { hasGitSegment, isSyncPath } from "./sync/paths.js";
import type { SyncService, SyncSession } from "./sync/service.js";
import type { ServersStore } from "./store.js";
import { readTargetFile, updateTargetFile } from "./target-settings.js";

/** A folder is read only when opened or when the person explicitly starts a bounded search. */
export class ServerFolders {
  constructor(private readonly store: ServersStore, private readonly sync: SyncService) {}

  async listing(session: SyncSession, path = ""): Promise<ServerFolderListing> {
    if (path && (!isSyncPath(path) || hasGitSegment(path))) throw new HostCommandError("Choose a folder below this server folder.");
    session.signal.throwIfAborted();
    const local = (await readdir(session.localDir, { withFileTypes: true })).filter((entry) => entry.name !== ".git" && entry.name !== ".DS_Store" && !entry.isSymbolicLink());
    const ignored = await session.ignore.files(local.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const ignoredDirs = await session.ignore.dirs(local.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const names = new Set(local.filter((entry) => !(entry.isDirectory() ? ignoredDirs : ignored).has(entry.name)).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`));
    const fs = await session.connect();
    const entries = (await fs.list(path, { area: "project", signal: session.signal }))
      .filter((entry) => isSyncPath(entry.name) && !entry.name.includes("/") && !entry.name.includes("\\") && entry.name !== ".git" && (entry.type === "file" || entry.type === "directory"))
      .map((entry) => ({ name: entry.name, directory: entry.type === "directory" }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { root: fs.root, path, entries, matches: entries.filter((entry) => names.has(`${entry.name}${entry.directory ? "/" : ""}`)).length, localItems: names.size };
  }

  async check(session: SyncSession): Promise<ServerFolderMatch | undefined> {
    const file = await readTargetFile(this.store, session.key);
    if (file.folderConfirmed === connectionFingerprint(session.target)) return undefined;
    const listing = await this.listing(session);
    // A genuinely empty destination is a valid first upload. Similarity is only a prompt, never proof.
    const weak = listing.entries.length > 0 && listing.localItems > 0 && listing.matches / listing.localItems < 1 / 3;
    if (!weak) await this.confirm(session);
    return { weak, listing };
  }

  async confirm(session: SyncSession): Promise<void> {
    session.signal.throwIfAborted();
    await updateTargetFile(this.store, session.key, (file) => ({ ...file, folderConfirmed: connectionFingerprint(session.target) }));
  }

  register(context: HostExtensionContext): void {
    const ref = (raw: unknown) => {
      const { cwd, targetId, operationId } = (raw ?? {}) as Record<string, unknown>;
      if (typeof cwd !== "string" || typeof targetId !== "string") throw new HostCommandError("Choose a project's server.");
      return { cwd, targetId, ...(typeof operationId === "string" ? { operationId } : {}) };
    };
    context.registerCommand("server-folder", (raw) => this.sync.exclusive(ref(raw), (session) => this.listing(session, typeof (raw as { path?: unknown }).path === "string" ? (raw as { path: string }).path : ""), { recover: false }), { long: true, access: "read" });
    context.registerCommand("confirm-server-folder", (raw) => this.sync.exclusive(ref(raw), async (session) => { await this.confirm(session); return { confirmed: true }; }, { recover: false }));
    context.registerCommand("find-server-folder", (raw) => this.sync.exclusive(ref(raw), async (session) => {
      const start = typeof (raw as { path?: unknown }).path === "string" ? (raw as { path: string }).path : "";
      const queue = [{ path: start, depth: 0 }];
      const candidates: ServerFolderListing[] = [];
      let opened = 0;
      while (queue.length && opened < 64) {
        session.signal.throwIfAborted();
        const next = queue.shift()!;
        const listing = await this.listing(session, next.path);
        opened++;
        if (listing.matches > 0) candidates.push(listing);
        if (next.depth < 2) for (const entry of listing.entries) {
          if (entry.directory && queue.length < 64) queue.push({ path: [next.path, entry.name].filter(Boolean).join("/"), depth: next.depth + 1 });
        }
      }
      return { candidates: candidates.sort((a, b) => b.matches - a.matches).slice(0, 5), opened, limited: queue.length > 0 };
    }, { recover: false }), { long: true, access: "read" });
  }
}
