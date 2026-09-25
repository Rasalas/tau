import { spawn } from "node:child_process";

/**
 * The OS secret stores Tau reads and writes: macOS `security` and libsecret's
 * `secret-tool`. Neither ever sees a secret in argv; nothing here logs what
 * the tools print.
 */

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ProcessRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<ProcessResult>;

const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Runs a program without a shell. A `.mjs`/`.js` path (the test stubs) runs
 * under this process's own Node, so an Electron host needs no `node` on PATH.
 */
export const runProcess: ProcessRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const script = /\.(?:mjs|cjs|js)$/u.test(command);
  const env = { ...(options.env ?? process.env), ...(script ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  const child = spawn(script ? process.execPath : command, script ? [command, ...args] : [...args], {
    cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT) child.kill("SIGKILL");
    else into.push(chunk);
  };
  child.stdout.on("data", collect(out));
  child.stderr.on("data", collect(err));
  const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
  child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
  child.once("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    resolve({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input ?? "");
});

export interface SecretItem {
  service: string;
  account: string;
}

export interface LabelledSecretItem extends SecretItem {
  label: string;
}

/** A place secrets live. Errors carry exit codes, never what the tool printed about a secret. */
export interface SecretStore {
  /** For the user: "Keychain", "Secret Service". */
  readonly name: string;
  get(item: SecretItem): Promise<string | undefined>;
  /** Whether an item is there, without reading its secret. `undefined`: the store cannot say. */
  has(item: SecretItem): Promise<boolean | undefined>;
  set(item: LabelledSecretItem, value: string): Promise<void>;
  delete(item: SecretItem): Promise<void>;
  /** The accounts under a service, newest change first; only where the store lists without secrets. */
  accounts?(service: string): Promise<string[]>;
}

/** errSecItemNotFound. */
const NOT_FOUND = 44;

/**
 * The password out of `find-generic-password -g`: `password: "<raw>"` for
 * printable ASCII (inner quotes unescaped, so the outermost pair counts),
 * `password: 0x<HEX>  "<escaped>"` otherwise. `-w` can't tell hex from a
 * password that looks like hex, which is why `-g` is used.
 */
export function parseSecurityPassword(output: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.startsWith("password: "));
  if (line === undefined) return undefined;
  const value = line.slice("password: ".length).replace(/\r$/u, "");
  if (value.startsWith("0x")) {
    const hex = value.slice(2).split(/\s/u)[0] ?? "";
    return /^(?:[0-9A-Fa-f]{2})+$/u.test(hex) ? Buffer.from(hex, "hex").toString("utf8") : undefined;
  }
  const first = value.indexOf("\"");
  const last = value.lastIndexOf("\"");
  return first >= 0 && last > first ? value.slice(first + 1, last) : undefined;
}

/**
 * The accounts under `service` in a `dump-keychain` (no `-d`: attributes
 * only), newest `mdat` first. Blocks start at `keychain:`; `acct` comes
 * before `svce` within one.
 */
export function parseKeychainAccounts(output: string, service: string): string[] {
  const found: { account: string; changed: string; at: number }[] = [];
  let account: string | undefined;
  let changed = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("keychain:")) { account = undefined; changed = ""; continue; }
    const acct = /^\s*"acct"<blob>="(.*)"\s*$/u.exec(line);
    if (acct) { account = acct[1]; continue; }
    const date = /^\s*"(mdat|cdat)"<timedate>=.*"(\d{14})Z/u.exec(line);
    if (date) { if (date[1] === "mdat" || !changed) changed = date[2]!; continue; }
    const svce = /^\s*"svce"<blob>="(.*)"\s*$/u.exec(line);
    if (svce && svce[1] === service && account !== undefined) {
      found.push({ account, changed, at: found.length });
      account = undefined;
    }
  }
  return found.sort((a, b) => (a.changed === b.changed ? a.at - b.at : b.changed.localeCompare(a.changed))).map((entry) => entry.account);
}

/** One word of a `security -i` line: that parser splits on spaces and honours double quotes and backslashes. */
export function securityWord(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

const failure = (tool: string, code: number) => new Error(`${tool} failed (exit ${code}).`);

/**
 * macOS Keychain through `security`, or through the stub a test instance
 * names. A new secret goes in on stdin (`security -i`) and is read back
 * before Tau believes it: a quoting slip there stores a truncated secret.
 */
export class SecurityKeychain implements SecretStore {
  readonly name = "Keychain";
  private dump: Promise<string> | undefined;

  constructor(private readonly command: string, private readonly run: ProcessRunner = runProcess, private readonly env?: NodeJS.ProcessEnv) {}

  private call(args: readonly string[], input?: string): Promise<ProcessResult> {
    return this.run(this.command, args, { ...(input === undefined ? {} : { input }), ...(this.env ? { env: this.env } : {}), timeoutMs: 15_000 });
  }

  async get(item: SecretItem): Promise<string | undefined> {
    const result = await this.call(["find-generic-password", "-g", "-s", item.service, "-a", item.account]);
    if (result.code === NOT_FOUND) return undefined;
    if (result.code !== 0) throw failure("security", result.code);
    const value = parseSecurityPassword(`${result.stderr}\n${result.stdout}`);
    if (value === undefined) throw new Error("security printed no password Tau could read.");
    return value;
  }

  async has(item: SecretItem): Promise<boolean> {
    const result = await this.call(["find-generic-password", "-s", item.service, "-a", item.account]);
    if (result.code === NOT_FOUND) return false;
    if (result.code !== 0) throw failure("security", result.code);
    return true;
  }

  async set(item: LabelledSecretItem, value: string): Promise<void> {
    if (/[\r\n]/u.test(value)) throw new Error("The Keychain cannot take a secret with a line break through security.");
    const line = ["add-generic-password", "-U", "-s", securityWord(item.service), "-a", securityWord(item.account), "-l", securityWord(item.label), "-w", securityWord(value)].join(" ");
    const result = await this.call(["-i"], `${line}\n`);
    this.dump = undefined;
    if (result.code !== 0) throw failure("security", result.code);
    if (await this.get(item) !== value) {
      await this.delete(item).catch(() => undefined);
      throw new Error("The Keychain did not keep the secret unchanged, so Tau removed it again.");
    }
  }

  async delete(item: SecretItem): Promise<void> {
    const result = await this.call(["delete-generic-password", "-s", item.service, "-a", item.account]);
    this.dump = undefined;
    if (result.code !== 0 && result.code !== NOT_FOUND) throw failure("security", result.code);
  }

  async accounts(service: string): Promise<string[]> {
    this.dump ??= this.call(["dump-keychain"]).then((result) => (result.code === 0 ? result.stdout : ""), () => "");
    return parseKeychainAccounts(await this.dump, service);
  }
}

/**
 * libsecret through `secret-tool`, attributes `service` and `account`. The
 * secret goes in on stdin. There is no listing: `search` prints secrets.
 */
export class SecretToolStore implements SecretStore {
  readonly name = "Secret Service";

  constructor(private readonly command: string, private readonly run: ProcessRunner = runProcess, private readonly env?: NodeJS.ProcessEnv) {}

  private call(args: readonly string[], input?: string): Promise<ProcessResult> {
    return this.run(this.command, args, { ...(input === undefined ? {} : { input }), ...(this.env ? { env: this.env } : {}), timeoutMs: 15_000 });
  }

  async get(item: SecretItem): Promise<string | undefined> {
    const result = await this.call(["lookup", "service", item.service, "account", item.account]);
    if (result.code !== 0 || result.stdout === "") return undefined;
    return result.stdout;
  }

  has(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  async set(item: LabelledSecretItem, value: string): Promise<void> {
    const result = await this.call(["store", `--label=${item.label}`, "service", item.service, "account", item.account], value);
    if (result.code !== 0) throw failure("secret-tool", result.code);
    if (await this.get(item) !== value) {
      await this.delete(item).catch(() => undefined);
      throw new Error("The Secret Service did not keep the secret unchanged, so Tau removed it again.");
    }
  }

  async delete(item: SecretItem): Promise<void> {
    const result = await this.call(["clear", "service", item.service, "account", item.account]);
    if (result.code !== 0) throw failure("secret-tool", result.code);
  }
}
