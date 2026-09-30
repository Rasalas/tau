import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { prepareManagedHostRelease, portableBootstrapScript } from "./managed-host-release.js";

export type WslExecutor = (args: string[], signal?: AbortSignal) => Promise<string>;
export const runWsl: WslExecutor = (args, signal) => new Promise((resolve, reject) => {
  execFile("wsl.exe", args, { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: "buffer", signal }, (error, stdout, stderr) => {
    if (error) reject(new Error(`WSL failed: ${stderr.toString("utf8").trim() || error.message}`));
    else resolve(stdout.includes(0) ? stdout.toString("utf16le") : stdout.toString("utf8"));
  });
});

export function validateDistribution(name: string): string {
  if (!name || name.length > 256 || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Choose an installed WSL distribution.");
  return name;
}

/** Quiet output has no localized headers or default/running markers. */
export async function listWslDistributions({ platform = process.platform, execute = runWsl }: { platform?: string; execute?: WslExecutor } = {}): Promise<string[]> {
  if (platform !== "win32") return [];
  return [...new Set((await execute(["--list", "--quiet"])).replace(/^\uFEFF/u, "").split(/\r?\n/u).map((name) => name.trim()).filter(Boolean).map(validateDistribution))];
}

export function distributionCommand(distro: string, command: string, args: readonly string[] = []): string[] {
  return ["--distribution", validateDistribution(distro), "--exec", command, ...args];
}

interface PairingChannel {
  link: string;
  close(): void;
}

/** JSON-line approval channel, closed after pairing, never the running host. */
export function wslPairingChannel(child: ChildProcessWithoutNullStreams, signal?: AbortSignal, timeoutMs = 30_000): Promise<PairingChannel> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const close = () => { child.stdin.end(`${JSON.stringify({ type: "done" })}\n`); child.kill(); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } close(); };
    const abort = () => fail(new Error("WSL pairing cancelled."));
    const timer = setTimeout(() => fail(new Error("The WSL host did not offer a pairing link in time.")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.on("exit", (code) => { if (!settled) fail(new Error(`WSL pairing exited with ${code}. Check the distro's Tau host log.`)); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) return fail(new Error("Invalid WSL pairing response."));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: { type?: string; message?: string; urls?: { url: string }[] };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "ready") child.stdin.write(`${JSON.stringify({ type: "link", version: 1, label: "Windows workbench", access: "full" })}\n`);
        else if (message.type === "link" && !settled) {
          const link = message.urls?.map((entry) => entry.url).find((url) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname); } catch { return false; } });
          if (!link) return fail(new Error("The WSL host did not provide a localhost pairing link. Enable WSL localhost forwarding."));
          settled = true; clearTimeout(timer); resolve({ link, close });
        } else if (message.type === "error" || message.type === "failed") fail(new Error(message.message ?? "WSL pairing failed."));
      }
    });
    if (signal?.aborted) abort();
  });
}

export async function bootstrapWslHost(distro: string, options: { cacheDir: string; signal?: AbortSignal; execute?: WslExecutor; prepare?: typeof prepareManagedHostRelease; start?: typeof spawn; platform?: string }): Promise<PairingChannel> {
  if ((options.platform ?? process.platform) !== "win32") throw new Error("WSL environments require Windows.");
  const execute = options.execute ?? runWsl;
  const installed = await listWslDistributions({ platform: "win32", execute });
  if (!installed.includes(validateDistribution(distro))) throw new Error("That WSL distribution is no longer installed.");
  const run = (command: string, args: string[] = []) => execute(distributionCommand(distro, command, args), options.signal);
  const machine = (await run("uname", ["-m"])).trim();
  const arch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : undefined;
  if (!arch) throw new Error(`Tau has no portable Linux host for ${machine}.`);
  const release = await (options.prepare ?? prepareManagedHostRelease)("linux", arch, options.cacheDir, options.signal);
  const archive = (await run("wslpath", ["-u", release.path])).trim();
  // HOME is the distro user's home, not a Windows path or the client's data.
  await run("sh", ["-c", 'root="$HOME/.local/share/tau/wsl-host"; exec sh -c "$1" tau-bootstrap "$2" "$root"', "tau", portableBootstrapScript("linux", release.version, release.sha512), archive]);
  await run("sh", ["-c", 'root="$HOME/.local/share/tau/wsl-host"; n=0; while [ ! -s "$root/data/host.json" ]; do n=$((n + 1)); [ "$n" -lt 30 ] || { echo "Tau host service did not start" >&2; exit 1; }; sleep 1; done']);
  const child = (options.start ?? spawn)("wsl.exe", distributionCommand(distro, "sh", ["-c", 'root="$HOME/.local/share/tau/wsl-host"; export ELECTRON_RUN_AS_NODE=1 TAU_USER_DATA="$root/data"; exec "$root/current/tau" "$root/current/resources/app.asar.unpacked/bin/tau.mjs" machines accept-ssh']), { windowsHide: true, stdio: "pipe" });
  return wslPairingChannel(child, options.signal);
}


/** Starts the installed host and reads its current address, retaining the catalog's paired key. */
export async function resumeWslHost(distro: string, { execute = runWsl, signal }: { execute?: WslExecutor; signal?: AbortSignal } = {}): Promise<string> {
  const script = `set -eu
root="$HOME/.local/share/tau/wsl-host"
export ELECTRON_RUN_AS_NODE=1 TAU_USER_DATA="$root/data"
[ -x "$root/current/tau" ] || { echo 'The distro host is missing. Add this WSL environment again.' >&2; exit 1; }
"$root/current/tau" "$root/current/resources/app.asar.unpacked/bin/tau.mjs" service install >&2
n=0
while [ ! -s "$root/data/host.json" ]; do n=$((n + 1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done
exec "$root/current/tau" -e 'const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(process.env.TAU_USER_DATA+"/host.json","utf8")); console.log(d.url);'
`;
  const endpoint = (await execute(distributionCommand(distro, "sh", ["-c", script]), signal)).trim();
  const url = new URL(endpoint);
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The WSL host did not return a localhost address.");
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return url.toString();
}
