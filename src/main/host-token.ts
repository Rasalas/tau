import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tauHomeDir } from "./app-identity.js";

/** Where the shared secret of a listening host lives, readable only by its owner; `TAU_HOST_TOKEN_FILE` moves it. */
export function hostTokenPath(home: string = homedir(), env: { TAU_HOST_TOKEN_FILE?: string } = process.env): string {
  return env.TAU_HOST_TOKEN_FILE?.trim() || join(tauHomeDir(home), "host-token");
}

/** Reads an existing token; a client must never invent the secret of its host. */
export function readHostToken(path: string = hostTokenPath()): string | undefined {
  try {
    const existing = readFileSync(path, "utf8").trim();
    return existing.length >= 32 ? existing : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The token a client offers a remote host. `TAU_HOST_TOKEN` wins so one client
 * machine can reach several hosts; otherwise the host's token is expected to
 * have been copied into `~/.tau/host-token` here.
 */
export function clientHostToken(env: NodeJS.ProcessEnv = process.env, path: string = hostTokenPath()): string | undefined {
  const fromEnv = env.TAU_HOST_TOKEN?.trim();
  return fromEnv ? fromEnv : readHostToken(path);
}

/**
 * Reads the host token, creating it on first use. It is the whole
 * authentication of a listening host: whoever can read the file may connect,
 * which is why it is written 0o600 in a 0o700 directory.
 */
export function readOrCreateHostToken(path: string = hostTokenPath()): string {
  const existing = readHostToken(path);
  if (existing) return existing;
  const token = newHostToken();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

/** Constant-time comparison; a wrong or missing token is never a partial match. */
export function hostTokenMatches(expected: string, offered: string | undefined): boolean {
  if (typeof offered !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(offered, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function newHostToken(): string {
  return randomBytes(32).toString("hex");
}

function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * The host token as the file holds it. The file is the truth: a token replaced
 * on disk (by another host sharing the file, or by hand) is picked up at the
 * next check, and a file that went missing or unreadable keeps the last good
 * token rather than locking the owner out or minting one nobody can read.
 */
export class HostTokenFile {
  private token: string;
  private stamp: string | undefined;

  constructor(readonly path: string = hostTokenPath()) {
    this.token = readOrCreateHostToken(path);
    this.stamp = fileStamp(path);
  }

  current(): string {
    const stamp = fileStamp(this.path);
    if (stamp !== undefined && stamp !== this.stamp) {
      const read = readHostToken(this.path);
      if (read) this.token = read;
      this.stamp = stamp;
    }
    return this.token;
  }

  matches(offered: string | undefined): boolean {
    return hostTokenMatches(this.current(), offered);
  }

  /** Writes a new token (0o600, temp file and rename) and answers it; the old one stops matching at once. */
  rotate(): string {
    const token = newHostToken();
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    this.token = token;
    this.stamp = fileStamp(this.path);
    return token;
  }
}
