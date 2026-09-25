import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, runCommand } from "./run-command";
import { readCalls, serversInstanceEnv } from "./servers-test-env.mjs";

const SECURITY = join(import.meta.dirname, "fake-security.mjs");
const SECRET_TOOL = join(import.meta.dirname, "fake-secret-tool.mjs");

/**
 * The process trace: a preload that records every attempt to start a process
 * (and refuses it), plus a `security` first on PATH that leaves a marker.
 */
function writeTrace(dir: string) {
  const trace = join(dir, "spawn-trace.log");
  const tracer = join(dir, "tracer.mjs");
  writeFileSync(tracer, [
    "import childProcess from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
    `  childProcess[name] = (...args) => { appendFileSync(${JSON.stringify(trace)}, JSON.stringify([name, ...args.filter((arg) => typeof arg === 'string' || Array.isArray(arg))]) + '\\n'); throw new Error('spawn refused by the test trace'); };`,
    "}",
    "syncBuiltinESMExports();",
  ].join("\n"));
  const trapBin = join(dir, "trap-bin");
  const marker = join(dir, "real-security-ran");
  mkdirSync(trapBin, { recursive: true });
  for (const name of ["security", "secret-tool"]) {
    writeFileSync(join(trapBin, name), `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 99\n`);
    chmodSync(join(trapBin, name), 0o755);
  }
  return { trace, tracer, marker, path: `${trapBin}:${process.env.PATH}` };
}

describe("the keychain stubs", () => {
  let dir: string;
  let traced: ReturnType<typeof writeTrace>;
  const stub = (script: string, args: string[], input?: string) => runCommand(process.execPath, ["--import", pathToFileURL(traced.tracer).href, script, ...args], {
    env: cleanEnv({ PATH: traced.path, FAKE_SERVERS_STATE: dir }),
    input,
  });
  const security = (args: string[], input?: string) => stub(SECURITY, args, input);
  const secretTool = (args: string[], input?: string) => stub(SECRET_TOOL, args, input);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-fake-keychain-"));
    traced = writeTrace(dir);
  });

  afterAll(() => {
    // Neither stub started a process, least of all the real `security` or `secret-tool`.
    expect(existsSync(traced.trace) ? readFileSync(traced.trace, "utf8") : "").toBe("");
    expect(existsSync(traced.marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("has a trace that sees a spawn (control)", async () => {
    const control = mkdtempSync(join(tmpdir(), "tau-fake-keychain-control-"));
    try {
      const probe = writeTrace(control);
      const source = "import { spawnSync } from 'node:child_process'; try { spawnSync('security', ['help']); } catch {}";
      await runCommand(process.execPath, ["--import", pathToFileURL(probe.tracer).href, "--input-type=module", "-e", source], { env: cleanEnv({ PATH: probe.path }) });
      expect(readFileSync(probe.trace, "utf8")).toContain('"security"');
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  it("is what an instance runs instead of /usr/bin/security and secret-tool", () => {
    const env = serversInstanceEnv(dir);
    expect(env.TAU_SERVERS_SECURITY_COMMAND).toBe(SECURITY);
    expect(env.TAU_SERVERS_SECRET_TOOL_COMMAND).toBe(SECRET_TOOL);
  });

  it("answers a missing item the way security does", async () => {
    const result = await security(["find-generic-password", "-g", "-s", "vscode-sftp", "-a", "sftp://tester@127.0.0.1:22/site"]);
    expect(result.code).toBe(44);
    expect(result.stderr).toContain("could not be found in the keychain");
  });

  it("adds an item and prints it back with -g, the password on stderr", async () => {
    const account = "sftp://tester@127.0.0.1:2222/site";
    expect((await security(["add-generic-password", "-s", "vscode-sftp", "-a", account, "-l", "tester@127.0.0.1 (site)", "-w", "s3cret pw"])).code).toBe(0);
    const found = await security(["find-generic-password", "-g", "-s", "vscode-sftp", "-a", account]);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain('class: "genp"');
    expect(found.stdout).toContain(`"acct"<blob>="${account}"`);
    expect(found.stdout).toContain('"svce"<blob>="vscode-sftp"');
    expect(found.stdout).toMatch(/"mdat"<timedate>=0x[0-9A-F]+ {2}"\d{14}Z\\000"/u);
    expect(found.stderr).toBe('password: "s3cret pw"\n');
    expect((await security(["find-generic-password", "-s", "vscode-sftp", "-w"])).stdout).toBe("s3cret pw\n");
  });

  it("prints a non-ASCII password as hex with an octal-escaped copy", async () => {
    await security(["add-generic-password", "-s", "vscode-sftp", "-a", "ftp://u@h:21", "-w", "kä"]);
    const found = await security(["find-generic-password", "-g", "-s", "vscode-sftp", "-a", "ftp://u@h:21"]);
    expect(found.stderr).toBe('password: 0x6BC3A4  "k\\303\\244"\n');
  });

  it("refuses a duplicate without -U and updates with it, via -i on stdin", async () => {
    const duplicate = await security(["add-generic-password", "-s", "vscode-sftp", "-a", "ftp://u@h:21", "-w", "x"]);
    expect(duplicate.code).toBe(45);
    const interactive = await security(["-i"], 'add-generic-password -U -s vscode-sftp -a "ftp://u@h:21" -l "u@h" -w "new \\"quoted\\" pw"\n');
    expect(interactive.code, interactive.stderr).toBe(0);
    expect((await security(["find-generic-password", "-g", "-s", "vscode-sftp", "-a", "ftp://u@h:21"])).stderr).toBe('password: "new "quoted" pw"\n');
  });

  it("dumps attributes only and deletes", async () => {
    const dump = await security(["dump-keychain"]);
    expect(dump.stdout).toContain("ftp://u@h:21");
    expect(dump.stdout + dump.stderr).not.toContain("password:");
    expect((await security(["dump-keychain", "-d"])).code).toBe(2);
    const deleted = await security(["delete-generic-password", "-s", "vscode-sftp", "-a", "ftp://u@h:21"]);
    expect(deleted.stdout).toContain("password has been deleted.");
    expect((await security(["find-generic-password", "-s", "vscode-sftp", "-a", "ftp://u@h:21"])).code).toBe(44);
  });

  it("simulates nothing else", async () => {
    expect((await security(["unlock-keychain"])).code).toBe(2);
    expect((await security(["add-generic-password", "-s", "a", "-a", "b", "-w"])).code).toBe(2);
  });

  it("keeps secret-tool items: store from stdin, lookup, search, clear", async () => {
    expect((await secretTool(["store", "--label=tau-servers", "service", "tau-servers", "account", "sftp://tester@127.0.0.1:22/site"], "linux pw")).code).toBe(0);
    const lookup = await secretTool(["lookup", "service", "tau-servers", "account", "sftp://tester@127.0.0.1:22/site"]);
    expect(lookup).toMatchObject({ code: 0, stdout: "linux pw" });
    expect((await secretTool(["search", "service", "tau-servers"])).stdout).toContain("attribute.account = sftp://tester@127.0.0.1:22/site");
    expect((await secretTool(["clear", "service", "tau-servers"])).code).toBe(0);
    expect(await secretTool(["lookup", "service", "tau-servers"])).toMatchObject({ code: 1, stdout: "" });
    expect((await secretTool(["lock"])).code).toBe(2);
  });

  it("logs every call, never a password, and stores none in the clear", () => {
    const calls = readCalls(dir);
    expect(calls.filter((call) => call.tool === "security").length).toBeGreaterThan(5);
    expect(calls.filter((call) => call.tool === "secret-tool").length).toBeGreaterThan(3);
    const everything = readFileSync(join(dir, "calls.log"), "utf8") + readFileSync(join(dir, "keychain.json"), "utf8") + readFileSync(join(dir, "secret-tool.json"), "utf8");
    for (const secret of ["s3cret pw", "quoted", "linux pw"]) expect(everything).not.toContain(secret);
  });
});
