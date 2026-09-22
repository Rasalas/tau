import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the shared secret of a listening host lives, readable only by its owner; `TAU_HOST_TOKEN_FILE` moves it. */
export function hostTokenPath(home: string = homedir(), env: { TAU_HOST_TOKEN_FILE?: string } = process.env): string {
  return env.TAU_HOST_TOKEN_FILE?.trim() || join(home, ".tau", "host-token");
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
