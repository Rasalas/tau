import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateChannel } from "../shared/app-version.js";

/**
 * Reading a release the way electron-builder publishes it, without
 * electron-updater: the host runs as Node and has no `app` to give it. Nothing
 * here may import Electron.
 */

/** The repository `publish:` in tooling/electron-builder.yml names; the build writes it to `app-update.yml`. */
export interface UpdateFeed {
  owner: string;
  repo: string;
}


/** The tag the release workflow moves to every nightly build. */
export const NIGHTLY_TAG = "nightly";


/** The GitHub feed in an installed app's `app-update.yml`, or undefined for any other provider. */
export function readUpdateFeed(text: string): UpdateFeed | undefined {
  const value = (key: string) => new RegExp(`^${key}:\\s*['"]?([^'"\\s#]+)`, "mu").exec(text)?.[1];
  if (value("provider") !== "github") return undefined;
  const owner = value("owner");
  const repo = value("repo");
  return owner && repo ? { owner, repo } : undefined;
}


export interface UpdateLog {
  info(label: string, detail?: unknown): void;
  warn(label: string, detail?: unknown): void;
  error(label: string, detail?: unknown): void;
}


/** How a Linux Tau was installed, which decides what can replace it. */
export type LinuxInstall = "appimage" | "deb" | "unpacked";

/** Where the .deb puts Tau (electron-builder's `/opt/<productName>`). */
export const DEB_EXECUTABLE = "/opt/Tau/tau";
/** `deb.packageName` in tooling/electron-builder.yml. */
export const DEB_PACKAGE = "tau";

/**
 * electron-builder writes `resources/package-type` into the folder the .deb
 * and the AppImage are both packed from, so an AppImage may carry `deb` too;
 * only a copy at the package's own path counts as the package.
 */
export function linuxInstall(env: NodeJS.ProcessEnv, resourcesPath: string, execPath: string, read: (path: string) => string | undefined = readText): LinuxInstall {
  if (env.APPIMAGE) return "appimage";
  return execPath === DEB_EXECUTABLE && read(join(resourcesPath, "package-type"))?.trim() === "deb" ? "deb" : "unpacked";
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export const UNPACKED_UPDATES = "This copy of Tau was unpacked by hand, so it cannot replace itself. On Debian and Ubuntu, install the .deb from the releases page; it updates itself from then on. Elsewhere, the AppImage does.";


export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface ReleaseFile {
  url: string;
  /** Base64, as electron-builder writes it. */
  sha512: string;
  size?: number;
}

/** The `version` and `files` of a `latest-linux.yml`; only the flat shape electron-builder writes. */
export function parseReleaseInfo(text: string): { version?: string; files: ReleaseFile[] } {
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/u, "$2");
  const files: ReleaseFile[] = [];
  let version: string | undefined;
  let entry: Partial<ReleaseFile> | undefined;
  let inFiles = false;
  const flush = () => {
    if (entry?.url && entry.sha512) files.push(entry as ReleaseFile);
    entry = undefined;
  };
  for (const line of text.split(/\r?\n/u)) {
    const top = /^([A-Za-z]\w*):\s*(.*)$/u.exec(line);
    if (top) {
      flush();
      inFiles = top[1] === "files";
      if (top[1] === "version") version = unquote(top[2]!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/u.exec(line);
    const field = item ?? /^\s+(\w+):\s*(.*)$/u.exec(line);
    if (!field) continue;
    if (item) {
      flush();
      entry = {};
    }
    if (!entry) continue;
    const [, key, raw] = field;
    if (key === "url") entry.url = unquote(raw!);
    else if (key === "sha512") entry.sha512 = unquote(raw!);
    else if (key === "size" && /^\d+$/u.test(raw!.trim())) entry.size = Number(raw!.trim());
  }
  flush();
  return { ...(version ? { version } : {}), files };
}

export class ChecksumMismatch extends Error {}

export async function fileSha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(path), hash);
  return hash.digest("base64");
}

/**
 * Downloads `url` to `target` and keeps it only when size and SHA-512 match
 * the release; a file already there that matches is kept as it is.
 */
export async function downloadVerified(
  fetchUrl: Fetch,
  url: string,
  target: string,
  expected: { sha512: string; size?: number },
  signal?: AbortSignal,
  /** Bytes so far and the total the release names, when it names one. */
  progress?: (received: number, total: number | undefined) => void,
): Promise<void> {
  if (existsSync(target) && await fileSha512(target) === expected.sha512) return;
  const response = await fetchUrl(url, signal ? { signal } : {});
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
  const partial = `${target}.part`;
  const hash = createHash("sha512");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      progress?.(size, expected.size);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(partial), signal ? { signal } : {});
    const digest = hash.digest("base64");
    if (digest !== expected.sha512 || (expected.size !== undefined && size !== expected.size)) {
      throw new ChecksumMismatch(`The download of ${basename(target)} does not match the release's checksum; nothing was installed.`);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class ReleaseSignatureError extends Error {}

/**
 * The folder a channel's `latest*.yml` is read from. Stable follows GitHub's
 * redirect to the newest release that is not a prerelease; nightly is the one
 * moving tag. `override` is a local feed for tests.
 */
export function releaseFeedBase(channel: UpdateChannel, feed: UpdateFeed | undefined, override?: string): string | undefined {
  const local = override?.trim();
  if (local) return local.endsWith("/") ? local : `${local}/`;
  if (!feed) return undefined;
  const root = `https://github.com/${feed.owner}/${feed.repo}/releases`;
  return channel === "nightly" ? `${root}/download/${NIGHTLY_TAG}/` : `${root}/latest/download/`;
}

/** Where a file of `version` lies: a stable one under its own tag, so the feed and the file never come from two releases. */
export function releaseFileUrl(name: string, version: string, channel: UpdateChannel, base: string, feed: UpdateFeed | undefined, override?: string): string {
  if (override?.trim() || channel === "nightly" || !feed) return new URL(name, base).href;
  return `https://github.com/${feed.owner}/${feed.repo}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

/** electron-builder's update file for a platform and architecture. */
export function releaseInfoName(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
}

export function releasePublicKey(key: string) {
  if (key.includes("-----BEGIN")) return createPublicKey({ key, format: "pem" });
  const raw = Buffer.from(key.trim(), "base64");
  if (raw.length !== 32) throw new Error("A raw Ed25519 public key is 32 bytes of base64.");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * True when one of `keys` signed exactly these bytes. A `.sig` holds one base64
 * signature per line, so a key rotation can sign with the old key and the new.
 */
export function verifyReleaseSignature(text: string, signature: string, keys: readonly string[]): boolean {
  const signatures = signature.split(/\s+/u).filter(Boolean).map((line) => Buffer.from(line, "base64")).filter((bytes) => bytes.length === 64);
  return signatures.some((bytes) => keys.some((key) => {
    try {
      return verify(null, Buffer.from(text, "utf8"), releasePublicKey(key), bytes);
    } catch {
      return false;
    }
  }));
}

/**
 * The keys a host trusts. A local test feed (`TAU_UPDATE_FEED_URL`) may name
 * the key it is signed with (`TAU_UPDATE_FEED_KEY`); the release's keys then
 * do not count, and without that feed the variable does nothing.
 */
export function releaseKeysFor(env: NodeJS.ProcessEnv, built: readonly string[]): readonly string[] {
  const key = env.TAU_UPDATE_FEED_KEY?.trim();
  return env.TAU_UPDATE_FEED_URL?.trim() && key ? [key] : built;
}

export interface ReleaseInfo {
  version: string;
  files: ReleaseFile[];
  /** Whether a release key vouched for the list; false where the build carries none. */
  signed: boolean;
}

/**
 * The newest release on a feed. With release keys in the build, the list must
 * carry a signature by one of them; without, the checksums it lists are
 * trusted as far as the feed's own address is.
 */
export async function readReleaseInfo(fetchUrl: Fetch, base: string, name: string, keys: readonly string[], signal?: AbortSignal): Promise<ReleaseInfo> {
  const url = new URL(name, base).href;
  const response = await fetchUrl(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const text = await response.text();
  let signed = false;
  if (keys.length > 0) {
    const signatureResponse = await fetchUrl(`${url}.sig`, signal ? { signal } : {});
    if (!signatureResponse.ok) throw new ReleaseSignatureError(`The release carries no signature (${name}.sig answered ${signatureResponse.status}).`);
    if (!verifyReleaseSignature(text, await signatureResponse.text(), keys)) throw new ReleaseSignatureError(`${name} is not signed by Tau's release key.`);
    signed = true;
  }
  const info = parseReleaseInfo(text);
  if (!info.version) throw new Error(`${name} names no version.`);
  return { version: info.version, files: info.files, signed };
}

/** Only a plain file name is saved or fetched; anything with a path in it is not Tau's. */
export function safeReleaseName(url: string): string | undefined {
  const name = url.split("/").pop() ?? "";
  let decoded: string;
  try { decoded = decodeURIComponent(name); } catch { return undefined; }
  return /^[\w.+~-]+$/u.test(decoded) && !decoded.startsWith(".") ? decoded : undefined;
}

const DEB_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** The file of a release each kind of install takes. */
export function pickReleaseFile(files: readonly ReleaseFile[], method: "deb" | "appimage" | "mac" | "windows", arch: string): ReleaseFile | undefined {
  const named = files.filter((file) => safeReleaseName(file.url));
  const name = (file: ReleaseFile) => safeReleaseName(file.url)!;
  switch (method) {
    case "deb": {
      const debArch = DEB_ARCH[arch];
      return debArch ? named.find((file) => name(file).endsWith(`_${debArch}.deb`)) : undefined;
    }
    case "appimage":
      return named.find((file) => name(file).endsWith(".AppImage") && (arch === "x64" ? !/-(arm64|armv7l)\.AppImage$/u.test(name(file)) : name(file).endsWith(`-${arch}.AppImage`)));
    case "mac":
      return named.find((file) => name(file).endsWith(".zip") && (arch === "arm64" ? name(file).includes("-arm64") : !name(file).includes("-arm64")));
    case "windows":
      return named.find((file) => name(file).endsWith(".exe"));
  }
}
