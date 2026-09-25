import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { HostCommandError } from "tau/host-extension";
import type { GitRunner } from "./git.js";
import type { RepoIdentity } from "./protocol.js";

/**
 * `origin` as one string for every way of writing it: host and path, no
 * scheme, user, port or `.git`, so `git@github.com:acme/app.git` and
 * `https://github.com/acme/app` are the same project. A local path keeps its
 * case; `file` stands in for the host.
 */
export function normalizeOriginUrl(raw: string): string | undefined {
  const source = raw.trim();
  if (!source || source.includes("\0")) return undefined;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u.exec(source);
  if (source.includes("://")) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return undefined;
    }
    host = url.protocol === "file:" ? "file" : url.hostname.toLowerCase();
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
  } else if (isAbsolute(source)) {
    host = "file";
    path = source.replaceAll("\\", "/");
  } else if (scp && !/^[a-z]$/iu.test(scp[1])) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    return undefined;
  }
  path = path.replace(/\/+/gu, "/").replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (!host || !path) return undefined;
  return `${host}/${host === "file" ? path : path.toLowerCase()}`;
}

/** A folder-safe key for a normalized identity: readable at the end, unique by its hash. */
export function repoKeyOf(identity: string): string {
  const slug = identity.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[-.]+|-+$/gu, "");
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `${slug.slice(-48).replace(/^[-.]+/u, "") || "repo"}-${hash}`;
}

/** What a mirror key may look like on the receiving side: nothing that leaves its folder. */
export const REPO_KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

/** A folder name for the checkout's worktrees on the other machine. */
export function folderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^[-.]+/u, "").slice(0, 64) || "project";
}

/**
 * `origin` as it may travel: an https URL without its user and password (a
 * token often sits there), an ssh URL without a password. The other machine
 * reads origin with its own credentials or not at all.
 */
export function shareableOrigin(raw: string): string | undefined {
  const source = raw.trim();
  if (!source.includes("://")) return normalizeOriginUrl(source) ? source : undefined;
  try {
    const url = new URL(source);
    if (url.protocol !== "ssh:") url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export interface CheckoutIdentity extends RepoIdentity {
  /** The checkout's top folder. */
  root: string;
}

/** A checkout's identity across machines: origin first, then the oldest root commit. */
export async function readRepoIdentity(cwd: string, git: GitRunner): Promise<CheckoutIdentity> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) throw new HostCommandError(`${cwd} is not inside a Git repository.`);
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new HostCommandError("This project has no commit yet; commit once before its work moves to another machine.");
  const name = folderName(basename(root));
  const rawOrigin = (await git(root, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
  const normalized = rawOrigin ? normalizeOriginUrl(rawOrigin) : undefined;
  const origin = rawOrigin ? shareableOrigin(rawOrigin) : undefined;
  if (normalized) return { root, key: repoKeyOf(normalized), name, ...(origin ? { origin } : {}), source: "origin" };
  const roots = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").map((line) => line.trim()).filter(Boolean).sort();
  return { root, key: `root-${roots[0].slice(0, 16)}`, name, source: "root-commit" };
}
