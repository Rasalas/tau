import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { extract } from "tar";
import { MANAGED_CODEX_VERSION, managedCodexAsset, type ManagedCodexAsset } from "./managed-release.js";

export { MANAGED_CODEX_VERSION } from "./managed-release.js";

export interface ManagedCodexProgress {
  phase: "downloading" | "extracting" | "installed";
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ManagedCodexOptions {
  directory: string;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** An archive fixture in tests; production uses the pinned release table. */
  asset?: ManagedCodexAsset;
}

export interface ManagedCodexInstallOptions {
  signal?: AbortSignal;
  onProgress?(event: ManagedCodexProgress): void;
}

interface InstalledRecord {
  sha256: string;
  files: Array<{ path: string; bytes: number }>;
}

const RECORD = ".tau-install.json";
const installations = new Map<string, Promise<string>>();
const safePath = (path: string): boolean => /^[a-zA-Z0-9_./-]+$/u.test(path) && !path.startsWith("/") && !path.split("/").includes("..");

/** Installs only inside Tau's state directory; never changes the user's CLI. */
export function createManagedCodex(options: ManagedCodexOptions) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = options.asset ?? managedCodexAsset(platform, arch);
  const root = resolve(options.directory);
  const directory = join(root, `${MANAGED_CODEX_VERSION}-${platform}-${arch}`);
  const entrypoint = `bin/codex${platform === "win32" ? ".exe" : ""}`;

  const resolveInstalled = async (): Promise<string | undefined> => {
    if (!asset) return undefined;
    try {
      const record = JSON.parse(await readFile(join(directory, RECORD), "utf8")) as InstalledRecord;
      if (record.sha256 !== asset.sha256 || !Array.isArray(record.files) || !record.files.some((file) => file.path === entrypoint)) return undefined;
      for (const file of record.files) {
        if (!safePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return undefined;
        const info = await lstat(join(directory, file.path));
        if (!info.isFile() || info.size !== file.bytes) return undefined;
      }
      const executable = join(directory, entrypoint);
      if (platform !== "win32") await access(executable, constants.X_OK);
      return executable;
    } catch { return undefined; }
  };

  const install = async (input: ManagedCodexInstallOptions): Promise<string> => {
    input.signal?.throwIfAborted();
    const existing = await resolveInstalled();
    if (existing) return existing;
    if (!asset) throw new Error(`Tau does not include a managed Codex release for ${platform}-${arch}. Set an installed Codex path in Settings → Providers.`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(root, ".install-"));
    try {
      const archive = join(staging, "package.tar.gz");
      await download(asset, archive, options.fetch ?? fetch, input);
      input.signal?.throwIfAborted();
      input.onProgress?.({ phase: "extracting" });
      const unpacked = join(staging, "runtime");
      await mkdir(unpacked, { mode: 0o700 });
      const files: InstalledRecord["files"] = [];
      const executables: string[] = [];
      let invalid = false;
      let expandedBytes = 0;
      await extract({
        file: archive, cwd: unpacked, strict: true, preserveOwner: false,
        filter: (path, entry) => {
          if (input.signal?.aborted || !safePath(path) || !("type" in entry) || !["File", "Directory"].includes(entry.type)) { invalid = true; return false; }
          if (entry.type === "File") {
            expandedBytes += entry.size;
            if (expandedBytes > 2 * 1024 ** 3) { invalid = true; return false; }
            files.push({ path, bytes: entry.size });
            if ((entry.mode ?? 0) & 0o111) executables.push(path);
          }
          return true;
        },
      });
      input.signal?.throwIfAborted();
      if (invalid) throw new Error("The Codex archive contains unsupported entries.");
      const manifest = JSON.parse(await readFile(join(unpacked, "codex-package.json"), "utf8")) as Record<string, unknown>;
      if (manifest.version !== MANAGED_CODEX_VERSION || manifest.target !== asset.target || manifest.entrypoint !== entrypoint || !files.some((file) => file.path === entrypoint)) throw new Error("The Codex package does not match the pinned release.");
      for (const path of executables) await chmod(join(unpacked, path), 0o755);
      await chmod(join(unpacked, entrypoint), 0o755);
      await writeFile(join(unpacked, RECORD), JSON.stringify({ sha256: asset.sha256, files } satisfies InstalledRecord), { mode: 0o600 });
      // Another host may have installed the same release while this one downloaded.
      const concurrent = await resolveInstalled();
      if (concurrent) return concurrent;
      await rm(directory, { recursive: true, force: true });
      await rename(unpacked, directory).catch(async (error) => {
        if (!await resolveInstalled()) throw error;
      });
      const executable = await resolveInstalled();
      if (!executable) throw new Error("The managed Codex installation is incomplete. Try again.");
      input.onProgress?.({ phase: "installed" });
      return executable;
    } finally { await rm(staging, { recursive: true, force: true }); }
  };

  return {
    resolveInstalled,
    /** Concurrent callers share the install; a failed or cancelled attempt is retryable. */
    ensure(input: ManagedCodexInstallOptions = {}): Promise<string> {
      const key = `${directory}:${asset?.sha256 ?? "unsupported"}`;
      let pending = installations.get(key);
      if (!pending) {
        pending = install(input).finally(() => { installations.delete(key); });
        installations.set(key, pending);
      }
      return pending;
    },
  };
}

async function download(asset: ManagedCodexAsset, destination: string, fetcher: typeof fetch, input: ManagedCodexInstallOptions): Promise<void> {
  const url = `https://github.com/openai/codex/releases/download/rust-v${MANAGED_CODEX_VERSION}/codex-package-${asset.target}.tar.gz`;
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(input.signal ? [input.signal] : [])]);
  const response = await fetcher(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Codex download failed (${response.status}). Try again.`);
  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  let reported = 0;
  const reader = response.body.getReader();
  try {
    input.onProgress?.({ phase: "downloading", downloadedBytes: 0, totalBytes: asset.bytes });
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > asset.bytes) throw new Error("The Codex download is larger than the pinned release.");
      hash.update(value);
      await file.writeFile(value);
      if (Date.now() - reported > 250) {
        input.onProgress?.({ phase: "downloading", downloadedBytes: bytes, totalBytes: asset.bytes });
        reported = Date.now();
      }
    }
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("The Codex download failed its size or SHA-256 check. Nothing was installed.");
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close();
  }
}
