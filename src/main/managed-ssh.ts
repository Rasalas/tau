import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, connect } from "node:net";
import { createInterface } from "node:readline";
import { pairingUrl, parsePairingPayload } from "../shared/connections.js";
import { portableBootstrapScript, prepareManagedHostRelease, shellQuote, type ManagedHostPlatform } from "./managed-host-release.js";

export interface SshRoute { target: string; port: number; platform: "linux" | "darwin" }
export interface ManagedPairing { link: string; route: SshRoute; finish(): Promise<void>; close(): void }
export interface SshExecutor {
  run(target: string, command: string, input?: string, signal?: AbortSignal): Promise<string>;
  upload(target: string, path: string, signal?: AbortSignal): Promise<void>;
  spawn(target: string, command: string, forwards?: string[]): ChildProcessWithoutNullStreams;
}

export function validateSshTarget(target: string): string {
  if (!/^[\w][\w.@:[\]-]{0,254}$/u.test(target)) throw new Error("Enter an SSH config alias or user@hostname. Password prompts are disabled; set up an SSH key first.");
  return target;
}

export function managedSshArgs(target: string, command: string, forwards: string[] = []): string[] {
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes", ...forwards, validateSshTarget(target), command];
}

function failure(stderr: string): Error {
  if (/Host key verification failed|No .* host key is known/iu.test(stderr)) return new Error("SSH host key is unknown or changed. Verify the machine in a terminal with ssh before adding it.");
  if (/Permission denied|authentication failures/iu.test(stderr)) return new Error("SSH could not log in with a key. Set up an SSH key or agent; Tau disables password prompts.");
  return new Error(`SSH failed: ${stderr.trim().slice(-2_000) || "the remote command stopped"}`);
}

function collect(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(stop, 5 * 60_000);
    child.stdout.on("data", (bytes: Buffer) => { if (stdout.length < 32_768) stdout += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-8_192); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout); signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("SSH setup was cancelled."));
      else if (code === 0) resolve(stdout);
      else reject(failure(stderr));
    });
  });
}

export const sshExecutor: SshExecutor = {
  spawn: (target, command, forwards) => spawn("ssh", managedSshArgs(target, command, forwards), { windowsHide: true }),
  async run(target, command, input, signal) {
    const child = this.spawn(target, command);
    const completed = collect(child, signal);
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    return completed;
  },
  async upload(target, path, signal) {
    const child = this.spawn(target, 'umask 077; mkdir -p "$HOME/.local/share/tau-managed"; cat > "$HOME/.local/share/tau-managed/archive.part"');
    const completed = collect(child, signal);
    const source = createReadStream(path);
    source.on("error", () => child.kill());
    child.stdin.on("error", () => source.destroy());
    source.pipe(child.stdin);
    try { await completed; } finally { source.destroy(); }
  },
};

const root = '"$HOME/.local/share/tau-managed"';
export function managedCli(platform: "linux" | "darwin"): string {
  const executable = platform === "darwin" ? "Tau.app/Contents/MacOS/Tau" : "tau";
  const resources = platform === "darwin" ? "Tau.app/Contents/Resources" : "resources";
  return `ELECTRON_RUN_AS_NODE=1 TAU_USER_DATA=${root}/data ${root}/current/${executable} ${root}/current/${resources}/app.asar.unpacked/bin/tau.mjs`;
}

export async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/** How long a forward must hold before its drop starts the backoff over. */
const STABLE_FORWARD_MS = 60_000;

/** Failed tries in a row before the tunnel stops and waits for "Try again" (about 30 s of backoff). */
const MAX_ATTEMPTS = 6;

/** Whether the local port may carry the machine's access key: only while `up`, and only to `port`. */
export type SshTunnelState =
  | { status: "opening" }
  | { status: "up"; port: number }
  | { status: "failed"; detail: string };

export interface ManagedSshTunnelEvents {
  onState?(state: SshTunnelState): void;
  /** The saved port was taken by another program; the forward moves to `to` once this resolves, so save it here. */
  onMoved?(from: number, to: number): void | Promise<void>;
}

/**
 * Owns one local address for a machine reached over SSH and reconnects it.
 * A port another program holds is given up for a free one; a Tau whose host
 * id is not `hostId` is never forwarded to; after `MAX_ATTEMPTS` failed tries
 * in a row the tunnel stops until `retry`.
 */
export class ManagedSshTunnel {
  private child?: ChildProcessWithoutNullStreams;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private attempts = 0;
  private current: SshTunnelState = { status: "opening" };
  events: ManagedSshTunnelEvents = {};
  constructor(public route: SshRoute, private readonly exec: SshExecutor = sshExecutor, private readonly hostId?: string) {}
  get state(): SshTunnelState { return this.current; }
  async start(signal?: AbortSignal): Promise<void> {
    this.report({ status: "opening" });
    try { await this.startOnce(signal); }
    catch (error) { if (signal?.aborted) this.close(); else this.retryLater(error); throw error; }
  }
  /** Starts over after the tunnel gave up, or now instead of at the next scheduled try. */
  retry(): void {
    if (this.closed || this.current.status === "up") return;
    clearTimeout(this.timer); this.timer = undefined; this.attempts = 0;
    void this.start().catch(() => undefined);
  }
  private report(state: SshTunnelState): void {
    this.current = state;
    this.events.onState?.(state);
  }
  /** Whatever answers before the forward exists is another program: take a free port instead, saved by the owner first. */
  private async claimPort(): Promise<void> {
    if (!await reachable(this.route.port)) return;
    const from = this.route.port;
    const to = await freeLocalPort();
    this.route = { ...this.route, port: to };
    await this.events.onMoved?.(from, to);
  }
  private async startOnce(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("The SSH forward was closed.");
    await this.claimPort();
    const ready = await this.exec.run(this.route.target, `${managedCli(this.route.platform)} service status >/dev/null; ${this.descriptorCommand()}`, undefined, signal);
    const descriptor = JSON.parse(ready.trim().split("\n").at(-1)! ) as { url: string; id?: string };
    const remote = new URL(descriptor.url);
    if (!/^(ws|wss):$/u.test(remote.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(remote.hostname)) throw new Error("The managed host must listen on loopback.");
    if (this.hostId && descriptor.id && descriptor.id !== this.hostId) {
      // No retry changes which Tau answers there.
      this.attempts = MAX_ATTEMPTS;
      throw new Error("SSH reached a Tau that is not this machine; its data may have been reset. Remove the machine and add it again.");
    }
    if (this.closed || signal?.aborted) throw new Error("SSH setup was cancelled.");
    await this.claimPort();
    const child = this.child = this.exec.spawn(this.route.target, "cat >/dev/null", ["-L", `127.0.0.1:${this.route.port}:127.0.0.1:${remote.port}`]);
    let problem = "";
    let openedAt: number | undefined;
    child.stderr.on("data", (bytes: Buffer) => { problem = (problem + bytes.toString()).slice(-2_000); });
    child.on("error", (error) => this.retryLater(error));
    child.on("close", () => {
      if (this.child !== child) return;
      // Only a forward that held counts as working; one that keeps dropping backs off.
      if (openedAt !== undefined && Date.now() - openedAt >= STABLE_FORWARD_MS) this.attempts = 0;
      if (!this.closed) this.report({ status: "opening" });
      this.retryLater(failure(problem));
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (signal?.aborted || this.closed) { this.close(); throw new Error("SSH setup was cancelled."); }
      if (child.exitCode !== null) throw failure(problem);
      if (await reachable(this.route.port)) {
        openedAt = Date.now();
        this.report({ status: "up", port: this.route.port });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill(); throw new Error("SSH forwarding did not open in time.");
  }
  private descriptorCommand(): string {
    const executable = this.route.platform === "darwin" ? "Tau.app/Contents/MacOS/Tau" : "tau";
    return `ELECTRON_RUN_AS_NODE=1 ${root}/current/${executable} -e ${shellQuote('const fs=require("fs");const limit=Date.now()+30000;function probe(){if(Date.now()>limit){console.error("Tau service did not become ready; inspect its service log");process.exit(1);}let d;try{d=JSON.parse(fs.readFileSync(process.env.HOME+"/.local/share/tau-managed/data/host.json","utf8"));}catch{setTimeout(probe,250);return;}const s=new WebSocket(d.url);let ended=false;const retry=()=>{if(ended)return;ended=true;s.close();setTimeout(probe,250);};const timer=setTimeout(retry,2000);s.onopen=()=>s.send(JSON.stringify({type:"hello",id:"probe",hello:{protocol:1,token:fs.readFileSync(d.tokenPath,"utf8").trim(),auxiliary:true}}));s.onerror=retry;s.onmessage=e=>{const f=JSON.parse(String(e.data));if(f.type==="hello-reply"&&f.reply.owner!==false){ended=true;clearTimeout(timer);console.log(JSON.stringify({url:d.url,id:f.reply.host&&f.reply.host.id}));s.close();}};}probe();')}`;
  }
  private retryLater(error: unknown): void {
    if (this.closed || this.timer) return;
    if (this.attempts >= MAX_ATTEMPTS) {
      if (this.current.status !== "failed") this.report({ status: "failed", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.start().catch(() => undefined); }, Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5)));
    this.timer.unref();
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.child?.kill(); }
}

export async function bootstrapSshHost(target: string, cacheDir: string, deviceName: string, signal?: AbortSignal, exec: SshExecutor = sshExecutor, releaseHost: typeof prepareManagedHostRelease = prepareManagedHostRelease): Promise<{ pairing: ManagedPairing; tunnel: ManagedSshTunnel }> {
  validateSshTarget(target);
  const probe = (await exec.run(target, "uname -s; uname -m", undefined, signal)).trim().split("\n").slice(-2);
  const platform: ManagedHostPlatform = probe[0] === "Linux" ? "linux" : probe[0] === "Darwin" ? "darwin" : "win32";
  if (platform === "win32") throw new Error("Managed SSH currently requires Linux or macOS. On Windows, add a WSL distribution.");
  const arch = ["aarch64", "arm64"].includes(probe[1]!) ? "arm64" : ["x86_64", "amd64"].includes(probe[1]!) ? "x64" : undefined;
  if (!arch) throw new Error(`Tau has no portable host for ${probe[1]}.`);
  const release = await releaseHost(platform, arch, cacheDir, signal);
  await exec.upload(target, release.path, signal);
  await exec.run(target, `sh -s -- ${root}/archive.part ${root}`, portableBootstrapScript(platform, release.version, release.sha512), signal);
  const route: SshRoute = { target, platform, port: await freeLocalPort() };
  const tunnel = new ManagedSshTunnel(route, exec);
  try {
    await tunnel.start(signal);
    const child = exec.spawn(target, `${managedCli(platform)} machines accept-ssh`);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", () => undefined);
    const lines = createInterface({ input: child.stdout });
    const link = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The remote host did not offer a pairing link.")), 30_000);
      const abort = () => { child.kill(); reject(new Error("SSH setup was cancelled.")); };
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(new Error("The remote pairing command stopped.")); });
      lines.on("line", (line) => {
        let value: { type: string; urls?: { url: string }[]; message?: string };
        try { value = JSON.parse(line); } catch { return; }
        if (value.type === "ready") child.stdin.write(`${JSON.stringify({ type: "link", label: deviceName, access: "full" })}\n`);
        if (value.type === "error") { clearTimeout(timeout); reject(new Error(value.message ?? "The remote host cannot pair.")); }
        if (value.type === "link") {
          clearTimeout(timeout); signal?.removeEventListener("abort", abort);
          const payload = parsePairingPayload(value.urls?.[0]?.url ?? "");
          if (!payload) { reject(new Error("The remote host offered an invalid pairing link.")); return; }
          const endpoint = { url: `http://127.0.0.1:${tunnel.route.port}/` };
          resolve(pairingUrl(endpoint, { ...payload, endpoints: [endpoint] }));
        }
      });
    }).catch((error) => { child.kill(); throw error; });
    return { tunnel, pairing: { link, route: tunnel.route, async finish() {
      if (child.exitCode !== null) return;
      const ended = new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2_000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
      child.stdin.end(`${JSON.stringify({ type: "done" })}\n`); await ended; lines.close();
    }, close() { child.kill(); lines.close(); } } };
  } catch (error) { tunnel.close(); throw error; }
}
