import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { posix } from "node:path";
import { Readable, Writable } from "node:stream";
import { TLSSocket, type ConnectionOptions, type PeerCertificate } from "node:tls";
import { Client, FileType, FTPError, type FileInfo } from "basic-ftp";
import type { ServerCapabilities } from "./protocol.js";
import { isWithin, ServerPathError, touchesGit, type ServerArea, type ServerEntry, type ServerFileType, type ServerFs, type ServerFsCallOptions, type ServerStat } from "./server-fs.js";
import { SFTP_STATUS, SftpError } from "./sftp-client.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import { SshConnectError } from "./transport-ssh.js";

/*
 * A server target over FTP or FTPS (basic-ftp). No commands and no hashes:
 * files only. Paths are checked as written (FTP has no realpath); an entry the
 * server lists as a link is never followed. One control connection per
 * `connectionLimit`, each used by one operation at a time.
 */

export type FtpTarget = Pick<SftpJsonTarget, "id" | "host" | "port" | "remotePath" | "secure" | "connectTimeout" | "concurrency">
  & Partial<Pick<SftpJsonTarget, "name" | "username" | "secureOptions" | "remoteTimeOffsetInHours">>;

/** What a certificate Node could not verify shows the user. */
export interface FtpCertificate {
  /** `host:port` as connected. */
  address: string;
  sha256: string;
  reason: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
}

/** One login's password, as `ServerCredentials.attempt` hands it out. */
export interface FtpLoginAttempt {
  /** Asked again, the last answer counts as refused; `undefined`: the user cancelled. */
  secret(kind: "password", options?: { signal?: AbortSignal }): Promise<string | undefined>;
  accepted(): Promise<void>;
  rejected(): Promise<void>;
}

export interface FtpTransportOptions {
  attempt(): FtpLoginAttempt;
  /** Plain FTP: whether the password may travel unencrypted to this server. */
  allowPlain(): Promise<boolean>;
  /** A certificate Node cannot verify: whether the user trusts this one. */
  trustCertificate(certificate: FtpCertificate): Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  lookup?(host: string): Promise<string[]>;
}

/** Shares the name sync and status look for when a server cannot be reached. */
export class FtpConnectError extends SshConnectError {}

const LOOPBACK_ENV = "TAU_SERVERS_LOOPBACK_ONLY";
/** More connections than this get most shared hosts to answer 421. */
export const FTP_CONNECTION_CAP = 8;
const LOGIN_TRIES = 3;
const MIN_TIMEOUT = 30_000;
// Server refusals where the command itself is unknown: the feature is absent, not denied.
const UNSUPPORTED = new Set([500, 501, 502, 504]);

const isLoopbackAddress = (address: string) => address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A LIST time in seconds. As vscode-sftp does, the listed wall time is read
 * as this machine's local time and `remoteTimeOffsetInHours` taken off; a
 * time without a year is the latest such date not in the future.
 */
export function parseListTime(raw: string, offsetHours = 0, now = new Date()): number {
  const text = raw.trim().replace(/\s+/gu, " ");
  let date: Date | undefined;
  const unix = /^([A-Za-z]{3}) (\d{1,2}) (?:(\d{1,2}):(\d{2})|(\d{4}))$/u.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/u.exec(text);
  const dos = /^(\d{2})-(\d{2})-(\d{2,4}) (\d{1,2}):(\d{2})\s?(AM|PM)?$/iu.exec(text);
  if (unix) {
    const month = MONTHS.indexOf(unix[1]!.toLowerCase());
    if (month < 0) return 0;
    const day = Number(unix[2]);
    if (unix[5]) {
      date = new Date(Number(unix[5]), month, day);
    } else {
      date = new Date(now.getFullYear(), month, day, Number(unix[3]), Number(unix[4]));
      if (date.getTime() > now.getTime() + 86_400_000) date = new Date(now.getFullYear() - 1, month, day, Number(unix[3]), Number(unix[4]));
    }
  } else if (iso) {
    date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0));
  } else if (dos) {
    const year = dos[3]!.length === 2 ? 2000 + Number(dos[3]) : Number(dos[3]);
    let hour = Number(dos[4]) % (dos[6] ? 12 : 24);
    if (dos[6]?.toUpperCase() === "PM") hour += 12;
    date = new Date(year, Number(dos[1]) - 1, Number(dos[2]), hour, Number(dos[5]));
  }
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.floor(date.getTime() / 1000 - offsetHours * 3600);
}

const TYPES: Record<number, ServerFileType> = { [FileType.File]: "file", [FileType.Directory]: "directory", [FileType.SymbolicLink]: "symlink" };

/** A listed entry as a stat; MLSD times are UTC by RFC 3659, so the offset applies to LIST only. */
export function statOfInfo(info: FileInfo, offsetHours = 0, now = new Date()): ServerStat {
  const type = TYPES[info.type] ?? "other";
  const bits = info.permissions ? (info.permissions.user << 6) | (info.permissions.group << 3) | info.permissions.world : type === "directory" ? 0o755 : 0o644;
  const mtime = info.modifiedAt ? Math.floor(info.modifiedAt.getTime() / 1000) : parseListTime(info.rawModifiedAt, offsetHours, now);
  return { type, size: type === "file" ? info.size : 0, mtime, mode: bits & 0o777 };
}

function describe(value: PeerCertificate["subject"] | undefined): string | undefined {
  const name = value?.CN ?? value?.O;
  return Array.isArray(name) ? name.join(", ") : name;
}

function certificateOf(socket: TLSSocket, address: string): FtpCertificate {
  const peer = socket.getPeerCertificate();
  return {
    address,
    sha256: peer.fingerprint256 ?? "",
    reason: String(socket.authorizationError ?? "not verified"),
    ...(describe(peer.subject) ? { subject: describe(peer.subject)! } : {}),
    ...(describe(peer.issuer) ? { issuer: describe(peer.issuer)! } : {}),
    ...(peer.valid_to ? { validTo: peer.valid_to } : {}),
  };
}

/** Data connections resume the control session; a full handshake must show the certificate the user trusted. */
function pinDataConnections(client: Client, sha256: string): void {
  const context = client.ftp;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), "dataSocket");
  if (!descriptor?.get || !descriptor.set) throw new Error("basic-ftp changed: no dataSocket accessor");
  const { get, set } = descriptor;
  Object.defineProperty(context, "dataSocket", {
    configurable: true,
    get() { return get.call(this); },
    set(socket: unknown) {
      if (socket instanceof TLSSocket) {
        socket.once("secureConnect", () => {
          if (socket.authorized || socket.isSessionReused()) return;
          if (socket.getPeerCertificate().fingerprint256 !== sha256) socket.destroy(new Error("The data connection showed another certificate."));
        });
      }
      set.call(this, socket);
    },
  });
}

class Collector extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    done();
  }
}

const abortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));

export class FtpTransport implements ServerFs {
  caps: ServerCapabilities = { exec: false, hash: false, atomicRename: false, chmod: false, mtimeSet: false };
  root = "";
  scratch: string | undefined;
  /** The login folder. */
  home = "";
  /** Whether the control connections are encrypted; the view says so. */
  encrypted = false;
  private connecting: Promise<void> | undefined;
  private closed = false;
  private password: string | undefined;
  private address: string | undefined;
  private pinned: string | undefined;
  private limit: number;
  private readonly clients = new Set<Client>();
  private readonly idle: Client[] = [];
  private readonly waiting: Array<() => void> = [];
  private opening = 0;
  // What listings said each path is; links are never followed.
  private readonly kinds = new Map<string, ServerFileType>();
  private readonly env: NodeJS.ProcessEnv;

  constructor(readonly target: FtpTarget, private readonly options: FtpTransportOptions) {
    this.env = options.env ?? process.env;
    this.limit = Math.min(FTP_CONNECTION_CAP, Math.max(1, Math.floor(target.concurrency) || 1));
  }

  get label(): string {
    return this.target.name ?? `${this.target.username ? `${this.target.username}@` : ""}${this.target.host}`;
  }

  /** How many control connections this transport may hold now. */
  get connectionLimit(): number {
    return this.limit;
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new FtpConnectError("The connection was closed."));
    this.connecting ??= this.establish().catch((error: unknown) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private async establish(): Promise<void> {
    this.address = await this.resolveAddress();
    if (this.target.secure === false && !(await this.options.allowPlain())) {
      throw new FtpConnectError(`${this.label} is plain FTP; Tau sends the password unencrypted only after you allow it.`);
    }
    const client = await this.firstLogin();
    try {
      await this.settle(client);
    } catch (error) {
      client.close();
      throw error;
    }
    this.clients.add(client);
    this.idle.push(client);
  }

  private async resolveAddress(): Promise<string> {
    const host = this.target.host;
    if (this.env[LOOPBACK_ENV] !== "1") return host;
    const addresses = isIP(host) ? [host] : await (this.options.lookup ?? defaultLookup)(host).catch(() => []);
    if (!addresses.length) throw new FtpConnectError(`Could not resolve ${host}.`);
    const outside = addresses.find((address) => !isLoopbackAddress(address));
    if (outside) throw new FtpConnectError(`Connection refused: loopback only (${host} is ${outside}).`);
    return addresses[0]!;
  }

  private tlsOptions(): ConnectionOptions {
    const own = this.target.secureOptions ?? {};
    const name = own.servername ?? (isIP(this.target.host) ? undefined : this.target.host);
    return {
      host: this.target.host,
      ...(name ? { servername: name } : {}),
      ...(own.ca ? { ca: own.ca } : {}),
      ...(own.minVersion ? { minVersion: own.minVersion as ConnectionOptions["minVersion"] } : {}),
      ...(own.maxVersion ? { maxVersion: own.maxVersion as ConnectionOptions["maxVersion"] } : {}),
      ...(own.ciphers ? { ciphers: own.ciphers } : {}),
      // Tau checks the certificate itself below, before the password goes out.
      rejectUnauthorized: false,
    };
  }

  /** Socket, TLS and the certificate check; no login yet. */
  private async dial(): Promise<Client> {
    const client = new Client(Math.max(MIN_TIMEOUT, this.target.connectTimeout));
    const address = this.address ?? this.target.host;
    const secure = this.target.secure;
    try {
      if (secure === "implicit") await client.connectImplicitTLS(address, this.target.port, this.tlsOptions());
      else await client.connect(address, this.target.port);
      // `control` (node-ftp's control-only TLS) is run as full TLS; basic-ftp has no such mode.
      if (secure === true || secure === "control") await client.useTLS(this.tlsOptions());
      if (secure !== false) await this.checkCertificate(client);
      this.encrypted = client.ftp.socket instanceof TLSSocket;
      await client.sendIgnoringError("OPTS UTF8 ON");
      return client;
    } catch (error) {
      client.close();
      if (error instanceof FtpConnectError) throw error;
      throw new FtpConnectError(`Could not connect to ${this.label}: ${messageOf(error)}`);
    }
  }

  private async checkCertificate(client: Client): Promise<void> {
    const socket = client.ftp.socket;
    if (!(socket instanceof TLSSocket)) throw new FtpConnectError(`${this.label} did not start TLS.`);
    if (socket.authorized) {
      client.ftp.tlsOptions = { ...this.tlsOptions(), rejectUnauthorized: true };
      return;
    }
    const certificate = certificateOf(socket, `${this.target.host}:${this.target.port}`);
    if (!certificate.sha256) throw new FtpConnectError(`${this.label} showed no certificate.`);
    if (certificate.sha256 !== this.pinned && !(await this.options.trustCertificate(certificate))) {
      throw new FtpConnectError(`The certificate of ${this.label} is not trusted (${certificate.reason}).`);
    }
    this.pinned = certificate.sha256;
    pinDataConnections(client, certificate.sha256);
  }

  /** The first connection asks for the password, again after a refusal, up to three times. */
  private async firstLogin(): Promise<Client> {
    const attempt = this.options.attempt();
    for (let tries = 1; tries <= LOGIN_TRIES; tries += 1) {
      const client = await this.dial();
      const password = await attempt.secret("password").catch((error: unknown) => {
        client.close();
        throw error;
      });
      if (password === undefined) {
        client.close();
        throw new FtpConnectError(`No password for ${this.label}: the question was cancelled.`);
      }
      try {
        await client.login(this.target.username, password);
        await attempt.accepted();
        this.password = password;
        return client;
      } catch (error) {
        client.close();
        if (!(error instanceof FTPError && error.code === 530)) throw new FtpConnectError(`Could not log in to ${this.label}: ${messageOf(error)}`);
      }
    }
    await attempt.rejected();
    throw new FtpConnectError(`${this.label} did not accept the password (530).`);
  }

  /** Once logged in: binary mode, MLSD if offered, the two roots and what the server can do. */
  private async settle(client: Client): Promise<void> {
    await client.useDefaultSettings();
    const features = await client.features();
    const system = await client.sendIgnoringError("SYST").then((response) => response.message, () => "");
    const unix = !/WINDOWS/iu.test(system);
    this.home = await client.pwd();
    const wanted = posix.isAbsolute(this.target.remotePath) ? this.target.remotePath : posix.join(this.home, this.target.remotePath || ".");
    try {
      await client.cd(wanted);
      this.root = await client.pwd();
    } catch (error) {
      throw new FtpConnectError(`${this.target.remotePath} is not a folder on ${this.label}: ${messageOf(error)}`);
    }
    try {
      await client.cd(posix.join(this.home, "tmp"));
      this.scratch = await client.pwd();
    } catch {
      this.scratch = undefined;
    }
    this.kinds.set(this.root, "directory");
    if (this.scratch) this.kinds.set(this.scratch, "directory");
    // RNTO over an existing file replaces it on Unix servers (rename(2)); Windows servers refuse.
    this.caps = { exec: false, hash: false, atomicRename: unix, chmod: unix, mtimeSet: features.has("MFMT") };
  }

  /** Another connection of the pool, with the password the first one used. */
  private async extraLogin(): Promise<Client> {
    const client = await this.dial();
    try {
      await client.login(this.target.username, this.password);
      await client.useDefaultSettings();
      return client;
    } catch (error) {
      client.close();
      throw new FtpConnectError(`Could not log in to ${this.label} again: ${messageOf(error)}`);
    }
  }

  private async acquire(): Promise<Client> {
    for (;;) {
      if (this.closed) throw new FtpConnectError("The connection was closed.");
      const client = this.idle.pop();
      if (client) {
        if (!client.closed) return client;
        this.clients.delete(client);
        continue;
      }
      if (this.clients.size + this.opening < this.limit) {
        this.opening += 1;
        try {
          const fresh = await this.extraLogin();
          this.clients.add(fresh);
          return fresh;
        } catch (error) {
          // A host that caps connections: work on with the ones open.
          if (this.clients.size === 0) throw error;
          this.limit = Math.max(1, this.clients.size);
        } finally {
          this.opening -= 1;
        }
        continue;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private release(client: Client): void {
    if (client.closed || this.closed) {
      this.clients.delete(client);
      if (this.closed) client.close();
    } else {
      this.idle.push(client);
    }
    this.waiting.shift()?.();
  }

  /** One operation on one connection; an abort closes that connection. */
  private async use<T>(run: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.connect();
    if (signal?.aborted) throw abortError(signal);
    const client = await this.acquire();
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await run(client);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.release(client);
    }
  }

  private absolute(path: string): string {
    if (/[\r\n\0]/u.test(path)) throw new ServerPathError(JSON.stringify(path), "has a line break, which FTP cannot carry");
    if (path === "~/tmp" || path.startsWith("~/tmp/")) {
      if (!this.scratch) throw new ServerPathError(path, "this server has no ~/tmp");
      return posix.normalize(posix.join(this.scratch, path.slice(5)));
    }
    return posix.normalize(posix.isAbsolute(path) ? path : posix.join(this.root, path));
  }

  private rootOf(path: string, real: string, area: ServerArea = "any"): string {
    const roots = (area === "tmp" ? [this.scratch] : area === "project" ? [this.root] : [this.root, this.scratch]).filter((root): root is string => Boolean(root));
    const root = roots.find((candidate) => isWithin(real, candidate));
    if (!root) throw new ServerPathError(path, `outside ${area === "tmp" ? "~/tmp" : area === "project" ? this.target.remotePath : `${this.target.remotePath} and ~/tmp`}`);
    if (touchesGit(real, root)) throw new ServerPathError(path, "Tau never touches .git on a server");
    return root;
  }

  /** The checked absolute path; every folder between the root and it must be a folder, not a link. */
  private async resolve(path: string, options: ServerFsCallOptions = {}, entry: "any" | "no-link" | "not-root" = "no-link"): Promise<string> {
    await this.connect();
    const real = this.absolute(path);
    const root = this.rootOf(path, real, options.area);
    if (entry === "not-root" && real === root) throw new ServerPathError(path, "is the target's own folder");
    const parts = posix.relative(root, real).split("/").filter(Boolean);
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      folder = posix.join(folder, part);
      const kind = this.kinds.get(folder) ?? await this.learn(folder, options.signal);
      if (kind === "symlink") throw new ServerPathError(path, "goes through a link Tau does not follow over FTP");
      if (kind === undefined) break;
      if (kind !== "directory") throw new SftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file", path);
    }
    if (entry === "no-link" && real !== root && (this.kinds.get(real) ?? await this.learn(real, options.signal)) === "symlink") {
      throw new ServerPathError(path, "is a link Tau does not follow over FTP");
    }
    return real;
  }

  /** What `path` is, from a listing of its folder; undefined when absent. */
  private async learn(path: string, signal?: AbortSignal): Promise<ServerFileType | undefined> {
    await this.listAbsolute(posix.dirname(path), signal).catch(() => undefined);
    return this.kinds.get(path);
  }

  private forget(path: string): void {
    for (const key of [...this.kinds.keys()]) if (key === path || key.startsWith(`${path}/`)) this.kinds.delete(key);
  }

  /**
   * `run` on a connection. A refusal is sorted out (absent or denied) only
   * after the connection is back: that takes a listing, and the pool may have one.
   */
  private async call<T>(path: string, run: (client: Client) => Promise<T>, signal?: AbortSignal, sort = true): Promise<T> {
    try {
      return await this.use(run, signal);
    } catch (error) {
      throw sort ? await this.refusal(error, path, signal) : toServerError(error, path, this.label);
    }
  }

  /** CWD then a bare LIST: names with spaces, globs or a leading dash stay names. */
  private async listAbsolute(dir: string, signal?: AbortSignal): Promise<ServerEntry[]> {
    let entered = false;
    const infos = await this.call(dir, async (client) => {
      await client.cd(dir);
      entered = true;
      return client.list();
    }, signal).catch((error: unknown) => {
      // The folder was there; the listing itself failed.
      throw entered && error instanceof SftpError && error.code === SFTP_STATUS.NO_SUCH_FILE ? new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Listing refused", dir) : error;
    });
    const now = new Date();
    const entries: ServerEntry[] = [];
    for (const path of [...this.kinds.keys()]) if (posix.dirname(path) === dir && path !== dir) this.kinds.delete(path);
    for (const info of infos) {
      if (!info.name || info.name === "." || info.name === ".." || info.name.includes("/")) continue;
      const stat = statOfInfo(info, this.target.remoteTimeOffsetInHours ?? 0, now);
      const path = posix.join(dir, info.name);
      this.kinds.set(path, stat.type);
      entries.push({ name: info.name, path, ...stat });
    }
    return entries;
  }

  /** A refused command on a path that is not there is "no such file"; else the server's refusal. */
  private async refusal(error: unknown, path: string, signal?: AbortSignal): Promise<Error> {
    if (!(error instanceof FTPError)) return toServerError(error, path, this.label);
    if (posix.dirname(path) !== path) {
      const exists = await this.findEntry(path, signal).then((found) => found !== undefined, () => true);
      if (!exists) return new SftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file", path);
    }
    return toServerError(error, path, this.label);
  }

  private async findEntry(path: string, signal?: AbortSignal): Promise<ServerEntry | undefined> {
    const name = posix.basename(path);
    return (await this.listAbsolute(posix.dirname(path), signal)).find((entry) => entry.name === name);
  }

  async realpath(path: string, options?: ServerFsCallOptions): Promise<string> {
    const real = await this.resolve(path, options, "any");
    // Nothing else asks the server; a check of a connection that has gone must reach it.
    await this.call(real, (client) => client.pwd(), options?.signal, false);
    return real;
  }

  async list(dir: string, options?: ServerFsCallOptions): Promise<ServerEntry[]> {
    return this.listAbsolute(await this.resolve(dir, options), options?.signal);
  }

  async stat(path: string, options?: ServerFsCallOptions): Promise<ServerStat> {
    const real = await this.resolve(path, options, "any");
    if (real === this.rootOf(path, real, options?.area)) return { type: "directory", size: 0, mtime: 0, mode: 0o755 };
    const found = await this.findEntry(real, options?.signal).catch((error: unknown) => {
      // The folder itself is missing: so is the entry.
      if (error instanceof SftpError && error.code === SFTP_STATUS.NO_SUCH_FILE) return undefined;
      throw error;
    });
    if (!found) throw new SftpError(SFTP_STATUS.NO_SUCH_FILE, "No such file", path);
    const { name: _name, path: _path, ...stat } = found;
    return stat;
  }

  async read(path: string, options?: ServerFsCallOptions): Promise<Buffer> {
    const real = await this.resolve(path, options);
    const sink = new Collector();
    await this.call(real, (client) => client.downloadTo(sink, real), options?.signal);
    return Buffer.concat(sink.chunks);
  }

  /** FTP has no exclusive create: `exclusive` looks first, which is enough for Tau's random temp names. */
  async write(path: string, data: Buffer, options: ServerFsCallOptions & { mode?: number; exclusive?: boolean } = {}): Promise<void> {
    const real = await this.resolve(path, options);
    const before = this.kinds.get(real) ?? await this.learn(real, options.signal);
    if (options.exclusive && before) throw new SftpError(SFTP_STATUS.FAILURE, "File exists", path);
    await this.call(real, (client) => client.uploadFrom(Readable.from(data.length ? [data] : [], { objectMode: false }), real), options.signal, false);
    this.kinds.set(real, "file");
    if (!before && options.mode !== undefined && this.caps.chmod) await this.chmod(path, options.mode, options).catch(() => undefined);
  }

  async rename(from: string, to: string, options?: ServerFsCallOptions): Promise<void> {
    const source = await this.resolve(from, options, "not-root");
    const target = await this.resolve(to, options, "not-root");
    await this.call(source, (client) => client.rename(source, target), options?.signal);
    const kind = this.kinds.get(source);
    this.forget(source);
    this.forget(target);
    if (kind) this.kinds.set(target, kind);
  }

  async remove(path: string, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options, "not-root");
    await this.call(real, (client) => client.send(`DELE ${real}`), options?.signal);
    this.forget(real);
  }

  async mkdir(path: string, options: ServerFsCallOptions & { mode?: number } = {}): Promise<void> {
    const real = await this.resolve(path, options, "not-root");
    await this.call(real, (client) => client.send(`MKD ${real}`), options.signal, false);
    this.kinds.set(real, "directory");
    if (options.mode !== undefined && this.caps.chmod) await this.chmod(path, options.mode, options).catch(() => undefined);
  }

  async rmdir(path: string, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options, "not-root");
    await this.call(real, (client) => client.send(`RMD ${real}`), options?.signal);
    this.forget(real);
  }

  /** `SITE CHMOD`; a server that does not know it has no modes, and nothing is lost. */
  async chmod(path: string, mode: number, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options);
    if (!this.caps.chmod) return;
    try {
      await this.use((client) => client.send(`SITE CHMOD ${(mode & 0o7777).toString(8)} ${real}`), options?.signal);
    } catch (error) {
      if (error instanceof FTPError && UNSUPPORTED.has(error.code)) {
        this.caps = { ...this.caps, chmod: false };
        return;
      }
      throw await this.refusal(error, real, options?.signal);
    }
  }

  async setMtime(path: string, mtime: number, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options);
    if (!this.caps.mtimeSet) throw new SftpError(SFTP_STATUS.OP_UNSUPPORTED, `${this.label} cannot set a file's time (no MFMT)`, path);
    const stamp = new Date(mtime * 1000).toISOString().replace(/[-:T]/gu, "").slice(0, 14);
    await this.call(real, (client) => client.send(`MFMT ${stamp} ${real}`), options?.signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connecting?.catch(() => undefined);
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.idle.length = 0;
    for (const wake of this.waiting.splice(0)) wake();
    this.password = undefined;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A server's answer as the sync code reads SFTP's: refused, or the connection gone. */
export function toServerError(error: unknown, path: string, label: string): Error {
  if (error instanceof SftpError || error instanceof ServerPathError || error instanceof SshConnectError) return error;
  if (error instanceof FTPError) {
    const code = error.code === 550 || error.code === 553 || error.code === 450 || error.code === 530 || error.code === 532 ? SFTP_STATUS.PERMISSION_DENIED : SFTP_STATUS.FAILURE;
    return new SftpError(code, error.message.replace(/\s+/gu, " ").trim(), path);
  }
  if (error instanceof Error && error.name === "AbortError") return error;
  return new SftpError(SFTP_STATUS.CONNECTION_LOST, `The connection to ${label} was lost (${messageOf(error)})`, path);
}

async function defaultLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((entry) => entry.address);
}

/** The open FTP transports, one per project and target. */
export class FtpConnections {
  private readonly open = new Map<string, { workspace: string; transport: FtpTransport; fingerprint: string }>();

  /** The open transport of a target as sftp.json names it now; a changed entry gets a new one. */
  get(workspace: string, target: FtpTarget, create: () => FtpTransport): FtpTransport {
    const key = `${workspace}\0${target.id}`;
    const fingerprint = JSON.stringify(target);
    const existing = this.open.get(key);
    if (existing && existing.fingerprint === fingerprint) return existing.transport;
    if (existing) void existing.transport.close();
    const transport = create();
    this.open.set(key, { workspace, transport, fingerprint });
    return transport;
  }

  async closeWorkspace(workspace: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.open) {
      if (entry.workspace !== workspace) continue;
      this.open.delete(key);
      closing.push(entry.transport.close());
    }
    await Promise.all(closing);
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((entry) => entry.transport.close()));
  }
}
