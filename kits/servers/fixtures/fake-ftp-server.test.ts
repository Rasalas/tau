import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, hasCommand, runCommand } from "./run-command";
import { paths, readCalls } from "./servers-test-env.mjs";

const SERVER = join(import.meta.dirname, "fake-ftp-server.mjs");
const hasCurl = hasCommand("curl", ["--version"]);
const hasOpenssl = hasCommand("openssl", ["version"]);

interface Running { child: ChildProcess; port: number; cert: string | null }

/** The CLI in its own process: ftp-srv installs signal handlers that exit whatever process it runs in. */
function startCli(dir: string, args: string[]): Promise<Running> {
  const child = spawn(process.execPath, [SERVER, "--dir", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake-ftp-server exited with ${code}: ${output}`)));
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.startsWith("{"));
      if (!line || !output.includes("\n")) return;
      child.removeAllListeners("exit");
      const state = JSON.parse(line) as { port: number; cert: string | null };
      resolve({ child, port: state.port, cert: state.cert });
    });
  });
}

async function stop(running: Running | undefined) {
  if (!running || running.child.exitCode !== null) return;
  const exited = new Promise((resolve) => running.child.once("exit", resolve));
  running.child.kill("SIGTERM");
  await exited;
}

const curl = (args: string[]) => runCommand("curl", ["-sS", "--max-time", "20", "--user", "tester:test", ...args], { env: cleanEnv() });

describe.skipIf(!hasCurl)("the fake FTP server", () => {
  let dir: string;
  let running: Running | undefined;

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "tau-fake-ftp-")); });
  afterEach(async () => { await stop(running); running = undefined; });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves the fake root in plain FTP, refusing TLS", async () => {
    running = await startCli(dir, ["--mode", "plain"]);
    const listing = await curl([`ftp://127.0.0.1:${running.port}/site/`]);
    expect(listing.code, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("index.php");
    const tls = await curl(["--ssl-reqd", `ftp://127.0.0.1:${running.port}/site/`]);
    expect(tls.code).not.toBe(0);
    expect(readCalls(dir)).toContainEqual(expect.objectContaining({ tool: "ftp", event: "login", user: "tester", ok: true, tls: false }));
  });

  it.skipIf(!hasOpenssl)("uploads over explicit FTPS and logs the encrypted session", async () => {
    running = await startCli(dir, ["--mode", "explicit"]);
    expect(running.cert).toBe(join(paths(dir).tls, "cert.pem"));
    const local = join(dir, "upload.txt");
    writeFileSync(local, "over tls\n");
    const upload = await curl(["--ssl-reqd", "--cacert", running.cert as string, "-T", local, `ftp://127.0.0.1:${running.port}/site/upload.txt`]);
    expect(upload.code, upload.stderr).toBe(0);
    expect(readFileSync(join(paths(dir).root, "site", "upload.txt"), "utf8")).toBe("over tls\n");
    expect(readCalls(dir)).toContainEqual(expect.objectContaining({ event: "command", directive: "STOR", arg: "upload.txt", tls: true }));
    expect(readFileSync(paths(dir).calls, "utf8")).not.toContain("tester:test");
    expect(readCalls(dir).filter((call) => call.directive === "PASS").every((call) => call.arg === "********")).toBe(true);
  });

  it.skipIf(!hasOpenssl)("refuses a plain login when TLS is required", async () => {
    running = await startCli(dir, ["--mode", "explicit", "--require-tls"]);
    const plain = await curl([`ftp://127.0.0.1:${running.port}/site/`]);
    expect(plain.code).not.toBe(0);
    expect(readCalls(dir)).toContainEqual(expect.objectContaining({ event: "login", ok: false, reason: "TLS required" }));
  });

  it.skipIf(!hasOpenssl)("speaks implicit FTPS", async () => {
    running = await startCli(dir, ["--mode", "implicit"]);
    const listing = await curl(["--cacert", running.cert as string, `ftps://127.0.0.1:${running.port}/site/`]);
    expect(listing.code, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("index.php");
  });

  it("forgets its state file when stopped", async () => {
    running = await startCli(dir, ["--mode", "plain"]);
    expect(existsSync(paths(dir).ftpState)).toBe(true);
    await stop(running);
    expect(existsSync(paths(dir).ftpState)).toBe(false);
  });
});
