import type { DeploymentRecord } from "./deploy-protocol.js";
import { readDeployments, setDeploymentStatus, supersededPaths } from "./journal.js";
import type { ServersStore, TargetKey } from "./store.js";
import { gitOk, type GitCall } from "./sync/git.js";
import { Mirror, sha256Of } from "./sync/mirror.js";

/*
 * The commit mark (plan §1.5): a deployment is `committed` once HEAD of the
 * checkout it came from (or of the main checkout) holds every file as it went
 * up. The mark only records that; the deployment stays in the history and can
 * still be rolled back.
 */

const LISTING_CAP = 8;
// Files per deployment Tau hashes again through the checkout's attributes when the blob ids differ.
const NORMALIZE_CAP = 50;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:.*\n)*?oid sha256:([0-9a-f]{64})\n/u;

const active = (record: DeploymentRecord) => (record.status === "uploaded" || record.status === "verified") && record.files.length > 0;

export class CommitMarks {
  /** Path → blob id of a HEAD, by checkout and HEAD. */
  private readonly listings = new Map<string, Map<string, string>>();
  /** Whether a HEAD holds a deployment, by checkout, HEAD, deployment and what later ones replaced. */
  private readonly held = new Map<string, boolean>();

  constructor(private readonly store: ServersStore, private readonly git: GitCall) {}

  private async readGit(cwd: string, args: string[], input?: Buffer): Promise<string | undefined> {
    if (!cwd) return undefined;
    const result = await this.git(args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" }, ...(input ? { input } : {}) }).catch(() => undefined);
    return result?.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  private async listing(cwd: string, head: string): Promise<Map<string, string> | undefined> {
    const id = `${cwd}\0${head}`;
    const known = this.listings.get(id);
    if (known) return known;
    const out = await gitOk(this.git, ["ls-tree", "-r", "-z", "--full-tree", head], { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } }).catch(() => undefined);
    if (!out) return undefined;
    const files = new Map<string, string>();
    for (const entry of out.toString("utf8").split("\0")) {
      const match = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/su.exec(entry);
      if (match) files.set(match[2]!, match[1]!);
    }
    if (this.listings.size >= LISTING_CAP) this.listings.delete(this.listings.keys().next().value!);
    this.listings.set(id, files);
    return files;
  }

  /**
   * Whether `data` is what Git makes of that file at `path` in `cwd`: through
   * the checkout's attributes (eol, text) or, for Git LFS, its pointer. Other
   * filter drivers are not run; such a file never counts as committed.
   */
  private async sameAsCommitted(cwd: string, path: string, data: Buffer, committed: string): Promise<boolean> {
    const attribute = await this.readGit(cwd, ["check-attr", "filter", "--", path]);
    const filter = attribute ? /: filter: (.*)$/u.exec(attribute)?.[1] : undefined;
    if (filter === "lfs") {
      const pointer = await this.readGit(cwd, ["cat-file", "blob", committed]);
      const oid = pointer && pointer.length < 1024 ? LFS_POINTER.exec(`${pointer}\n`)?.[1] : undefined;
      return oid === sha256Of(data);
    }
    if (filter && filter !== "unspecified" && filter !== "unset") return false;
    return await this.readGit(cwd, ["hash-object", `--path=${path}`, "--stdin"], data) === committed;
  }

  private async holds(record: DeploymentRecord, files: ReadonlyMap<string, string>, superseded: ReadonlySet<string>, cwd: string, mirror: Mirror): Promise<boolean> {
    const prefix = record.context ? `${record.context}/` : "";
    const differing: Array<{ path: string; after: string; committed: string }> = [];
    for (const file of record.files) {
      if (superseded.has(file.path)) continue;
      const path = `${prefix}${file.path}`;
      const committed = files.get(path);
      if (file.op === "delete" || !file.after) { if (committed !== undefined) return false; continue; }
      if (committed === undefined) return false;
      if (committed !== file.after) differing.push({ path, after: file.after, committed });
    }
    if (differing.length > NORMALIZE_CAP) return false;
    for (const file of differing) {
      const data = await mirror.readBlob(file.after).catch(() => undefined);
      if (!data || !await this.sameAsCommitted(cwd, file.path, data, file.committed)) return false;
    }
    return true;
  }

  private async committed(key: TargetKey, record: DeploymentRecord, root: string, superseded: ReadonlySet<string>): Promise<boolean> {
    for (const cwd of [...new Set([record.checkout.path, root])]) {
      const head = await this.readGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (!head) continue;
      const id = `${cwd}\0${head}\0${key.targetId}\0${record.seq}\0${[...superseded].sort().join("\0")}`;
      const known = this.held.get(id);
      if (known !== undefined) return known;
      const files = await this.listing(cwd, head);
      if (!files) continue;
      const held = await this.holds(record, files, superseded, cwd, new Mirror(this.store.mirrorDir(key), { git: this.git }));
      if (this.held.size > 1000) this.held.clear();
      this.held.set(id, held);
      return held;
    }
    return false;
  }

  /** Marks every deployment HEAD now holds as `committed` for good; answers the journal as it is then. */
  async refresh(key: TargetKey, root: string): Promise<DeploymentRecord[]> {
    let records = await readDeployments(this.store, key);
    const found: number[] = [];
    for (const record of records) {
      if (!active(record)) continue;
      if (await this.committed(key, record, root, supersededPaths(record, records.filter((other) => other.status !== "rolled-back")))) found.push(record.seq);
    }
    for (const seq of found) records = await setDeploymentStatus(this.store, key, seq, "committed");
    return records;
  }

  /** Threads with a deployment their checkout's HEAD does not hold yet. */
  async uncommittedThreads(key: TargetKey, root: string): Promise<string[]> {
    const records = await this.refresh(key, root);
    return [...new Set(records.filter((record) => active(record) && record.origin.threadId).map((record) => record.origin.threadId!))].sort();
  }
}
