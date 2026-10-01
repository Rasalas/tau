import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WORKSPACE_ID_PREFIX, isWorkspaceId, type WorkspaceRef } from "../shared/workspace-identity.js";

/**
 * The host's own id, kept next to its other state. It survives restarts, so a
 * client's stored workspace ids keep pointing at the same directories, and it
 * is random, so an id says nothing about the machine that minted it.
 * A saved id must be 32 hexadecimal characters; invalid ids are never replaced.
 */
export function readOrCreateHostId(path: string): string {
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (!/^[0-9a-f]{32}$/iu.test(existing)) {
      throw new Error(`Invalid host id in ${path}: must contain exactly 32 hexadecimal characters. The saved id was not replaced.`);
    }
    return existing;
  }
  const hostId = randomBytes(16).toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${hostId}\n`, { encoding: "utf8", mode: 0o600 });
  return hostId;
}

/**
 * Mints and resolves workspace identities. An id is a one-way encoding of the
 * host id and the canonical path, so a client cannot read a path out of it and
 * cannot name a directory the host never offered: resolution only ever answers
 * for a workspace this host itself minted.
 */
export class WorkspaceIdentity {
  private readonly paths = new Map<string, string>();
  /** Canonical path per path the host has seen, filled by `learn`. */
  private readonly canonical = new Map<string, string>();

  constructor(private readonly hostId: string) {}

  /** Identity of one workspace; minting also makes it resolvable. */
  ref(path: string): WorkspaceRef {
    const displayPath = this.canonical.get(path) ?? resolve(path);
    const workspaceId = WORKSPACE_ID_PREFIX + createHash("sha256")
      .update(`${this.hostId}\0${displayPath}`)
      .digest("base64url")
      .slice(0, 32);
    this.paths.set(workspaceId, displayPath);
    return { workspaceId, displayPath };
  }

  workspaceId(path: string): string {
    return this.ref(path).workspaceId;
  }

  /** Canonicalizes a path the host admits, so later ids for it agree. */
  async learn(path: string): Promise<string> {
    const known = this.canonical.get(path);
    if (known) return known;
    const canonical = await realpath(path).catch(() => resolve(path));
    this.canonical.set(path, canonical);
    this.ref(canonical);
    return canonical;
  }

  resolve(workspaceId: string): string | undefined {
    return this.paths.get(workspaceId);
  }

  /**
   * The path for a value a client sent: a workspace id, or — for a client that
   * still speaks paths — the path itself. An unknown id is refused rather than
   * guessed at.
   */
  pathFor(value: string): string {
    if (!isWorkspaceId(value)) return value;
    const path = this.resolve(value);
    if (!path) throw new Error("This host does not know that workspace.");
    return path;
  }
}
