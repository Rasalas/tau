import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialAskpassSource, FOREIGN_SERVICE, OWN_SERVICE, ServerCredentials, isAuthFailure, itemLabel, loginAccount, providerCall, secretAccount, type CredentialProject } from "./credentials.js";
import { SecurityKeychain, SecretToolStore, runProcess, type ProcessRunner } from "./keychain.js";
import type { ServerPrompts } from "./prompts.js";
import type { ServerPromptAnswer, ServerPromptRequest } from "./protocol.js";
import { readSftpJson, type SftpJsonTarget } from "./sftp-json.js";

const SECURITY = join(import.meta.dirname, "fixtures", "fake-security.mjs");
const SECRET_TOOL = join(import.meta.dirname, "fixtures", "fake-secret-tool.mjs");
const PASSWORD = "Tau-Test-Pw-7c1e";

type Answerer = (request: ServerPromptRequest) => ServerPromptAnswer;

let dir: string;
let root: string;
let asked: ServerPromptRequest[];
let script: Answerer[];
let calls: { command: string; args: readonly string[] }[];

const prompts = { ask: async (request: ServerPromptRequest) => {
  asked.push(request);
  const next = script.shift();
  if (!next) throw new Error(`unexpected question: ${request.title}`);
  return next(request);
} } as unknown as ServerPrompts;
const confirm: Answerer = () => ({ action: "confirm" });
const decline: Answerer = () => ({ action: "cancel" });
const type = (value: string): Answerer => () => ({ action: "confirm", value });

const recording: ProcessRunner = (command, args, options) => {
  calls.push({ command, args });
  return runProcess(command, args, options);
};

const stubEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: dir, FAKE_SERVERS_STATE: join(dir, "servers"),
  TAU_SERVERS_SECURITY_COMMAND: SECURITY, TAU_SERVERS_SECRET_TOOL_COMMAND: SECRET_TOOL, TAU_SERVERS_LOOPBACK_ONLY: "1", ...extra,
});

function credentials(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; findCommand?: (name: string) => string | undefined } = {}) {
  return new ServerCredentials({
    prompts, targetsDir: join(dir, "state", "targets"), run: recording,
    env: options.env ?? stubEnv(), platform: options.platform ?? "darwin", findCommand: options.findCommand ?? (() => undefined),
  });
}

const keychain = () => new SecurityKeychain(SECURITY, runProcess, stubEnv());
const project: () => CredentialProject = () => ({ root, workspaceId: "ws-1" });

async function target(config: Record<string, unknown>): Promise<SftpJsonTarget> {
  const text = JSON.stringify({ protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv", name: "site", ...config });
  await writeFile(join(root, ".vscode", "sftp.json"), text);
  return readSftpJson(text).targets[0]!;
}

async function filesContaining(value: string): Promise<string[]> {
  const hits: string[] = [];
  for (const name of await readdir(dir, { recursive: true })) {
    if (name.endsWith("sftp.json")) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    if (text.includes(value)) hits.push(name);
  }
  return hits;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tau-servers-credentials-"));
  root = join(dir, "project");
  await mkdir(join(root, ".vscode"), { recursive: true });
  asked = [];
  script = [];
  calls = [];
});

afterEach(async () => {
  // No secret anywhere on disk but the stub's base64 store and the fixture's own sftp.json.
  expect(await filesContaining(PASSWORD)).toEqual([]);
  expect(calls.some((call) => call.command === "/usr/bin/security" || call.command.endsWith("/security"))).toBe(false);
  expect(script).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

describe("keys", () => {
  it("names items the way the fork does", async () => {
    const named = await target({});
    expect(loginAccount(named)).toBe("sftp://tester@127.0.0.1:2222");
    expect(secretAccount(named, "password")).toBe("sftp://tester@127.0.0.1:2222/site");
    expect(secretAccount({ ...named, name: "a/b" }, "password")).toBe("sftp://tester@127.0.0.1:2222/a_b");
    expect(secretAccount({ ...named, privateKeyPath: "/k/id_ed25519" }, "passphrase")).toBe("/k/id_ed25519");
    expect(itemLabel("sftp://tester@127.0.0.1:2222/site", "password")).toBe("tester@127.0.0.1 (site)");
    expect(itemLabel("/k/id_ed25519", "passphrase")).toBe("id_ed25519 (SSH key passphrase)");
    expect(providerCall("1password", undefined, { service: "vscode-sftp", account: "sftp://u@h:22/s" }).args).toEqual(["item", "get", "vscode-sftp/sftp/u@h:22/s", "--fields", "password", "--reveal"]);
    expect(providerCall("1password", "op://Private/S/password", { service: "vscode-sftp", account: "x" }).args).toEqual(["read", "op://Private/S/password"]);
  });
});

describe("VS Code's keychain item", () => {
  it("is read after one consent and then without a question", async () => {
    const site = await target({});
    await keychain().set({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "tester@127.0.0.1 (site)" }, PASSWORD);
    const store = credentials();
    script = [confirm];
    const first = store.attempt(project(), site);
    expect(await first.secret("password")).toBe(PASSWORD);
    expect(asked.map((request) => request.kind)).toEqual(["confirm"]);
    expect(asked[0]!.detail).toBe("vscode-sftp · sftp://tester@127.0.0.1:2222/site");
    await first.accepted();
    // A new host process: no session memory, the consent is on disk.
    const again = credentials().attempt(project(), site);
    expect(await again.secret("password")).toBe(PASSWORD);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, "state", "targets", "ws-1", "credentials.json"), "utf8")).items).toEqual(["vscode-sftp\nsftp://tester@127.0.0.1:2222/site"]);
    // Tau copies nothing of it into its own item.
    expect(await keychain().has({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(false);
  });

  it("falls back to the login without the name, and a declined consent asks for the password", async () => {
    const site = await target({});
    await keychain().set({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222", label: "tester@127.0.0.1" }, PASSWORD);
    script = [confirm];
    expect(await credentials().attempt(project(), site).secret("password")).toBe(PASSWORD);
    script = [decline, type("typed")];
    const declined = new ServerCredentials({ prompts, targetsDir: join(dir, "other-state"), run: recording, env: stubEnv(), platform: "darwin", findCommand: () => undefined });
    expect(await declined.attempt(project(), site).secret("password")).toBe("typed");
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "confirm", "secret"]);
  });

  it("is skipped for the session once the server turned it down, and other items on the login come only on a click", async () => {
    const site = await target({});
    const k = keychain();
    await k.set({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "x" }, "stale");
    await k.set({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/other-site", label: "y" }, PASSWORD);
    const store = credentials();
    script = [confirm];
    const attempt = store.attempt(project(), site);
    expect(await attempt.secret("password")).toBe("stale");
    script = [() => ({ action: "alternative" })];
    // ssh asking again means the server said no.
    expect(await attempt.secret("password")).toBe(PASSWORD);
    expect(asked[1]!.message).toMatch(/did not accept/u);
    expect(asked[1]!.alternativeLabel).toBeDefined();
    await attempt.accepted();
    // The borrowed one is kept as Tau's own, as the fork does after a click.
    expect(await k.get({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(PASSWORD);
    expect(calls.some((call) => call.args[0] === "dump-keychain")).toBe(true);
    expect(calls.some((call) => call.args.includes("-d"))).toBe(false);
  });
});

describe("a typed password", () => {
  it("with \"vscode\" is asked once and kept as a tau-servers item after the server accepted it", async () => {
    const site = await target({ passwordManager: "vscode" });
    script = [type(PASSWORD)];
    const attempt = credentials().attempt(project(), site);
    expect(await attempt.secret("password")).toBe(PASSWORD);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.alternativeLabel).toBeUndefined();
    expect(await keychain().has({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(false);
    await attempt.accepted();
    expect(await keychain().get({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(PASSWORD);
    expect(await credentials().attempt(project(), site).secret("password")).toBe(PASSWORD);
    expect(asked).toHaveLength(1);
    // VS Code's store is never looked at for "vscode".
    expect(calls.some((call) => call.args.includes(FOREIGN_SERVICE.password))).toBe(false);
  });

  it("that the server rejects is forgotten, and asking again replaces it", async () => {
    const site = await target({ passwordManager: "keychain" });
    const own = { service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "x" };
    await keychain().set(own, "wrong");
    const attempt = credentials().attempt(project(), site);
    expect(await attempt.secret("password")).toBe("wrong");
    await attempt.rejected();
    expect(await keychain().has(own)).toBe(false);
    script = [type(PASSWORD)];
    const next = credentials().attempt(project(), site);
    expect(await next.secret("password")).toBe(PASSWORD);
    await next.accepted();
    expect(await keychain().get(own)).toBe(PASSWORD);
  });

  it("with false stays in memory only, and Tau's old item goes", async () => {
    const own = { service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "x" };
    await keychain().set(own, "old");
    const site = await target({ passwordManager: false });
    const store = credentials();
    script = [type(PASSWORD)];
    const attempt = store.attempt(project(), site);
    expect(await attempt.secret("password")).toBe(PASSWORD);
    await attempt.accepted();
    expect(await keychain().has(own)).toBe(false);
    expect(await store.attempt(project(), site).secret("password")).toBe(PASSWORD);
    expect(asked).toHaveLength(1);
    expect((await store.status(project(), site)).password).toMatchObject({ session: true });
  });

  it("on Linux goes to the Secret Service, on Windows nowhere", async () => {
    const site = await target({});
    script = [type(PASSWORD)];
    const linux = credentials({ platform: "linux" }).attempt(project(), site);
    await linux.secret("password");
    await linux.accepted();
    expect(await new SecretToolStore(SECRET_TOOL, runProcess, stubEnv()).get({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(PASSWORD);
    script = [type(PASSWORD)];
    const windows = credentials({ platform: "win32" });
    const attempt = windows.attempt(project(), site);
    await attempt.secret("password");
    await attempt.accepted();
    expect((await windows.status(project(), site)).password).toMatchObject({ session: true, unavailable: expect.stringMatching(/Windows/u) });
  });

  it("for a jump host is asked and never kept", async () => {
    const site = await target({ passwordManager: "vscode" });
    script = [type(PASSWORD)];
    const attempt = credentials().attempt(project(), site);
    expect(await attempt.secret("password", { host: "jump.example" })).toBe(PASSWORD);
    await attempt.accepted();
    expect(await keychain().has({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(false);
  });

  it("is cancelled with the dialog", async () => {
    const site = await target({ passwordManager: "vscode" });
    script = [decline];
    expect(await credentials().attempt(project(), site).secret("password")).toBeUndefined();
  });
});

describe("the key passphrase", () => {
  it("reads the fork's passphrase item keyed by the key file", async () => {
    const site = await target({ privateKeyPath: "/keys/id_ed25519", passphrase: true });
    await keychain().set({ service: FOREIGN_SERVICE.passphrase, account: "/keys/id_ed25519", label: "id_ed25519 (SSH key passphrase)" }, PASSWORD);
    script = [confirm];
    expect(await credentials().attempt(project(), site).secret("passphrase")).toBe(PASSWORD);
    expect(asked[0]!.title).toContain("id_ed25519 (SSH key passphrase)");
  });
});

describe("commands from sftp.json", () => {
  it("run only after the project allowed them, and a changed command asks again", async () => {
    const site = await target({ passwordCommand: `printf '%s\\n' ${PASSWORD}` });
    script = [decline, type("typed instead")];
    expect(await credentials().attempt(project(), site).secret("password")).toBe("typed instead");
    expect(asked[0]!.detail).toBe(`printf '%s\\n' ${PASSWORD}`);
    expect(calls.some((call) => call.command === "/bin/sh")).toBe(false);
    script = [confirm];
    expect(await credentials().attempt(project(), site).secret("password")).toBe(PASSWORD);
    expect(await credentials().attempt(project(), site).secret("password")).toBe(PASSWORD);
    expect(asked).toHaveLength(3);
    const changed = await target({ passwordCommand: "printf other" });
    script = [confirm];
    expect(await credentials().attempt(project(), changed).secret("password")).toBe("other");
    expect(asked).toHaveLength(4);
    const status = await credentials().status(project(), changed);
    expect(status.password).toMatchObject({ command: "allowed", source: "The password command in sftp.json" });
  });

  it("run a password manager's CLI by its fixed call, and never one in a test instance", async () => {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const pass = join(bin, "pass");
    await writeFile(pass, `#!/bin/sh\n[ "$1" = show ] && [ "$2" = servers/site ] && printf 'pass-secret\\nurl: x\\n'\n`);
    await chmod(pass, 0o755);
    const site = await target({ passwordManager: "pass:servers/site" });
    const free = credentials({ env: { PATH: process.env.PATH }, findCommand: (name) => (name === "pass" ? pass : undefined) });
    script = [confirm];
    expect(await free.attempt(project(), site).secret("password")).toBe("pass-secret");
    expect(asked[0]!.detail).toBe("pass show servers/site");
    const guarded = credentials({ findCommand: (name) => (name === "pass" ? pass : undefined) });
    await expect(guarded.attempt(project(), site).secret("password")).rejects.toThrow(/test instance never runs a real pass/u);
  });

  it("write a typed password through passwordWriteCommand, which starts empty", async () => {
    // The user's own vault: a file by their choice, so not the test password.
    const vault = join(dir, "vault");
    const site = await target({ passwordCommand: `cat '${vault}'`, passwordWriteCommand: `cat > '${vault}'` });
    script = [confirm, type("vault-secret"), confirm];
    const attempt = credentials().attempt(project(), site);
    expect(await attempt.secret("password")).toBe("vault-secret");
    await attempt.accepted();
    expect(asked.map((request) => request.kind)).toEqual(["confirm", "secret", "confirm"]);
    expect(await readFile(vault, "utf8")).toBe("vault-secret");
    expect(await credentials().attempt(project(), site).secret("password")).toBe("vault-secret");
    const plain = await target({ passwordCommand: "true" });
    script = [confirm];
    await expect(credentials().attempt(project(), plain).secret("password")).rejects.toThrow(/printed nothing/u);
  });
});

describe("plain text in sftp.json", () => {
  it("is read from the file on demand, after the stores", async () => {
    const site = await target({ password: "from-the-file", passwordManager: "vscode" });
    expect(await credentials().attempt(project(), site).secret("password")).toBe("from-the-file");
    expect(await credentials().check(project(), site, "password")).toEqual({ found: true, source: "The plain text in sftp.json" });
  });
});

describe("a test instance without the keychain stub", () => {
  it("never reaches for /usr/bin/security and keeps a typed password in memory", async () => {
    const site = await target({});
    const store = credentials({ env: { PATH: process.env.PATH, TAU_SERVERS_LOOPBACK_ONLY: "1" } });
    expect(await store.check(project(), site, "password")).toMatchObject({ found: false });
    const status = await store.status(project(), site);
    expect(status.password.unavailable).toMatch(/stub/u);
    expect(calls).toEqual([]);
  });
});

describe("forgetting", () => {
  it("drops Tau's own item and the session, never VS Code's, and withdraws approvals", async () => {
    const site = await target({});
    const k = keychain();
    await k.set({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "x" }, "theirs");
    await k.set({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site", label: "x" }, "ours");
    const store = credentials();
    expect(await store.attempt(project(), site).secret("password")).toBe("ours");
    await store.forget(project(), site);
    expect(await k.has({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(false);
    expect(await k.has({ service: FOREIGN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(true);
    script = [confirm];
    expect(await store.attempt(project(), site).secret("password")).toBe("theirs");
    expect((await store.status(project(), site)).password.foreignItem).toEqual({ label: "tester@127.0.0.1 (site)", allowed: true });
    await store.forgetApprovals(project());
    expect((await store.status(project(), site)).password.foreignItem).toEqual({ label: "tester@127.0.0.1 (site)", allowed: false });
  });
});

describe("the askpass source", () => {
  it("answers ssh's password question, keeps it once the login worked and passes other questions on", async () => {
    const site = await target({ passwordManager: "vscode" });
    const store = credentials();
    const source = new CredentialAskpassSource(store, async (cwd) => {
      if (cwd !== root) throw new Error("unknown");
      return { project: project(), target: site };
    });
    const signal = new AbortController().signal;
    const ask = (attempt: number, kind = "password") => source.answer({ kind, prompt: "tester@127.0.0.1's password: ", target: { id: site.id, workspace: root }, attempt, signal });
    expect(await ask(1, "host-key")).toBeUndefined();
    expect(await source.answer({ kind: "password", target: { id: site.id }, attempt: 1, signal })).toBeUndefined();
    script = [type("wrong")];
    expect(await ask(1)).toBe("wrong");
    script = [type(PASSWORD)];
    expect(await ask(2)).toBe(PASSWORD);
    expect(asked[1]!.message).toMatch(/did not accept/u);
    await source.settled({ id: site.id, workspace: root }, { ok: true });
    expect(await keychain().get({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(PASSWORD);
    // The next login: no question at all.
    expect(await ask(1)).toBe(PASSWORD);
    // Refused from memory: the item it came from goes too, and the next login asks.
    await source.settled({ id: site.id, workspace: root }, { ok: false, message: "tester@127.0.0.1: Permission denied (password)." });
    expect(await keychain().has({ service: OWN_SERVICE.password, account: "sftp://tester@127.0.0.1:2222/site" })).toBe(false);
    script = [decline];
    expect(await ask(1)).toBeNull();
    expect(asked).toHaveLength(3);
  });

  it("tells a refused login from a network failure", () => {
    expect(isAuthFailure("tester@127.0.0.1: Permission denied (publickey,password).")).toBe(true);
    expect(isAuthFailure("ssh: connect to host 127.0.0.1 port 2222: Connection refused")).toBe(false);
  });
});
