import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairingUrl, parsePairingPayload } from "../shared/connections.js";
import { bootstrapSshHost, managedCli, managedSshArgs, validateSshTarget, type SshExecutor } from "./managed-ssh.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fakeSsh() {
  let remotePort = 7788;
  const forwards: { child: ChildProcessWithoutNullStreams; args: string[] }[] = [];
  const servers: Server[] = [];
  cleanup.push(() => { for (const server of servers) server.close(); });
  const run = vi.fn(async (_target: string, command: string) => command === "uname -s; uname -m" ? "Linux\nx86_64\n" : command.includes("service status") ? JSON.stringify({ url: `ws://127.0.0.1:${remotePort}` }) : "installed");
  const upload = vi.fn(async () => undefined);
  const exec: SshExecutor = {
    run, upload,
    spawn(_target, _command, args) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null, kill: () => true }) as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough };
      let server: Server | undefined;
      child.kill = (() => { if (child.exitCode !== null) return true; Object.assign(child, { exitCode: 0, signalCode: "SIGTERM" }); if (server) server.close(() => child.emit("close", 0)); else queueMicrotask(() => child.emit("close", 0)); return true; }) as typeof child.kill;
      if (args) {
        const port = Number(args[1]!.split(":")[1]); server = createServer((socket) => socket.destroy()); servers.push(server); server.listen(port, "127.0.0.1");
        forwards.push({ child, args });
      } else {
        child.stdin.on("data", (data: Buffer) => {
          for (const line of data.toString().trim().split("\n")) {
            const input = JSON.parse(line) as { type: string };
            if (input.type === "link") child.stdout.write(`${JSON.stringify({ type: "link", urls: [{ url: pairingUrl(`http://127.0.0.1:${remotePort}/`, { code: "secret-link", hostId: "fake-remote" }) }] })}\n`);
            if (input.type === "done") child.kill();
          }
        });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: "ready", host: { id: "fake-remote" } })}\n`));
      }
      return child;
    },
  };
  return { exec, run, upload, forwards, movePort: (port: number) => { remotePort = port; } };
}

describe("managed SSH", () => {
  it("uses the user's SSH config with key authentication and strict known host verification", () => {
    const args = managedSshArgs("user@studio", "cat >/dev/null", ["-L", "127.0.0.1:8787:127.0.0.1:7788"]);
    expect(args).toContain("BatchMode=yes"); expect(args).toContain("StrictHostKeyChecking=yes"); expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.at(-2)).toBe("user@studio");
  });
  it("rejects SSH options, metacharacters and remote shell injection in a target", () => {
    for (const target of ["-F/tmp/config", "studio;touch /tmp/escape", "studio$(cat secret)", "studio\nother", "user@studio's"]) expect(() => validateSshTarget(target)).toThrow();
    expect(validateSshTarget("studio")).toBe("studio");
  });
  it("uses the packaged runtime and a dedicated host data directory", () => {
    expect(managedCli("linux")).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(managedCli("linux")).toContain("app.asar.unpacked/bin/tau.mjs");
    expect(managedCli("darwin")).toContain("Tau.app/Contents/MacOS/Tau");
  });
  it("bootstraps through a fake SSH server, maps its transient link onto the managed forward and closes pairing separately", async () => {
    const fake = fakeSsh();
    const release = vi.fn(async () => ({ path: "/scratch/verified.tar.gz", sha512: Buffer.alloc(64).toString("base64"), version: "1.2.3" }));
    const result = await bootstrapSshHost("studio", "/scratch/cache", "Desktop", undefined, fake.exec, release);
    cleanup.push(() => result.tunnel.close());
    expect(release).toHaveBeenCalledWith("linux", "x64", "/scratch/cache", undefined);
    expect(fake.upload).toHaveBeenCalledWith("studio", "/scratch/verified.tar.gz", undefined);
    expect(parsePairingPayload(result.pairing.link)).toMatchObject({ code: "secret-link", hostId: "fake-remote", endpoints: [{ url: `http://127.0.0.1:${result.pairing.route.port}/` }] });
    await result.pairing.finish(); result.pairing.close(); expect(fake.forwards[0]?.child.exitCode).toBeNull();
    result.tunnel.close(); expect(fake.forwards[0]?.child.exitCode).toBe(0);
  });
  it("reopens a dropped forward on the saved local port after the host changes its port", async () => {
    const fake = fakeSsh();
    const result = await bootstrapSshHost("studio", "/scratch/cache", "Desktop", undefined, fake.exec, async () => ({ path: "/scratch/verified.tar.gz", sha512: Buffer.alloc(64).toString("base64"), version: "1.2.3" }));
    cleanup.push(() => result.tunnel.close()); result.pairing.close();
    fake.movePort(7799); fake.forwards[0]!.child.kill();
    await vi.waitFor(() => expect(fake.forwards).toHaveLength(2), { timeout: 5_000 });
    expect(fake.forwards[1]!.args[1]).toBe(`127.0.0.1:${result.pairing.route.port}:127.0.0.1:7799`);
    result.tunnel.close(); await new Promise((resolve) => setTimeout(resolve, 50)); expect(fake.forwards).toHaveLength(2);
  });
  it("stops before download or upload when SSH cannot authenticate", async () => {
    const fake = fakeSsh(); fake.run.mockRejectedValueOnce(new Error("Host key verification failed"));
    const release = vi.fn(async () => ({ path: "unused", sha512: "unused", version: "1.2.3" }));
    await expect(bootstrapSshHost("studio", "/scratch/cache", "Desktop", undefined, fake.exec, release)).rejects.toThrow(/Host key/u);
    expect(release).not.toHaveBeenCalled(); expect(fake.upload).not.toHaveBeenCalled();
  });
});
