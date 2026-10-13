import type { DeploymentFailure, DeploymentFile } from "./deploy-protocol.js";
import { deployRef, readDeployments, recordDeployment } from "./journal.js";
import { readServerFile } from "./sync/deploy.js";
import { gitOk, type GitCall } from "./sync/git.js";
import { entryOf, loadMirrorState, recordMirrorState, saveMirrorState, sortedEntries } from "./sync/mirror.js";
import type { SyncSession } from "./sync/service.js";
import type { ServersStore } from "./store.js";

/** Reconcile an interrupted write before comparing it with the mirror. Never writes to the server. */
export async function recoverDeployments(store: ServersStore, session: SyncSession, git: GitCall): Promise<void> {
  const records = (await readDeployments(store, session.key)).filter((record) => record.status === "in-progress");
  if (!records.length) return;
  const fs = await session.connect();
  for (const record of records) {
    const state = await loadMirrorState(store, session.key, session.mirror);
    if (!state) throw new Error("The interrupted deployment has no mirror state.");
    const next = new Map(state.entries);
    const after = new Map(state.entries);
    const files: DeploymentFile[] = [];
    const failed: DeploymentFailure[] = [];
    for (const file of record.files) {
      if (file.before) after.set(file.path, entryOf(await session.mirror.readBlob(file.before), { mode: file.beforeMode ?? 0o644, mtime: 0 }));
      else after.delete(file.path);
      const now = await readServerFile(fs, file.path, session.signal);
      const matches = file.op === "delete" ? now.kind === "absent" : now.kind === "file" && now.entry.oid === file.after;
      if (matches) {
        if (now.kind === "file") { next.set(file.path, now.entry); after.set(file.path, now.entry); }
        else { next.delete(file.path); after.delete(file.path); }
        files.push(now.kind === "file" ? { ...file, mode: now.stat.mode } : file);
      } else {
        failed.push({ path: file.path, op: file.op, message: "The upload was interrupted; this file does not match the planned result. Review it before uploading again." });
      }
    }
    const parent = (await gitOk(git, ["rev-parse", `${deployRef(record.seq)}^`], { cwd: session.mirror.dir, env: session.mirror.gitEnv() })).toString("utf8").trim();
    const commit = await session.mirror.commit(sortedEntries(after), `Deployment ${record.seq} interrupted`, parent);
    await session.mirror.setRef(deployRef(record.seq), commit);
    const same = after.size === next.size && [...after].every(([path, entry]) => entry.oid === next.get(path)?.oid && (entry.mode & 0o111) === (next.get(path)!.mode & 0o111));
    const mirror = same
      ? await recordMirrorState(store, session.key, session.mirror, next, commit, state.commit)
      : await saveMirrorState(store, session.key, session.mirror, next, `Server state after interrupted deployment ${record.seq}`);
    await recordDeployment(store, session.key, { ...record, files, failed, status: "incomplete", commit, mirrorCommit: mirror.commit });
  }
}
