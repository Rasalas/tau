import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";

/**
 * `.vscode/sftp.json` as the vscode-sftp extension and its forks (liximomo,
 * Natizyskunk, danielratzinger) read it. Targets carry no secret values:
 * `sftpJsonSecrets` hands a plain-text password to the one caller that needs it.
 */

export const SFTP_JSON_PATH = join(".vscode", "sftp.json");

export type ServerProtocol = "sftp" | "ftp";

export type CredentialManagerKind = "keychain" | "vscode" | "secret-tool" | "1password" | "pass" | "gopass" | "bitwarden";

/** `passwordManager` / `passphraseManager`: `true` is the OS store, `false` asks every time. */
export type CredentialManager =
  | { kind: "default" }
  | { kind: "none" }
  | { kind: CredentialManagerKind; ref?: string }
  | { kind: "unknown"; value: string };

export interface CredentialSpec {
  /** `plain`: the value is in the file; `ask`: `true`, `null` or left out. */
  value: "plain" | "ask";
  /** Left out, the extension's own setting decides; Tau treats that as `default`. */
  manager?: CredentialManager;
  command?: string;
  writeCommand?: string;
}

export interface SshHop {
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  agent?: string;
}

export type FtpSecure = false | true | "control" | "implicit";

export type SftpJsonIssueCode =
  | "invalid-json" | "not-a-config" | "invalid-field" | "missing-host" | "missing-username" | "unsupported-protocol"
  | "remote-setting" | "context-outside" | "duplicate-context" | "missing-name" | "unknown-profile" | "profile-required"
  | "plaintext-password" | "plaintext-passphrase" | "host-verification-off" | "upload-on-save-ignored"
  | "watcher-ignored" | "production-profile" | "ftp-unencrypted" | "ftp-secure-control" | "remote-path-default";

export interface SftpJsonIssue {
  code: SftpJsonIssueCode;
  level: "error" | "warning" | "info";
  message: string;
  field?: string;
}

export interface SftpJsonTarget {
  /** Filesystem-safe and stable for one config and profile; the key of the target's state folder. */
  id: string;
  /** Stable for one config across profiles: `name`, else `context`, else `.`; the key of the profile choice. */
  configKey: string;
  /** Position in the file (0 for a single object). */
  index: number;
  name?: string;
  /** Local folder relative to the workspace root, forward slashes; `""` is the root. */
  context: string;
  profiles: string[];
  /** The profile merged over the config, if any. */
  profile?: string;
  protocol: ServerProtocol;
  host: string;
  port: number;
  username?: string;
  remotePath: string;
  password: CredentialSpec;
  passphrase?: CredentialSpec;
  /** Paths as written; `~`, `$VAR` and workspace-relative paths are resolved at connect time. */
  privateKeyPath?: string;
  agent?: string;
  sshConfigPath?: string;
  knownHostsPath?: string;
  hop: SshHop[];
  /** `preset`: answers are listed in the file (read them through `sftpJsonSecrets`). */
  interactiveAuth: "off" | "prompt" | "preset";
  hostVerification: boolean;
  ignore: string[];
  ignoreFile?: string;
  filePerm?: number;
  dirPerm?: number;
  useTempFile: boolean;
  openSsh: boolean;
  syncDelete?: boolean;
  remoteTimeOffsetInHours?: number;
  secure: FtpSecure;
  connectTimeout: number;
  concurrency: number;
  /** Set in the file; Tau never uploads on its own and only says so. */
  uploadOnSave: boolean;
  watcher: boolean;
  issues: SftpJsonIssue[];
  /** False when an error issue leaves no server to connect to. */
  usable: boolean;
}

export interface SftpJsonRead {
  targets: SftpJsonTarget[];
  /** Issues of the file itself (parse errors, duplicates). */
  issues: SftpJsonIssue[];
}

export interface SftpJsonReadOptions {
  /** Profile per `configKey`, as the user last chose it. */
  profileChoices?: Readonly<Record<string, string>>;
  /** Lets an absolute `context` inside the workspace count as relative. */
  workspaceRoot?: string;
}

type Json = Record<string, unknown>;

const MANAGER_KINDS: readonly CredentialManagerKind[] = ["keychain", "vscode", "secret-tool", "1password", "pass", "gopass", "bitwarden"];
const PRODUCTION = /(^|[^a-z])(prod|production|live)([^a-z]|$)/iu;
const DEFAULT_REMOTE_PATH = "./";

/** Comments and trailing commas allowed; strings are left untouched. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "\"") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== "\"") index += source[index] === "\\" ? 2 : 1;
      index += 1;
      out += source.slice(start, index);
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < source.length && /\s/u.test(source[ahead]!)) ahead += 1;
      if (source[ahead] === "}" || source[ahead] === "]") { index += 1; continue; }
    }
    out += char;
    index += 1;
  }
  return JSON.parse(out);
}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** liximomo's `mergeProfile`: a shallow override, except `ignore`, which is appended. */
function mergeProfile(base: Json, profile: Json): Json {
  const merged: Json = { ...base };
  delete merged.profiles;
  for (const [key, value] of Object.entries(profile)) {
    merged[key] = key === "ignore" && Array.isArray(merged.ignore) && Array.isArray(value) ? [...merged.ignore, ...value] : value;
  }
  return merged;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "root";
}

export function sftpJsonTargetId(configKey: string, profile?: string): string {
  const hash = createHash("sha256").update(`sftp.json\0${configKey}\0${profile ?? ""}`).digest("hex").slice(0, 8);
  return `sftp-${slug(configKey)}${profile ? `--${slug(profile)}` : ""}-${hash}`;
}

/** Workspace-relative with forward slashes, or `undefined` when it leaves the workspace. */
function normalizeContext(raw: string, workspaceRoot?: string): string | undefined {
  let value = raw.replace(/\\/gu, "/");
  if (workspaceRoot && isAbsolute(raw)) {
    const inside = relative(workspaceRoot, raw);
    if (!inside.startsWith("..") && !isAbsolute(inside)) value = inside.split(sep).join("/");
  }
  // The docs show `"/_subfolder_"` for a workspace subfolder; a leading slash is read that way.
  if (/^[A-Za-z]:/u.test(value)) return undefined;
  value = posix.normalize(value.replace(/^\/+/u, "") || ".").replace(/\/$/u, "");
  if (value === ".." || value.startsWith("../")) return undefined;
  return value === "." ? "" : value;
}

/** `filePerm: 644` means octal 644, as in the extension; a string may carry a leading 0. */
function permission(value: unknown): number | undefined {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^0?[0-7]{3,4}$/u.test(text) ? Number.parseInt(text, 8) : undefined;
}

function managerOf(value: unknown): CredentialManager | undefined {
  if (value === true) return { kind: "default" };
  if (value === false) return { kind: "none" };
  if (typeof value !== "string" || !value.trim()) return undefined;
  const colon = value.indexOf(":");
  const name = (colon < 0 ? value : value.slice(0, colon)).trim().toLowerCase();
  const ref = colon < 0 ? undefined : value.slice(colon + 1).trim() || undefined;
  const kind = MANAGER_KINDS.find((candidate) => candidate === name);
  return kind ? { kind, ...(ref ? { ref } : {}) } : { kind: "unknown", value };
}

class FieldReader {
  readonly issues: SftpJsonIssue[] = [];
  constructor(private readonly config: Json) {}

  invalid(field: string, expected: string): undefined {
    this.issues.push({ code: "invalid-field", level: "warning", field, message: `"${field}" should be ${expected}; Tau ignores it.` });
    return undefined;
  }

  string(field: string): string | undefined {
    const value = this.config[field];
    if (value === undefined || value === null) return undefined;
    return typeof value === "string" ? value : this.invalid(field, "a string");
  }

  number(field: string, integer = false): number | undefined {
    const value = this.config[field];
    if (value === undefined || value === null) return undefined;
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) return this.invalid(field, integer ? "a whole number" : "a number");
    return number;
  }

  boolean(field: string): boolean | undefined {
    const value = this.config[field];
    if (value === undefined || value === null) return undefined;
    return typeof value === "boolean" ? value : this.invalid(field, "true or false");
  }

  strings(field: string): string[] | undefined {
    const value = this.config[field];
    if (value === undefined || value === null) return undefined;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : this.invalid(field, "a list of strings");
  }

  credential(value: string, manager: string, command: string, writeCommand: string, plaintextCode: SftpJsonIssueCode): CredentialSpec | undefined {
    const raw = this.config[value];
    const spec: CredentialSpec = { value: typeof raw === "string" ? "plain" : "ask" };
    if (raw !== undefined && raw !== null && raw !== true && typeof raw !== "string") this.invalid(value, "a string or true");
    const managed = managerOf(this.config[manager]);
    if (managed) spec.manager = managed;
    else if (this.config[manager] !== undefined && this.config[manager] !== null) this.invalid(manager, "true, false or a manager name");
    const commandValue = this.string(command);
    if (commandValue?.trim()) spec.command = commandValue;
    const writeValue = this.string(writeCommand);
    if (writeValue?.trim()) spec.writeCommand = writeValue;
    if (spec.value === "plain") {
      this.issues.push({ code: plaintextCode, level: "warning", field: value, message: `"${value}" is stored in plain text in sftp.json; Tau never copies it anywhere.` });
    }
    const set = raw !== undefined || spec.manager !== undefined || spec.command !== undefined || spec.writeCommand !== undefined;
    return set ? spec : undefined;
  }
}

function hopsOf(value: unknown, reader: FieldReader): SshHop[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const hops: SshHop[] = [];
  for (const entry of list) {
    if (!isJson(entry) || typeof entry.host !== "string" || !entry.host.trim()) {
      reader.issues.push({ code: "invalid-field", level: "warning", field: "hop", message: "A \"hop\" entry has no host; Tau ignores it." });
      continue;
    }
    const hop: SshHop = { host: entry.host.trim() };
    if (typeof entry.port === "number" && Number.isInteger(entry.port)) hop.port = entry.port;
    if (typeof entry.username === "string") hop.username = entry.username;
    if (typeof entry.privateKeyPath === "string") hop.privateKeyPath = entry.privateKeyPath;
    if (typeof entry.agent === "string") hop.agent = entry.agent;
    hops.push(hop);
  }
  return hops;
}

function resolveProfile(config: Json, key: string, choices: Readonly<Record<string, string>>, issues: SftpJsonIssue[]): { profiles: string[]; profile?: string } {
  const profiles = isJson(config.profiles) ? Object.keys(config.profiles).filter((name) => isJson((config.profiles as Json)[name])) : [];
  if (profiles.length === 0) return { profiles };
  const chosen = choices[key];
  if (chosen !== undefined) {
    if (profiles.includes(chosen)) return { profiles, profile: chosen };
    issues.push({ code: "unknown-profile", level: "warning", message: `The chosen profile "${chosen}" is no longer in sftp.json.` });
  }
  const fallback = typeof config.defaultProfile === "string" ? config.defaultProfile : undefined;
  if (fallback !== undefined) {
    if (profiles.includes(fallback)) return { profiles, profile: fallback };
    issues.push({ code: "unknown-profile", level: "warning", field: "defaultProfile", message: `"defaultProfile" names "${fallback}", which is not in "profiles".` });
  }
  return { profiles };
}

function targetOf(raw: Json, index: number, configKey: string, options: SftpJsonReadOptions): SftpJsonTarget {
  const profileIssues: SftpJsonIssue[] = [];
  const { profiles, profile } = resolveProfile(raw, configKey, options.profileChoices ?? {}, profileIssues);
  const config = profile ? mergeProfile(raw, (raw.profiles as Json)[profile] as Json) : raw;
  const read = new FieldReader(config);
  const issues = read.issues;
  issues.push(...profileIssues);

  const protocolValue = read.string("protocol") ?? "sftp";
  const protocol: ServerProtocol = protocolValue === "ftp" ? "ftp" : "sftp";
  if (protocolValue !== "sftp" && protocolValue !== "ftp") {
    issues.push({ code: "unsupported-protocol", level: "error", field: "protocol", message: `Protocol "${protocolValue}" is not a server Tau can reach; only sftp and ftp are.` });
  }
  const host = read.string("host")?.trim() ?? "";
  const username = read.string("username")?.trim() || undefined;
  if (!host) {
    const needsProfile = profiles.length > 0 && !profile;
    issues.push(needsProfile
      ? { code: "profile-required", level: "error", field: "profiles", message: "No host without a profile; choose one." }
      : { code: "missing-host", level: "error", field: "host", message: "\"host\" is missing." });
  }
  // Over SSH, the ssh config may name the user; FTP has nothing to fall back on.
  if (!username && protocol === "ftp") issues.push({ code: "missing-username", level: "error", field: "username", message: "\"username\" is missing." });
  if (typeof config.remote === "string") {
    issues.push({ code: "remote-setting", level: "warning", field: "remote", message: `Fields from the VS Code setting "remoteFs.remote.${config.remote}" are not available to Tau.` });
  }

  const rawContext = read.string("context") ?? "";
  const context = normalizeContext(rawContext, options.workspaceRoot);
  if (context === undefined) {
    issues.push({ code: "context-outside", level: "error", field: "context", message: `"context" ${JSON.stringify(rawContext)} is outside the workspace.` });
  }

  let remotePath = read.string("remotePath")?.trim();
  if (!remotePath) {
    remotePath = DEFAULT_REMOTE_PATH;
    issues.push({ code: "remote-path-default", level: "info", field: "remotePath", message: "No \"remotePath\": the server's login folder is the target." });
  }

  const hostVerification = read.boolean("hostVerification") ?? true;
  if (!hostVerification) {
    issues.push({ code: "host-verification-off", level: "warning", field: "hostVerification", message: "Host key checking is off for this server; Tau cannot tell it from an impostor." });
  }
  const uploadOnSave = read.boolean("uploadOnSave") ?? false;
  if (uploadOnSave) issues.push({ code: "upload-on-save-ignored", level: "info", field: "uploadOnSave", message: "Tau does not upload on save; uploads start only from Tau." });
  const watcher = isJson(config.watcher) && (config.watcher.autoUpload === true || config.watcher.autoDelete === true || typeof config.watcher.files === "string");
  if (watcher) issues.push({ code: "watcher-ignored", level: "info", field: "watcher", message: "Tau does not run the file watcher; uploads start only from Tau." });
  if (profile && PRODUCTION.test(profile)) {
    issues.push({ code: "production-profile", level: "warning", field: "profiles", message: `Profile "${profile}" looks like production.` });
  }

  let secure: FtpSecure = false;
  const secureValue = config.secure;
  if (secureValue === true || secureValue === "implicit") secure = secureValue;
  else if (secureValue === "control") {
    secure = "control";
    issues.push({ code: "ftp-secure-control", level: "info", field: "secure", message: "secure: \"control\" is run as full TLS (control and data)." });
  } else if (secureValue !== undefined && secureValue !== false && secureValue !== null) read.invalid("secure", "true, false, \"control\" or \"implicit\"");
  if (protocol === "ftp" && secure === false) {
    issues.push({ code: "ftp-unencrypted", level: "warning", field: "secure", message: "Plain FTP: the password and files travel unencrypted." });
  }

  const interactive = config.interactiveAuth;
  const interactiveAuth = Array.isArray(interactive) ? "preset" : interactive === true ? "prompt" : "off";
  const syncOption = isJson(config.syncOption) ? config.syncOption : undefined;
  const filePerm = permission(config.filePerm);
  const dirPerm = permission(config.dirPerm);
  for (const [field, value] of [["filePerm", filePerm], ["dirPerm", dirPerm]] as const) {
    if (value === undefined && config[field] !== undefined && config[field] !== false && config[field] !== null) read.invalid(field, "an octal mode like 644");
  }

  const password = read.credential("password", "passwordManager", "passwordCommand", "passwordWriteCommand", "plaintext-password") ?? { value: "ask" };
  const passphrase = read.credential("passphrase", "passphraseManager", "passphraseCommand", "passphraseWriteCommand", "plaintext-passphrase");
  const name = read.string("name");
  const target: SftpJsonTarget = {
    id: sftpJsonTargetId(configKey, profile),
    configKey,
    index,
    ...(name ? { name } : {}),
    context: context ?? "",
    profiles,
    ...(profile ? { profile } : {}),
    protocol,
    host,
    port: read.number("port", true) ?? (protocol === "ftp" ? 21 : 22),
    ...(username ? { username } : {}),
    remotePath,
    password,
    ...(passphrase ? { passphrase } : {}),
    hop: hopsOf(config.hop, read),
    interactiveAuth,
    hostVerification,
    ignore: read.strings("ignore") ?? [],
    useTempFile: read.boolean("useTempFile") ?? false,
    openSsh: read.boolean("openSsh") ?? false,
    secure,
    connectTimeout: read.number("connectTimeout", true) ?? 10_000,
    // Liximomo runs FTP on one connection; the danielratzinger fork adds `connectionLimit`.
    concurrency: protocol === "ftp" ? read.number("connectionLimit", true) ?? 1 : read.number("concurrency", true) ?? 4,
    uploadOnSave,
    watcher,
    issues,
    usable: true,
  };
  for (const field of ["privateKeyPath", "agent", "sshConfigPath", "knownHostsPath", "ignoreFile"] as const) {
    const value = read.string(field)?.trim();
    if (value) target[field] = value;
  }
  if (filePerm !== undefined) target.filePerm = filePerm;
  if (dirPerm !== undefined) target.dirPerm = dirPerm;
  if (syncOption && typeof syncOption.delete === "boolean") target.syncDelete = syncOption.delete;
  const offset = read.number("remoteTimeOffsetInHours");
  if (offset !== undefined) target.remoteTimeOffsetInHours = offset;
  target.usable = !issues.some((issue) => issue.level === "error");
  return target;
}

function configEntries(value: unknown): { configs: Json[]; issues: SftpJsonIssue[] } {
  const list = Array.isArray(value) ? value : [value];
  const issues: SftpJsonIssue[] = [];
  const configs: Json[] = [];
  list.forEach((entry, index) => {
    if (isJson(entry)) configs.push(entry);
    else issues.push({ code: "not-a-config", level: "error", message: `Entry ${index + 1} is not an object; Tau skips it.` });
  });
  if (configs.length === 0 && issues.length === 0) issues.push({ code: "not-a-config", level: "error", message: "sftp.json has no configuration." });
  return { configs, issues };
}

/** Reads the text of an sftp.json: one target per configuration, its profile applied. */
export function readSftpJson(text: string, options: SftpJsonReadOptions = {}): SftpJsonRead {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (error) {
    return { targets: [], issues: [{ code: "invalid-json", level: "error", message: `sftp.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const { configs, issues } = configEntries(value);
  const indexes = Array.isArray(value) ? configs.map((config) => (value as unknown[]).indexOf(config)) : [0];
  const keys = new Set<string>();
  const targets = configs.map((config, position) => {
    const name = typeof config.name === "string" && config.name.trim() ? config.name.trim() : undefined;
    const context = typeof config.context === "string" ? normalizeContext(config.context, options.workspaceRoot) ?? config.context : "";
    let key = name ?? (context || ".");
    if (keys.has(key)) key = `${key}#${indexes[position]}`;
    keys.add(key);
    return targetOf(config, indexes[position]!, key, options);
  });
  if (targets.length > 1) {
    if (targets.some((target) => !target.name)) {
      issues.push({ code: "missing-name", level: "warning", field: "name", message: "With several configurations each needs a \"name\"." });
    }
    const seen = new Map<string, string>();
    for (const target of targets) {
      if (target.issues.some((issue) => issue.code === "context-outside")) continue;
      const other = seen.get(target.context);
      if (other !== undefined) {
        issues.push({ code: "duplicate-context", level: "warning", field: "context", message: `"${other}" and "${target.configKey}" map the same folder "${target.context || "."}".` });
      } else seen.set(target.context, target.configKey);
    }
  }
  return { targets, issues };
}

/** Reads `<root>/.vscode/sftp.json`; `undefined` when there is none. */
export async function readSftpJsonFile(workspaceRoot: string, options: Omit<SftpJsonReadOptions, "workspaceRoot"> = {}): Promise<SftpJsonRead | undefined> {
  let text: string;
  try {
    text = await readFile(join(workspaceRoot, SFTP_JSON_PATH), "utf8");
  } catch {
    return undefined;
  }
  return readSftpJson(text, { ...options, workspaceRoot });
}

export interface SftpJsonSecrets {
  password?: string;
  passphrase?: string;
  interactiveAnswers?: string[];
}

/** The plain-text secrets of one target, read from the file's text again; never stored with the target. */
export function sftpJsonSecrets(text: string, target: Pick<SftpJsonTarget, "index" | "profile">): SftpJsonSecrets {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch {
    return {};
  }
  const raw = Array.isArray(value) ? value[target.index] : target.index === 0 ? value : undefined;
  if (!isJson(raw)) return {};
  const profile = target.profile && isJson(raw.profiles) ? raw.profiles[target.profile] : undefined;
  const config = isJson(profile) ? mergeProfile(raw, profile) : raw;
  const secrets: SftpJsonSecrets = {};
  if (typeof config.password === "string") secrets.password = config.password;
  if (typeof config.passphrase === "string") secrets.passphrase = config.passphrase;
  if (Array.isArray(config.interactiveAuth)) secrets.interactiveAnswers = config.interactiveAuth.filter((item): item is string => typeof item === "string");
  return secrets;
}

/** What Tau writes for a new sftp.json. There is no password field, by type. */
export interface SftpJsonDraft {
  name?: string;
  context?: string;
  protocol: ServerProtocol;
  host: string;
  port?: number;
  username?: string;
  remotePath: string;
  privateKeyPath?: string;
  ignore?: string[];
}

/** An sftp.json the extension reads; credentials stay out and are asked for on first use. */
export function renderSftpJson(drafts: readonly SftpJsonDraft[]): string {
  const configs = drafts.map((draft) => {
    const config: Json = {};
    if (draft.name) config.name = draft.name;
    if (draft.context) config.context = draft.context;
    config.protocol = draft.protocol;
    config.host = draft.host;
    config.port = draft.port ?? (draft.protocol === "ftp" ? 21 : 22);
    if (draft.username) config.username = draft.username;
    config.remotePath = draft.remotePath;
    if (draft.privateKeyPath) config.privateKeyPath = draft.privateKeyPath;
    if (draft.ignore?.length) config.ignore = [...draft.ignore];
    config.uploadOnSave = false;
    return config;
  });
  return `${JSON.stringify(configs.length === 1 ? configs[0] : configs, null, 4)}\n`;
}

/** Only on the user's explicit request; never replaces a file that is there. */
export async function writeSftpJson(workspaceRoot: string, drafts: readonly SftpJsonDraft[]): Promise<string> {
  if (drafts.length === 0) throw new Error("Nothing to write.");
  if (drafts.length > 1 && drafts.some((draft) => !draft.name)) throw new Error("Several configurations each need a name.");
  const path = join(workspaceRoot, SFTP_JSON_PATH);
  await mkdir(join(workspaceRoot, ".vscode"), { recursive: true });
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(renderSftpJson(drafts), "utf8");
  } finally {
    await handle.close();
  }
  return path;
}

const PROFILE_CHOICES_VERSION = 1;

function decodeChoices(value: unknown): Record<string, string> | undefined {
  if (!isJson(value) || !isJson(value.choices)) return undefined;
  return Object.fromEntries(Object.entries(value.choices).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The profile the user chose per config, in a file of the kit's state folder (VS Code keeps it in workspace state). */
export async function readProfileChoices(path: string, logger?: PersistedJsonLogger): Promise<Record<string, string>> {
  const read = await readPersistedJson(path, { expectedVersion: PROFILE_CHOICES_VERSION, decode: decodeChoices, ...(logger ? { logger } : {}) });
  return read?.data ?? {};
}

/** `undefined` forgets the choice, so `defaultProfile` applies again. */
export async function writeProfileChoice(path: string, configKey: string, profile: string | undefined, logger?: PersistedJsonLogger): Promise<Record<string, string>> {
  const choices = await readProfileChoices(path, logger);
  if (profile === undefined) delete choices[configKey];
  else choices[configKey] = profile;
  await writePersistedJson(path, PROFILE_CHOICES_VERSION, { choices }, logger ? { logger } : {});
  return choices;
}
