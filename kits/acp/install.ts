import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { x as untar } from "tar";
import { readZipDirectory, extractZipEntry, isPlainFileEntry } from "../antigravity/zip.js";
import { parseAgent } from "./config.js";
import type { AcpAgentConfig, RegistryAgent } from "./protocol.js";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
export function safeArchivePath(root: string, name: string): string {
  if (!name || name.includes("\\") || name.includes("\0") || /^[A-Za-z]:/u.test(name)) throw new Error("Unsafe archive path.");
  const path = resolve(root, name);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error("The archive leaves its installation directory.");
  return path;
}

/** Downloads only an owner-selected agent. Nothing executes before the checksum and extraction complete. */
export async function installBinary(agent: RegistryAgent, stateDir: string, fetcher = globalThis.fetch, platform = process.platform, arch = process.arch): Promise<AcpAgentConfig> {
  const target = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch}`;
  const binary = agent.distribution.binary?.[target];
  if (!binary) throw new Error(`${agent.name} has no binary for ${target}. Add a locally installed ACP command instead.`);
  if (!binary.sha256 || !/^[a-fA-F0-9]{64}$/u.test(binary.sha256)) throw new Error("This registry binary has no SHA-256 checksum. Install it yourself and add its command instead.");
  if (new URL(binary.archive).protocol !== "https:") throw new Error("Registry downloads must use HTTPS.");
  const config = parseAgent({ id: agent.id, name: agent.name, command: binary.cmd, args: binary.args ?? [], env: binary.env });
  const parent = join(stateDir, "tools", agent.id); await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".install-"));
  try {
    const response = await fetcher(binary.archive, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`ACP download failed: HTTP ${response.status}.`);
    if (response.url && new URL(response.url).protocol !== "https:") throw new Error("ACP download redirected away from HTTPS.");
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_ARCHIVE) throw new Error("The ACP archive is too large."); parts.push(next.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(parts);
    if (createHash("sha256").update(bytes).digest("hex") !== binary.sha256.toLowerCase()) throw new Error("The ACP archive failed its SHA-256 check.");
    const archive = join(staging, "archive"); await writeFile(archive, bytes);
    const root = join(staging, "app"); await mkdir(root);
    let expanded = 0;
    if (/\.zip(?:\?|$)/iu.test(binary.archive)) {
      for (const entry of await readZipDirectory(archive)) {
        const path = safeArchivePath(root, entry.name);
        if (entry.name.endsWith("/")) { await mkdir(path, { recursive: true }); continue; }
        if (!isPlainFileEntry(entry) || (expanded += entry.uncompressedSize) > MAX_EXPANDED) throw new Error("Unsupported or oversized ACP archive entry.");
        await mkdir(resolve(path, ".."), { recursive: true });
        await extractZipEntry(archive, entry, path, entry.uncompressedSize);
      }
    } else if (/\.(?:tgz|tar\.gz|tar)(?:\?|$)/iu.test(binary.archive)) {
      let unsafe: Error | undefined;
      await untar({ file: archive, cwd: root, strict: true, preservePaths: false, filter: (name, entry) => {
        try {
          if (name === "." || name === "./") return false;
          safeArchivePath(root, name);
          if (!("type" in entry) || (entry.type !== "File" && entry.type !== "Directory")) throw new Error("ACP archives must not contain links or special files.");
          expanded += entry.size;
          if (expanded > MAX_EXPANDED) throw new Error("The expanded ACP archive is too large.");
          return true;
        } catch (error) { unsafe = error as Error; return false; }
      } });
      if (unsafe) throw unsafe;
    } else {
      if (/\.(?:bz2|tbz2|xz|txz|7z|dmg|pkg|deb|rpm)(?:\?|$)/iu.test(binary.archive)) throw new Error("This archive format is not supported. Install the agent yourself and add its command.");
      const path = safeArchivePath(root, binary.cmd); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, bytes);
    }
    const executable = safeArchivePath(root, binary.cmd);
    if (!(await stat(executable)).isFile()) throw new Error("The ACP archive lacks its advertised executable.");
    await chmod(executable, 0o755);
    const destination = join(parent, binary.sha256.toLowerCase());
    // Existing installs are immutable; settings only point here after full verification.
    try { await rename(root, destination); }
    catch (error) { if (!(await readFile(join(destination, ".verified")).catch(() => undefined))) throw error; }
    await writeFile(join(destination, ".verified"), binary.sha256, { mode: 0o600 });
    return { ...config, command: safeArchivePath(destination, binary.cmd) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
