import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the shared secret of a listening host lives, readable only by its owner. */
export function hostTokenPath(home: string = homedir()): string {
  return join(home, ".tau", "host-token");
}

/**
 * Reads the host token, creating it on first use. It is the whole
 * authentication of a listening host: whoever can read the file may connect,
 * which is why it is written 0o600 in a 0o700 directory.
 */
export function readOrCreateHostToken(path: string = hostTokenPath()): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Missing or unreadable: fall through and write a new one.
  }
  const token = randomBytes(32).toString("hex");
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
