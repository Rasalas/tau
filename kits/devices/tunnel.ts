import type { ChildProcess } from "node:child_process";
import type { OwnedProcessInput } from "tau/host-extension";
import type { TunnelState } from "./protocol.js";
import { stop } from "./process.js";

/** Each port on the remote loopback reaches the same port on this machine's loopback. No option touches host-key checking. */
export function tunnelArgs(ssh: string, ports: readonly number[]): string[] {
  return [
    "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
    ...ports.flatMap((port) => ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`]),
    "--", ssh,
  ];
}
/** `ssh -N` prints nothing once its forwards are up; surviving past the connect timeout is the signal. */
export const TUNNEL_TIMING = { runningAfter: 12_000, stableAfter: 60_000, firstRetry: 1_000, maxRetry: 60_000 };

/**
 * One SSH session that carries a machine's forwarded ports, apart from its hub's
 * session, so a remote port already in use never stops the hub. It restarts with
 * a bounded backoff after it exits and ends with `stop()` or with Tau, as an owned process.
 */
export class PortTunnel {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private stopped = false;
  private current: TunnelState;
  constructor(readonly ssh: string, readonly ports: readonly number[], private own: (input: OwnedProcessInput) => ChildProcess) {
    this.current = { ports: [...ports], status: "connecting" };
    this.start();
  }
  state(): TunnelState { return structuredClone(this.current); }
  private start(): void {
    this.timer = undefined;
    if (this.stopped) return;
    this.current = { ...this.current, status: "connecting" };
    const startedAt = Date.now();
    let child: ChildProcess;
    try { child = this.own({ command: "ssh", args: tunnelArgs(this.ssh, this.ports), env: process.env }); }
    catch (error) { this.retry(startedAt, error instanceof Error ? error.message : String(error)); return; }
    this.child = child;
    let output = "", ended = false;
    child.stdin?.on("error", () => undefined);
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2000); });
    const ready = setTimeout(() => { if (this.child === child && !this.stopped) { this.failures = 0; this.current = { ports: [...this.ports], status: "running" }; } }, TUNNEL_TIMING.runningAfter);
    ready.unref?.();
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(ready);
      if (this.child !== child) return;
      this.child = undefined;
      this.retry(startedAt, output.trim() || reason);
    };
    child.on("error", (error) => end(error.message));
    child.on("close", (code) => end(`The port tunnel's ssh exited ${String(code)}.`));
  }
  private retry(startedAt: number, error: string): void {
    if (this.stopped) return;
    // A session that ran for a while starts over at the shortest delay.
    if (Date.now() - startedAt >= TUNNEL_TIMING.stableAfter) this.failures = 0;
    const delay = Math.min(TUNNEL_TIMING.firstRetry * 2 ** this.failures, TUNNEL_TIMING.maxRetry);
    this.failures++;
    this.current = { ports: [...this.ports], status: "failed", error };
    this.timer = setTimeout(() => this.start(), delay);
    this.timer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.child) stop(this.child);
    this.child = undefined;
  }
}
