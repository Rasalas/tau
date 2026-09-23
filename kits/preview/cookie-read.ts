import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CookieImportFailure, CookieImportSite } from "./protocol.js";
import type { CookieEngine } from "./cookie-sources.js";
import { bareHost, siteOf } from "./cookie-sites.js";

export { bareHost, siteOf };

/** A failure the dialog can name; the reason travels as `[reason]` in the message. */
export class CookieImportError extends Error {
  constructor(readonly reason: CookieImportFailure, message: string, options?: { cause?: unknown }) {
    super(`[${reason}] ${message}`, options);
  }
}

/** A stored cookie before its value is decrypted. */
export interface StoredCookie {
  host: string;
  name: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the UNIX epoch; none for a session cookie. */
  expires?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Plain text, when the store keeps it that way. */
  value?: string;
  /** Chromium's `v10`/`v11` blob. */
  encrypted?: Uint8Array;
}

/** A cookie in the shape Electron's `cookies.set` takes. */
export interface CookieToWrite {
  url: string;
  name: string;
  value: string;
  /** Only for domain cookies: Electron widens any cookie given a domain to its subdomains. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: StoredCookie["sameSite"];
}

/**
 * Copies a store (and the journal beside it) into a private temporary folder
 * and runs `use` on the copy, so the browser's own file is never opened, even
 * while the browser runs and holds its lock. The copy is removed afterwards.
 */
export async function withStoreSnapshot<T>(store: string, use: (copy: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "tau-cookie-import-"));
  try {
    const copy = join(folder, basename(store));
    try {
      await copyFile(store, copy);
    } catch (error) {
      throw readFailure(error);
    }
    for (const suffix of ["-wal", "-journal"]) await copyFile(`${store}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    return await use(copy);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** macOS answers a read of Safari's container without Full Disk Access with EPERM. */
export function readFailure(error: unknown): CookieImportError {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "EPERM"
    ? new CookieImportError("full-disk-access", "Tau needs Full Disk Access to read this browser's cookies.", { cause: error })
    : new CookieImportError("read-failed", "The browser's cookie store could not be read.", { cause: error });
}

async function openDatabase(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  // A copy taken while the browser wrote can be torn; that is "try again", not an empty import.
  const check = database.prepare("pragma quick_check").get() as { quick_check?: unknown } | undefined;
  if (check?.quick_check !== "ok") {
    database.close();
    throw new CookieImportError("busy", "The browser was writing its cookies. Quit it, then try again.");
  }
  return database;
}

const columnsOf = (database: DatabaseSync, table: string): Set<string> =>
  new Set((database.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));

/** Chromium counts microseconds from 1601; the division runs in SQL, where the number fits. */
const WEBKIT_EPOCH_SECONDS = 11_644_473_600;

const chromiumSameSite = (value: number): StoredCookie["sameSite"] =>
  value === 0 ? "no_restriction" : value === 1 ? "lax" : value === 2 ? "strict" : "unspecified";

/** Firefox 0 = None, 1 = Lax, 2 = Strict, 256 = not declared. */
const firefoxSameSite = (value: number | null): StoredCookie["sameSite"] =>
  value === 0 ? "no_restriction" : value === 1 ? "lax" : value === 2 ? "strict" : "unspecified";

interface ChromiumRead {
  cookies: StoredCookie[];
  /** Cookies partitioned under another top-level site, which Electron cannot hold. */
  partitioned: string[];
  schema: number;
}

function readChromium(database: DatabaseSync): ChromiumRead {
  const meta = database.prepare("select value from meta where key = 'version'").get() as { value?: unknown } | undefined;
  const schema = Number(meta?.value ?? 0) || 0;
  const partitionKey = columnsOf(database, "cookies").has("top_frame_site_key") ? "top_frame_site_key" : "''";
  const rows = database.prepare(`select host_key, name, value, encrypted_value, path, expires_utc / 1000000 as expires,
    is_secure, is_httponly, samesite, ${partitionKey} as partition_key from cookies`).all() as Array<{
    host_key: string; name: string; value: string; encrypted_value: Uint8Array | null; path: string; expires: number;
    is_secure: number; is_httponly: number; samesite: number; partition_key: string | null;
  }>;
  const cookies: StoredCookie[] = [];
  const partitioned: string[] = [];
  for (const row of rows) {
    if (row.partition_key) {
      partitioned.push(row.host_key);
      continue;
    }
    const encrypted = row.encrypted_value && row.encrypted_value.length > 0 ? row.encrypted_value : undefined;
    cookies.push({
      host: row.host_key,
      name: row.name,
      path: row.path || "/",
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      ...(row.expires > 0 ? { expires: row.expires - WEBKIT_EPOCH_SECONDS } : {}),
      sameSite: chromiumSameSite(row.samesite),
      ...(encrypted ? { encrypted } : { value: row.value }),
    });
  }
  return { cookies, partitioned, schema };
}

/** Schema 16 (Firefox 129) moved `expiry` from seconds to milliseconds. */
const FIREFOX_MILLISECONDS_SCHEMA = 16;

function readFirefox(database: DatabaseSync): StoredCookie[] {
  const version = Number((database.prepare("pragma user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
  // Containers and private windows are other identities Electron has no place for.
  // `node:sqlite` refuses integers past 2^53; a far-future expiry is clamped where it is read.
  const rows = database.prepare(`select host, name, value, path, min(expiry, 9007199254740991) as expiry, isSecure, isHttpOnly, sameSite
    from moz_cookies where originAttributes = ''`).all() as Array<{
    host: string; name: string; value: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number | null;
  }>;
  return rows.map((row) => {
    const expires = row.expiry > 0 ? version >= FIREFOX_MILLISECONDS_SCHEMA ? Math.floor(row.expiry / 1000) : row.expiry : undefined;
    return {
      host: row.host,
      name: row.name,
      value: row.value,
      path: row.path || "/",
      secure: row.isSecure === 1,
      httpOnly: row.isHttpOnly === 1,
      ...(expires ? { expires } : {}),
      sameSite: firefoxSameSite(row.sameSite),
    };
  });
}

/** Safari counts seconds from 2001-01-01. */
const APPLE_EPOCH_SECONDS = 978_307_200;
const SAFARI_PAGE_HEADER = 12;
const SAFARI_RECORD_HEADER = 56;

function cString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

/**
 * `Cookies.binarycookies`: "cook", a big-endian page table, then pages whose
 * bodies are little-endian records of offsets into NUL-terminated strings.
 * Every offset is checked against its page and record; a file that lies about
 * its layout is refused rather than read half.
 */
export function parseBinaryCookies(buffer: Buffer): StoredCookie[] {
  const refuse = () => new CookieImportError("read-failed", "Safari's cookie file has a layout Tau does not know.");
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") throw refuse();
  const pages = buffer.readUInt32BE(4);
  if (8 + pages * 4 > buffer.length) throw refuse();
  const cookies: StoredCookie[] = [];
  let pageStart = 8 + pages * 4;
  for (let index = 0; index < pages; index += 1) {
    const size = buffer.readUInt32BE(8 + index * 4);
    if (size < SAFARI_PAGE_HEADER || pageStart + size > buffer.length) throw refuse();
    const page = buffer.subarray(pageStart, pageStart + size);
    pageStart += size;
    const count = page.readUInt32LE(4);
    const tableEnd = SAFARI_PAGE_HEADER + count * 4;
    if (tableEnd > page.length) throw refuse();
    for (let entry = 0; entry < count; entry += 1) {
      const start = page.readUInt32LE(8 + entry * 4);
      if (start < tableEnd || start + SAFARI_RECORD_HEADER > page.length) throw refuse();
      const length = page.readUInt32LE(start);
      if (length < SAFARI_RECORD_HEADER || start + length > page.length) throw refuse();
      const record = page.subarray(start, start + length);
      const flags = record.readUInt32LE(8);
      const offsets = [16, 20, 24, 28].map((at) => record.readUInt32LE(at));
      if (offsets.some((offset) => offset < SAFARI_RECORD_HEADER || offset >= record.length)) throw refuse();
      const [host, name, path, value] = offsets.map((offset) => cString(record, offset)) as [string, string, string, string];
      if (!host || !name) continue;
      const expiry = record.readDoubleLE(40);
      cookies.push({
        host,
        name,
        value,
        path: path || "/",
        secure: (flags & 0x1) !== 0,
        httpOnly: (flags & 0x4) !== 0,
        ...(expiry > 0 ? { expires: Math.floor(expiry) + APPLE_EPOCH_SECONDS } : {}),
        // No public description of Safari's SameSite bits holds up; Lax is the modern default.
        sameSite: "lax",
      });
    }
  }
  return cookies;
}

export interface StoreRead {
  cookies: StoredCookie[];
  /** Hosts of cookies that cannot be imported whatever the key. */
  unreadable: string[];
  /** Chromium's cookie schema; from 24 a value starts with the hash of its host. */
  schema: number;
}

/** Everything in a store, values still encrypted where the browser encrypts them. */
export async function readStore(engine: CookieEngine, store: string): Promise<StoreRead> {
  if (engine === "safari") {
    const contents = await readFile(store).catch((error: unknown) => { throw readFailure(error); });
    return { cookies: parseBinaryCookies(contents), unreadable: [], schema: 0 };
  }
  return withStoreSnapshot(store, async (copy) => {
    const database = await openDatabase(copy).catch((error: unknown) => {
      throw error instanceof CookieImportError ? error : readFailure(error);
    });
    try {
      if (engine === "firefox") return { cookies: readFirefox(database), unreadable: [], schema: 0 };
      const read = readChromium(database);
      return { cookies: read.cookies, unreadable: read.partitioned, schema: read.schema };
    } catch (error) {
      throw error instanceof CookieImportError ? error : readFailure(error);
    } finally {
      database.close();
    }
  });
}

/** Sites and their cookie counts, alphabetical. No value is read or decrypted. */
export function sitesOf(cookies: readonly StoredCookie[]): CookieImportSite[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const site = siteOf(cookie.host);
    if (site) counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts].map(([site, count]) => ({ site, cookies: count })).sort((a, b) => a.site.localeCompare(b.site));
}

/** The keys a Chromium store's values decrypt with, by prefix. */
export interface ChromiumKeys {
  v10?: Buffer;
  v11?: Buffer;
}

const SALT = "saltysalt";
/** macOS stretches the keychain secret; Linux derives with one round. */
export const chromiumKey = (secret: string, platform: NodeJS.Platform): Buffer =>
  pbkdf2Sync(secret, SALT, platform === "darwin" ? 1003 : 1, 16, "sha1");

/** Chromium on Linux without a keyring encrypts `v10` with this documented passphrase. */
export const LINUX_FALLBACK_SECRET = "peanuts";

/** OSCrypt's CBC mode uses a fixed IV of sixteen spaces. */
const CBC_IV = Buffer.alloc(16, 0x20);

/** A value, or `undefined` when no key opens it or it is bound to another host. */
export function decryptChromium(encrypted: Uint8Array, host: string, keys: ChromiumKeys, schema: number): string | undefined {
  const blob = Buffer.from(encrypted);
  const prefix = blob.subarray(0, 3).toString("latin1");
  const key = prefix === "v10" ? keys.v10 : prefix === "v11" ? keys.v11 : undefined;
  if (!key) return undefined;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV);
    plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
  if (schema < 24) return plain.toString("utf8");
  // From schema 24 the value is bound to its host: SHA-256 of the host comes first.
  const binding = createHash("sha256").update(host).digest();
  return plain.length >= 32 && plain.subarray(0, 32).equals(binding) ? plain.subarray(32).toString("utf8") : undefined;
}

/** Where Electron registers a cookie: a URL on its host, and a domain only for a domain cookie. */
export function cookieToWrite(cookie: StoredCookie, value: string): CookieToWrite {
  const host = bareHost(cookie.host);
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    url: `${cookie.secure ? "https" : "http"}://${authority}${cookie.path}`,
    name: cookie.name,
    value,
    ...(cookie.host.startsWith(".") ? { domain: cookie.host } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires !== undefined ? { expirationDate: cookie.expires } : {}),
    sameSite: cookie.sameSite,
  };
}
