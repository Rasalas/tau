import { randomUUID } from "node:crypto";
import { HostCommandError } from "tau/host-extension";
import type { ServersStore, TargetFileSpec } from "./store.js";
import { blobId, entryOf } from "./sync/mirror.js";
import { readLocalFile, removeLocalFile, writeLocalFile, type LocalFile } from "./sync/local.js";
import { hasGitSegment, isSyncPath } from "./sync/paths.js";
import type { SyncSession } from "./sync/service.js";

export interface LocalServerChange {
  id: string;
  path: string;
  workspace: string;
  at: string;
  before?: string;
  beforeMode?: number;
  after?: string;
  undone?: boolean;
  applied?: boolean;
}

interface LocalChangesFile extends Record<string, unknown> { changes: LocalServerChange[] }
export const LOCAL_CHANGES_FILE: TargetFileSpec<LocalChangesFile> = {
  name: "local-changes.json", version: 1,
  decode(value) {
    if (!value || typeof value !== "object" || !Array.isArray((value as LocalChangesFile).changes)) return undefined;
    const changes = (value as LocalChangesFile).changes.filter((change) => change && /^[a-f0-9-]{36}$/u.test(change.id) && typeof change.path === "string" && isSyncPath(change.path) && !hasGitSegment(change.path) && typeof change.workspace === "string" && typeof change.at === "string" && (!change.before || /^[a-f0-9]{40}$/u.test(change.before)) && (!change.after || /^[a-f0-9]{40}$/u.test(change.after)));
    return { changes };
  },
};

/** Keep the local backup reachable before replacing anything in the working tree. */
export async function saveLocalServerChange(store: ServersStore, session: SyncSession, path: string, before: LocalFile | undefined, after: Buffer | undefined): Promise<LocalServerChange> {
  await session.mirror.ensure();
  const entries = new Map();
  if (before) { await session.mirror.writeBlob(before.data); entries.set(`before/${path}`, entryOf(before.data, { mode: before.mode, mtime: 0 })); }
  if (after) { await session.mirror.writeBlob(after); entries.set(`after/${path}`, entryOf(after, { mode: 0o644, mtime: 0 })); }
  const id = randomUUID();
  const commit = await session.mirror.commit(Object.fromEntries(entries), `Local backup: ${path}`, null);
  await session.mirror.setRef(`refs/tau/local/${id}`, commit);
  const change: LocalServerChange = { id, path, workspace: session.workspace, at: new Date().toISOString(), ...(before ? { before: blobId(before.data), beforeMode: before.mode } : {}), ...(after ? { after: blobId(after) } : {}) };
  const changes = (await store.read(session.key, LOCAL_CHANGES_FILE))?.changes ?? [];
  await store.write(session.key, LOCAL_CHANGES_FILE, { changes: [...changes, change] });
  return change;
}

export async function undoLocalServerChange(store: ServersStore, session: SyncSession, id: string): Promise<void> {
  const changes = (await store.read(session.key, LOCAL_CHANGES_FILE))?.changes ?? [];
  const change = changes.find((item) => item.id === id && item.workspace === session.workspace);
  if (!change || change.undone) throw new HostCommandError("This local change is no longer available to undo.");
  const local = await readLocalFile(session.localDir, change.path);
  if ((local ? blobId(local.data) : undefined) !== change.after) throw new HostCommandError("This file changed locally after taking the server version. Compare it before undoing.");
  if (change.before) await writeLocalFile(session.localDir, change.path, await session.mirror.readBlob(change.before), { mode: change.beforeMode ?? 0o644 });
  else await removeLocalFile(session.localDir, change.path);
  await store.write(session.key, LOCAL_CHANGES_FILE, { changes: changes.map((item) => item.id === id ? { ...item, undone: true } : item) });
}

export async function completeLocalServerChange(store: ServersStore, session: SyncSession, id: string): Promise<void> {
  const changes = (await store.read(session.key, LOCAL_CHANGES_FILE))?.changes ?? [];
  await store.write(session.key, LOCAL_CHANGES_FILE, { changes: changes.map((change) => change.id === id ? { ...change, applied: true } : change) });
}
