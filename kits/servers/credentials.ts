import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { HostCommandError, readPersistedJson, writePersistedJson, type HostExtensionContext, type PersistedJsonLogger } from "tau/host-extension";
import { SecretToolStore, SecurityKeychain, runProcess, type LabelledSecretItem, type ProcessRunner, type SecretItem, type SecretStore } from "./keychain.js";
import type { ServerPrompts } from "./prompts.js";
import { readPromptAnswer } from "./prompts.js";
import type { CredentialCheck, CredentialSecretStatus, CredentialStatus, SecretKind } from "./protocol.js";
import { SFTP_JSON_PATH, sftpJsonSecrets, type CredentialSpec, type SftpJsonTarget } from "./sftp-json.js";
import { isStoreSegment } from "./store.js";

/**
 * Where a target's password and key passphrase come from, after the
 * danielratzinger fork of vscode-sftp: `passwordCommand`, then
 * `passwordManager`, then a plain-text `password`, then a question. Tau reads
 * the fork's keychain items (`vscode-sftp`) only after the user allowed it,
 * writes only its own (`tau-servers`), runs a command from sftp.json only
 * after the project was allowed to, and keeps a typed secret only once the
 * server accepted it. No secret goes to a file, a log or an event.
 */

export const FOREIGN_SERVICE: Readonly<Record<SecretKind, string>> = { password: "vscode-sftp", passphrase: "vscode-sftp-passphrase" };
export const OWN_SERVICE: Readonly<Record<SecretKind, string>> = { password: "tau-servers", passphrase: "tau-servers-passphrase" };
/** A test instance's stand-ins for `/usr/bin/security` and `secret-tool`. */
export const SECURITY_COMMAND_ENV = "TAU_SERVERS_SECURITY_COMMAND";
export const SECRET_TOOL_COMMAND_ENV = "TAU_SERVERS_SECRET_TOOL_COMMAND";
const LOOPBACK_ENV = "TAU_SERVERS_LOOPBACK_ONLY";
const REAL_SECURITY = "/usr/bin/security";

export type CredentialTarget = Pick<SftpJsonTarget, "id" | "index" | "protocol" | "host" | "port" | "password">
  & Partial<Pick<SftpJsonTarget, "name" | "profile" | "username" | "passphrase" | "privateKeyPath">>;

export interface CredentialProject {
  /** The main checkout, where sftp.json is and commands run. */
  root: string;
  workspaceId: string;
}

/** `<protocol>://<user>@<host>:<port>`: the login every project on it shares. */
export function loginAccount(target: CredentialTarget): string {
  return `${target.protocol}://${target.username ?? ""}@${target.host}:${target.port}`;
}

/** The fork's account: the login plus `/<name>` (a `/` in it becomes `_`); a passphrase is keyed by its key file. */
export function secretAccount(target: CredentialTarget, kind: SecretKind): string {
  if (kind === "passphrase") return target.privateKeyPath || loginAccount(target);
  const name = (target.name ?? "").trim().replace(/\//gu, "_");
  return name ? `${loginAccount(target)}/${name}` : loginAccount(target);
}

/** What Keychain Access shows as the name: `user@host (name)`, or the key file for a passphrase. */
export function itemLabel(account: string, kind: SecretKind): string {
  if (kind === "passphrase") return `${basename(account) || account} (SSH key passphrase)`;
  const parsed = /^[a-z]+:\/\/(?:([^@]*)@)?([^/]*)(?:\/(.*))?$/iu.exec(account);
  if (!parsed) return account;
  const host = parsed[2]!.replace(/:\d+$/u, "");
  const server = parsed[1] ? `${parsed[1]}@${host}` : host;
  return parsed[3] ? `${server} (${parsed[3]})` : server;
}

type ProviderName = "secret-tool" | "1password" | "pass" | "gopass" | "bitwarden";
const PROVIDERS: readonly ProviderName[] = ["secret-tool", "1password", "pass", "gopass", "bitwarden"];

/** A read-only manager's call, as the fork builds it: an explicit reference, else a name derived from the item. */
export function providerCall(name: ProviderName, ref: string | undefined, item: SecretItem): { program: string; args: string[]; firstLine: boolean } {
  const derived = `${item.service}/${item.account.replace("://", "/").replace(/\/+/gu, "/").replace(/^\//u, "")}`;
  switch (name) {
    case "secret-tool": return { program: "secret-tool", args: ["lookup", "service", ref || item.service, "account", item.account], firstLine: false };
    case "1password": return ref ? { program: "op", args: ["read", ref], firstLine: false } : { program: "op", args: ["item", "get", derived, "--fields", "password", "--reveal"], firstLine: false };
    case "pass": return { program: "pass", args: ["show", ref || derived], firstLine: true };
    case "gopass": return { program: "gopass", args: ["show", "-o", ref || derived], firstLine: false };
    case "bitwarden": return { program: "bw", args: ["get", "password", ref || derived], firstLine: false };
  }
}

/** Output is the secret: one trailing line break goes, nothing else. */
const secretOf = (stdout: string, firstLine = false) => (firstLine ? stdout.split(/\r?\n/u)[0] ?? "" : stdout.replace(/\r?\n$/u, ""));

export class CredentialError extends HostCommandError {}

type SourceKind = "session" | "command" | "provider" | "own" | "foreign" | "sibling" | "file" | "typed" | "hop";

interface Answer {
  value: string;
  source: SourceKind;
  item?: SecretItem;
}

interface Plan {
  off?: boolean;
  provider?: { name: ProviderName; call: { program: string; args: string[]; firstLine: boolean }; path?: string };
  /** Where Tau keeps what the user typed. */
  own?: SecretStore;
  /** Where the fork keeps its items; only the keychain Tau can read. */
  foreign?: SecretStore;
  unavailable?: string;
}

/** One connection's use of a target's secrets. The transport reports how the server answered. */
export interface CredentialAttempt {
  /**
   * The secret ssh (or FTP) asks for; `undefined` when the user cancelled.
   * Asked again for the same kind, the last answer counts as rejected and the
   * user is asked. A `host` other than the target's (a hop) is asked and never kept.
   */
  secret(kind: SecretKind, options?: { host?: string; signal?: AbortSignal }): Promise<string | undefined>;
  /** The server let us in: a typed secret goes to its store, every answer into this session's memory. */
  accepted(): Promise<void>;
  /** Authentication failed: Tau's own item is forgotten, a foreign one is skipped for this session. */
  rejected(): Promise<void>;
}

interface TrustFile extends Record<string, unknown> {
  /** Hashes of commands this project may run. */
  commands: string[];
  /** `service\naccount` of foreign items the user let Tau read. */
  items: string[];
}

const TRUST_VERSION = 1;
const TRUST_FILE = "credentials.json";

function decodeTrust(value: unknown): TrustFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { commands, items } = value as Partial<TrustFile>;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  return { commands: strings(commands), items: strings(items) };
}

const itemKey = (item: SecretItem) => `${item.service}\n${item.account}`;
const commandHash = (call: readonly string[]) => createHash("sha256").update(JSON.stringify(call)).digest("hex");

export interface ServerCredentialsOptions {
  prompts: ServerPrompts;
  /** `<stateDir>/targets`: approvals sit beside each project's profile choices. */
  targetsDir: string;
  findCommand(name: string): string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ProcessRunner;
  logger?: PersistedJsonLogger;
  log?(event: string, message: string): void;
}

/**
 * Secrets for every target of the host. Holds this session's memory: secrets
 * the servers accepted and foreign items they turned down.
 */
export class ServerCredentials {
  private readonly session = new Map<string, string>();
  private readonly turnedDown = new Set<string>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly run: ProcessRunner;

  constructor(private readonly options: ServerCredentialsOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runProcess;
  }

  attempt(project: CredentialProject, target: CredentialTarget): CredentialAttempt {
    const answered = new Map<SecretKind, Answer>();
    return {
      secret: async (kind, options = {}) => {
        if (options.host && options.host !== target.host) {
          const answer = await this.ask(project, target, kind, {}, false, options.signal, options.host);
          return answer?.value;
        }
        const previous = answered.get(kind);
        if (previous) await this.discard(project, target, kind, previous);
        answered.delete(kind);
        const answer = await this.resolve(project, target, kind, { retry: Boolean(previous), interactive: true, ...(options.signal ? { signal: options.signal } : {}) });
        if (answer) answered.set(kind, answer);
        return answer?.value;
      },
      accepted: async () => {
        for (const [kind, answer] of answered) await this.keep(project, target, kind, answer);
        answered.clear();
      },
      rejected: async () => {
        for (const [kind, answer] of answered) await this.discard(project, target, kind, answer);
        answered.clear();
      },
    };
  }

  /** Runs the chain like a connection would, without asking for the secret itself. */
  async check(project: CredentialProject, target: CredentialTarget, kind: SecretKind): Promise<CredentialCheck> {
    const answer = await this.resolve(project, target, kind, { retry: false, interactive: false });
    return answer ? { found: true, source: this.sourceWords(answer, kind) } : { found: false, message: "Tau would ask for it when it connects." };
  }

  async status(project: CredentialProject, target: CredentialTarget): Promise<CredentialStatus> {
    const password = await this.secretStatus(project, target, "password");
    const passphrase = target.passphrase || target.privateKeyPath ? await this.secretStatus(project, target, "passphrase") : undefined;
    return { targetId: target.id, password, ...(passphrase ? { passphrase } : {}) };
  }

  /** Forgets Tau's own items and this session's memory for a target; VS Code's items stay. */
  async forget(project: CredentialProject, target: CredentialTarget): Promise<void> {
    for (const kind of ["password", "passphrase"] as const) {
      this.session.delete(this.cacheKey(project, target, kind));
      const own = this.plan(this.spec(target, kind), kind, target).own ?? this.ownStore().store;
      if (own && await own.has(this.ownItem(target, kind)).catch(() => undefined) !== false) await own.delete(this.ownItem(target, kind)).catch(() => undefined);
    }
    for (const key of [...this.turnedDown]) if (key.startsWith(`${target.id}\0`)) this.turnedDown.delete(key);
  }

  async forgetApprovals(project: CredentialProject): Promise<void> {
    await writePersistedJson(this.trustPath(project), TRUST_VERSION, { commands: [], items: [] } satisfies TrustFile, this.loggerOption());
  }

  // --- the chain

  private spec(target: CredentialTarget, kind: SecretKind): CredentialSpec {
    return (kind === "password" ? target.password : target.passphrase) ?? { value: "ask" };
  }

  private async resolve(project: CredentialProject, target: CredentialTarget, kind: SecretKind, how: { retry: boolean; interactive: boolean; signal?: AbortSignal }): Promise<Answer | undefined> {
    const spec = this.spec(target, kind);
    const plan = this.plan(spec, kind, target);
    if (plan.off) await this.purgeOwn(target, kind);
    // Once the server turned an answer down, only the user can say better.
    if (!how.retry) {
      const cached = this.session.get(this.cacheKey(project, target, kind));
      if (cached !== undefined) return { value: cached, source: "session" };
      const found = await this.stored(project, target, kind, spec, plan, how.signal);
      if (found) return found;
    }
    if (!how.interactive) return undefined;
    return this.ask(project, target, kind, plan, how.retry, how.signal);
  }

  private async stored(project: CredentialProject, target: CredentialTarget, kind: SecretKind, spec: CredentialSpec, plan: Plan, signal?: AbortSignal): Promise<Answer | undefined> {
    const label = itemLabel(secretAccount(target, kind), kind);
    if (spec.command) {
      if (await this.allowCommand(project, ["sh", spec.command], spec.command, kind, label, signal)) {
        // With a write command the pair starts empty: nothing yet means asking, then writing.
        const value = await this.shell(spec.command, project.root).catch((error: unknown) => {
          if (spec.writeCommand) return "";
          throw error;
        });
        if (value) return { value, source: "command" };
        if (!spec.writeCommand) throw new CredentialError(`The ${kind} command in sftp.json printed nothing.`);
      }
    } else if (plan.provider) {
      const { call, path, name } = plan.provider;
      const shown = [call.program, ...call.args].join(" ");
      if (!path) throw new CredentialError(plan.unavailable ?? `${call.program} is not on this machine's PATH.`);
      if (await this.allowCommand(project, [name, ...call.args], shown, kind, label, signal)) {
        const result = await this.run(path, call.args, { cwd: project.root, env: this.env, timeoutMs: 60_000 });
        if (result.code !== 0) throw new CredentialError(`${call.program} could not give the ${kind} (exit ${result.code}).`);
        const value = secretOf(result.stdout, call.firstLine);
        if (!value) throw new CredentialError(`${call.program} gave an empty ${kind}.`);
        return { value, source: "provider" };
      }
    } else {
      if (plan.own) {
        const value = await plan.own.get(this.ownItem(target, kind)).catch((error: unknown) => this.warn(`could not read Tau's ${kind} item`, error));
        if (value) return { value, source: "own" };
      }
      if (plan.foreign) {
        const found = await this.foreign(project, target, kind, plan.foreign, signal);
        if (found) return found;
      }
    }
    if (spec.value === "plain") {
      const text = await readFile(join(project.root, SFTP_JSON_PATH), "utf8").catch(() => "");
      const value = sftpJsonSecrets(text, { index: target.index, ...(target.profile ? { profile: target.profile } : {}) })[kind];
      if (value) return { value, source: "file" };
    }
    return undefined;
  }

  /** The fork's item under the exact account, then (passwords of a named target) the one without `/<name>`. */
  private async foreign(project: CredentialProject, target: CredentialTarget, kind: SecretKind, store: SecretStore, signal?: AbortSignal): Promise<Answer | undefined> {
    const accounts = [secretAccount(target, kind)];
    if (kind === "password" && accounts[0] !== loginAccount(target)) accounts.push(loginAccount(target));
    for (const account of accounts) {
      const item = { service: FOREIGN_SERVICE[kind], account };
      if (this.turnedDown.has(this.downKey(target, item))) continue;
      // Attributes only: whether it is there needs no consent, its secret does.
      if (!await store.has(item).catch(() => false)) continue;
      if (!await this.allowItem(project, item, kind, signal)) return undefined;
      const value = await store.get(item).catch((error: unknown) => this.warn(`could not read ${FOREIGN_SERVICE[kind]} item`, error));
      if (value) return { value, source: "foreign", item };
    }
    return undefined;
  }

  /** The newest other item on the same login, on the user's click only. */
  private async sibling(target: CredentialTarget, store: SecretStore): Promise<Answer | undefined> {
    if (!store.accounts) return undefined;
    const login = loginAccount(target);
    const accounts = await store.accounts(FOREIGN_SERVICE.password);
    for (const account of accounts) {
      if (account !== login && !account.startsWith(`${login}/`)) continue;
      const item = { service: FOREIGN_SERVICE.password, account };
      if (this.turnedDown.has(this.downKey(target, item))) continue;
      const value = await store.get(item).catch(() => undefined);
      if (value) return { value, source: "sibling", item };
    }
    return undefined;
  }

  private async ask(project: CredentialProject, target: CredentialTarget, kind: SecretKind, plan: Plan, retry: boolean, signal?: AbortSignal, hop?: string): Promise<Answer | undefined> {
    const where = hop ?? itemLabel(loginAccount(target), "password");
    const canBorrow = !hop && kind === "password" && Boolean(plan.foreign?.accounts);
    let note = retry ? `The server did not accept the ${kind}. ` : "";
    for (;;) {
      const answer = await this.options.prompts.ask({
        kind: "secret",
        title: kind === "password" ? `Password for ${where}` : `Passphrase for ${itemLabel(secretAccount(target, kind), kind)}`,
        message: `${note}${hop ? `A jump host on the way to ${target.host} asks for it; Tau does not keep it.` : this.keepWords(plan, kind)}`,
        field: kind === "password" ? "Password" : "Passphrase",
        confirmLabel: "Connect",
        ...(canBorrow ? { alternativeLabel: "Try other keychain items on this login" } : {}),
      }, signal);
      if (answer.action === "cancel") return undefined;
      if (answer.action === "alternative" && plan.foreign) {
        const found = await this.sibling(target, plan.foreign);
        if (found) return found;
        note = "The keychain has no other item on this login. ";
        continue;
      }
      if (answer.action === "confirm" && answer.value) return { value: answer.value, source: hop ? "hop" : "typed" };
      note = `Enter the ${kind}, or cancel. `;
    }
  }

  private keepWords(plan: Plan, kind: SecretKind): string {
    if (plan.off) return `sftp.json keeps the ${kind} nowhere; Tau holds it in memory until it quits.`;
    if (plan.own) return `Once the server accepts it, Tau keeps it in the ${plan.own.name} as a "${OWN_SERVICE[kind]}" item.`;
    return `Tau holds it in memory until it quits${plan.unavailable ? ` (${plan.unavailable})` : ""}.`;
  }

  private async keep(project: CredentialProject, target: CredentialTarget, kind: SecretKind, answer: Answer): Promise<void> {
    if (answer.source === "hop") return;
    this.session.set(this.cacheKey(project, target, kind), answer.value);
    if (answer.source !== "typed" && answer.source !== "sibling") return;
    const spec = this.spec(target, kind);
    const plan = this.plan(spec, kind, target);
    if (plan.off) return;
    if (spec.writeCommand) {
      await this.writeByCommand(project, target, kind, spec, answer.value);
      return;
    }
    if (!plan.own) return;
    const account = secretAccount(target, kind);
    const item: LabelledSecretItem = { ...this.ownItem(target, kind), label: itemLabel(account, kind) };
    await plan.own.set(item, answer.value).catch((error: unknown) => this.warn(`could not keep the ${kind} in the ${plan.own!.name}`, error));
  }

  /** `passwordWriteCommand`: the secret on stdin, then read back through `passwordCommand` when there is one. */
  private async writeByCommand(project: CredentialProject, target: CredentialTarget, kind: SecretKind, spec: CredentialSpec, value: string): Promise<void> {
    const command = spec.writeCommand!;
    const label = itemLabel(secretAccount(target, kind), kind);
    if (!await this.allowCommand(project, ["sh", command], command, kind, label)) return;
    const result = await this.run(...this.shellCall(command), { cwd: project.root, env: this.env, input: value, timeoutMs: 60_000 }).catch(() => undefined);
    if (!result || result.code !== 0) { this.options.log?.("servers.credentials", `the ${kind} write command failed${result ? ` (exit ${result.code})` : ""}`); return; }
    if (spec.command && await this.shell(spec.command, project.root).catch(() => undefined) !== value) {
      this.options.log?.("servers.credentials", `the ${kind} write command ran, but the read command gives something else back`);
    }
  }

  private async discard(project: CredentialProject, target: CredentialTarget, kind: SecretKind, answer: Answer): Promise<void> {
    this.session.delete(this.cacheKey(project, target, kind));
    if (answer.source === "own") {
      const own = this.plan(this.spec(target, kind), kind, target).own;
      await own?.delete(this.ownItem(target, kind)).catch(() => undefined);
    } else if ((answer.source === "foreign" || answer.source === "sibling") && answer.item) {
      // Not Tau's to delete: skipped for this target until Tau quits.
      this.turnedDown.add(this.downKey(target, answer.item));
    }
  }

  private async purgeOwn(target: CredentialTarget, kind: SecretKind): Promise<void> {
    const own = this.ownStore().store;
    if (!own) return;
    const item = this.ownItem(target, kind);
    if (await own.has(item).catch(() => false)) await own.delete(item).catch(() => undefined);
  }

  // --- stores and managers

  private plan(spec: CredentialSpec, kind: SecretKind, target: CredentialTarget): Plan {
    const manager = spec.manager ?? { kind: "default" as const };
    if (manager.kind === "none") return { off: true };
    if ((PROVIDERS as readonly string[]).includes(manager.kind)) {
      const name = manager.kind as ProviderName;
      const call = providerCall(name, "ref" in manager ? manager.ref : undefined, { service: FOREIGN_SERVICE[kind], account: secretAccount(target, kind) });
      const found = this.program(call.program);
      return { provider: { name, call, ...(found.path ? { path: found.path } : {}) }, ...(found.reason ? { unavailable: found.reason } : {}) };
    }
    const own = this.ownStore();
    // `true` and `keychain` mean the keychain where there is one; elsewhere, and for `vscode`, Tau's own store.
    const keychain = manager.kind !== "vscode" && this.platform === "darwin" ? this.keychain() : undefined;
    return {
      ...(own.store ? { own: own.store } : {}),
      ...(keychain?.store ? { foreign: keychain.store } : {}),
      ...(own.reason ? { unavailable: own.reason } : {}),
    };
  }

  private guarded(): boolean {
    return this.env[LOOPBACK_ENV] === "1";
  }

  private keychain(): { store?: SecretStore; reason?: string } {
    const stub = this.env[SECURITY_COMMAND_ENV];
    if (stub) return { store: new SecurityKeychain(stub, this.run, this.env) };
    if (this.guarded()) return { reason: `a test instance uses only the keychain stub ${SECURITY_COMMAND_ENV} names` };
    if (this.platform === "darwin") return { store: new SecurityKeychain(REAL_SECURITY, this.run, this.env) };
    return { reason: "this system has no macOS keychain" };
  }

  private secretTool(): { store?: SecretStore; reason?: string } {
    const found = this.program("secret-tool");
    return found.path ? { store: new SecretToolStore(found.path, this.run, this.env) } : { reason: found.reason ?? "secret-tool is not installed" };
  }

  /** macOS: the keychain; Linux: the Secret Service; elsewhere nothing, so memory only. */
  private ownStore(): { store?: SecretStore; reason?: string } {
    if (this.platform === "darwin") return this.keychain();
    if (this.platform === "win32") return { reason: "on Windows Tau keeps it for this session only" };
    return this.secretTool();
  }

  /** A password manager's CLI. A test instance runs none but the secret-tool stub. */
  private program(name: string): { path?: string; reason?: string } {
    if (name === "secret-tool") {
      const stub = this.env[SECRET_TOOL_COMMAND_ENV];
      if (stub) return { path: stub };
    }
    if (this.guarded()) return { reason: `a test instance never runs a real ${name}` };
    const path = this.options.findCommand(name);
    return path ? { path } : { reason: `${name} is not on this machine's PATH` };
  }

  private ownItem(target: CredentialTarget, kind: SecretKind): SecretItem {
    return { service: OWN_SERVICE[kind], account: secretAccount(target, kind) };
  }

  // --- commands

  private shellCall(command: string): [string, string[]] {
    return this.platform === "win32" ? [this.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]];
  }

  /** Runs a command line from sftp.json; what it prints is the secret and goes nowhere else. */
  private async shell(command: string, cwd: string): Promise<string> {
    const result = await this.run(...this.shellCall(command), { cwd, env: this.env, timeoutMs: 60_000 });
    if (result.code !== 0) throw new CredentialError(`The command in sftp.json failed (exit ${result.code}).`);
    return secretOf(result.stdout);
  }

  // --- approvals

  private trustPath(project: CredentialProject): string {
    if (!isStoreSegment(project.workspaceId)) throw new CredentialError("This project has no id the servers store can keep.");
    return join(this.options.targetsDir, project.workspaceId, TRUST_FILE);
  }

  private loggerOption(): { logger?: PersistedJsonLogger } {
    return this.options.logger ? { logger: this.options.logger } : {};
  }

  private async trust(project: CredentialProject): Promise<TrustFile> {
    const read = await readPersistedJson(this.trustPath(project), { expectedVersion: TRUST_VERSION, decode: decodeTrust, ...this.loggerOption() });
    return read?.data ?? { commands: [], items: [] };
  }

  private async grant(project: CredentialProject, field: "commands" | "items", key: string): Promise<void> {
    const trust = await this.trust(project);
    if (!trust[field].includes(key)) trust[field].push(key);
    await writePersistedJson(this.trustPath(project), TRUST_VERSION, trust, this.loggerOption());
  }

  /** One question per project and command text; a changed command asks again. */
  private allowCommand(project: CredentialProject, call: readonly string[], shown: string, kind: SecretKind, label: string, signal?: AbortSignal): Promise<boolean> {
    const hash = commandHash(call);
    return this.once(`${project.workspaceId}\0command\0${hash}`, async () => {
      if ((await this.trust(project)).commands.includes(hash)) return true;
      const answer = await this.options.prompts.ask({
        kind: "confirm",
        title: "Run a command from sftp.json?",
        message: `This project's .vscode/sftp.json asks Tau to run this to get the ${kind} for ${label}. The file comes with the project, so allow it only if you trust the project. Tau never logs what it prints.`,
        detail: shown,
        confirmLabel: "Allow for this project",
        cancelLabel: "Not now",
      }, signal);
      if (answer.action !== "confirm") return false;
      await this.grant(project, "commands", hash);
      return true;
    });
  }

  /** One question per keychain item VS Code's extension wrote. */
  private allowItem(project: CredentialProject, item: SecretItem, kind: SecretKind, signal?: AbortSignal): Promise<boolean> {
    const key = itemKey(item);
    return this.once(`${project.workspaceId}\0item\0${key}`, async () => {
      if ((await this.trust(project)).items.includes(key)) return true;
      const answer = await this.options.prompts.ask({
        kind: "confirm",
        title: `Read the keychain item ${itemLabel(item.account, kind)}?`,
        message: `VS Code's SFTP extension saved the ${kind} for this server in the keychain. May Tau read it when it connects? Tau asks once per item and does not copy it.`,
        detail: `${item.service} · ${item.account}`,
        confirmLabel: "Allow",
        cancelLabel: "Not now",
      }, signal);
      if (answer.action !== "confirm") return false;
      await this.grant(project, "items", key);
      return true;
    });
  }

  /** Concurrent connections share one open question. */
  private once(key: string, question: () => Promise<boolean>): Promise<boolean> {
    const open = this.asking.get(key);
    if (open) return open;
    const next = question().finally(() => this.asking.delete(key));
    this.asking.set(key, next);
    return next;
  }

  // --- status

  private async secretStatus(project: CredentialProject, target: CredentialTarget, kind: SecretKind): Promise<CredentialSecretStatus> {
    const spec = this.spec(target, kind);
    const plan = this.plan(spec, kind, target);
    const trust = await this.trust(project);
    const status: CredentialSecretStatus = { source: this.planWords(spec, plan, kind), session: this.session.has(this.cacheKey(project, target, kind)) };
    if (spec.command) status.command = trust.commands.includes(commandHash(["sh", spec.command])) ? "allowed" : "needs-approval";
    else if (plan.provider) status.command = trust.commands.includes(commandHash([plan.provider.name, ...plan.provider.call.args])) ? "allowed" : "needs-approval";
    if (plan.own && !spec.command && !plan.provider) {
      const saved = await plan.own.has(this.ownItem(target, kind)).catch(() => undefined);
      if (saved !== undefined) status.saved = saved;
    }
    if (plan.foreign && !spec.command) {
      const item = { service: FOREIGN_SERVICE[kind], account: secretAccount(target, kind) };
      status.foreignItem = { label: itemLabel(item.account, kind), allowed: trust.items.includes(itemKey(item)) };
    }
    if (plan.unavailable) status.unavailable = plan.unavailable;
    return status;
  }

  private planWords(spec: CredentialSpec, plan: Plan, kind: SecretKind): string {
    const typed = spec.value === "plain" ? "the plain text in sftp.json" : "asking you";
    if (spec.command) return `The ${kind} command in sftp.json`;
    if (plan.off) return `Asks you; kept in memory until Tau quits`;
    if (plan.provider) return `${plan.provider.call.program} (${plan.provider.name}), read only`;
    if (plan.foreign) return `Tau's keychain item, then VS Code's, then ${typed}`;
    if (plan.own) return `Tau's item in the ${plan.own.name}, then ${typed}`;
    return `${spec.value === "plain" ? "The plain text in sftp.json" : "Asks you"}; kept in memory until Tau quits`;
  }

  private sourceWords(answer: Answer, kind: SecretKind): string {
    switch (answer.source) {
      case "session": return "Held in memory since the last connection";
      case "command": return `The ${kind} command in sftp.json`;
      case "provider": return "The password manager sftp.json names";
      case "own": return `Tau's own item (${OWN_SERVICE[kind]})`;
      case "foreign": case "sibling": return `VS Code's keychain item ${answer.item ? itemLabel(answer.item.account, kind) : ""}`.trim();
      case "file": return "The plain text in sftp.json";
      default: return "Typed by you";
    }
  }

  private cacheKey(project: CredentialProject, target: CredentialTarget, kind: SecretKind): string {
    return `${project.workspaceId}\0${target.id}\0${kind}`;
  }

  private downKey(target: CredentialTarget, item: SecretItem): string {
    return `${target.id}\0${itemKey(item)}`;
  }

  private warn(what: string, error: unknown): undefined {
    this.options.log?.("servers.credentials", `${what}: ${error instanceof Error ? error.message : "failed"}`);
    return undefined;
  }
}

type TargetLookup = (cwd: unknown, targetId: unknown) => Promise<{ project: CredentialProject; target: CredentialTarget }>;
type TargetList = (cwd: unknown) => Promise<{ project: CredentialProject; targets: CredentialTarget[] }>;

const kindOf = (value: unknown): SecretKind => (value === "passphrase" ? "passphrase" : "password");

/** The host commands of credentials and of the dialogs they (and later tickets) ask. */
export function registerCredentialCommands(context: HostExtensionContext, credentials: ServerCredentials, prompts: ServerPrompts, lookup: TargetLookup, list: TargetList): void {
  context.registerCommand("prompts", () => ({ prompts: prompts.pending() }), { access: "read" });
  context.registerCommand("answer-prompt", (input) => {
    const read = readPromptAnswer(input);
    if (!read) throw new HostCommandError("Not an answer to a server question.");
    return { answered: prompts.answer(read.id, read.answer) };
  }, { audit: { label: "answered a server question" } });
  context.registerCommand("credential-status", async (input) => {
    const { project, targets } = await list((input as { cwd?: unknown } | undefined)?.cwd);
    return { targets: await Promise.all(targets.map((target) => credentials.status(project, target))) };
  }, { access: "read" });
  // Waits for the user's answers to its questions, so it runs as a long command.
  context.registerCommand("check-credential", async (input) => {
    const { cwd, targetId, kind } = (input ?? {}) as { cwd?: unknown; targetId?: unknown; kind?: unknown };
    const { project, target } = await lookup(cwd, targetId);
    return credentials.check(project, target, kindOf(kind));
  }, { long: true, audit: { label: "checked a server password" } });
  context.registerCommand("forget-credential", async (input) => {
    const { cwd, targetId } = (input ?? {}) as { cwd?: unknown; targetId?: unknown };
    const { project, target } = await lookup(cwd, targetId);
    await credentials.forget(project, target);
    return credentials.status(project, target);
  }, { audit: { label: "forgot a server password" } });
  context.registerCommand("forget-credential-approvals", async (input) => {
    const { project } = await list((input as { cwd?: unknown } | undefined)?.cwd);
    await credentials.forgetApprovals(project);
    return { ok: true };
  }, { audit: { label: "withdrew the server password approvals" } });
}
