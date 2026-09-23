/**
 * Fixture browser profiles for tests and isolated instances: cookie stores laid
 * out like Chrome's, Firefox's and Safari's, encrypted with a test secret.
 * Imports only Node built-ins, so `node` can run it straight from source.
 */
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface FixtureCookie {
  host: string;
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Seconds since the UNIX epoch. */
  expires?: number;
  /** Chromium's column: -1 unspecified, 0 none, 1 lax, 2 strict. */
  sameSite?: number;
  /** Chromium: partitioned under this top-level site. */
  partitionKey?: string;
  /** Chromium: stored in the clear instead of encrypted. */
  plain?: boolean;
  /** Firefox: a container's cookie. */
  originAttributes?: string;
}

const WEBKIT_EPOCH_SECONDS = 11_644_473_600;

/** `v10` as Chromium on macOS (1003 rounds) or Linux (one) writes it. */
export function encryptChromiumValue(value: string, host: string, secret: string, options: { schema?: number; platform?: NodeJS.Platform } = {}): Buffer {
  const key = pbkdf2Sync(secret, "saltysalt", options.platform === "linux" ? 1 : 1003, 16, "sha1");
  const plain = (options.schema ?? 24) >= 24
    ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value, "utf8")])
    : Buffer.from(value, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

export function writeChromiumStore(path: string, cookies: readonly FixtureCookie[], options: { secret: string; schema?: number; platform?: NodeJS.Platform }): void {
  mkdirSync(dirname(path), { recursive: true });
  const schema = options.schema ?? 24;
  const database = new DatabaseSync(path);
  database.exec(`create table meta (key text primary key, value text);
    create table cookies (creation_utc integer, host_key text, top_frame_site_key text, name text, value text,
      encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer)`);
  database.prepare("insert into meta values ('version', ?)").run(String(schema));
  const insert = database.prepare("insert into cookies values (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const cookie of cookies) {
    const encrypted = cookie.plain ? Buffer.alloc(0) : encryptChromiumValue(cookie.value, cookie.host, options.secret, { schema, ...(options.platform ? { platform: options.platform } : {}) });
    const expires = cookie.expires ? BigInt(cookie.expires + WEBKIT_EPOCH_SECONDS) * 1_000_000n : 0n;
    insert.run(cookie.host, cookie.partitionKey ?? "", cookie.name, cookie.plain ? cookie.value : "", encrypted, cookie.path ?? "/", expires,
      cookie.secure ? 1 : 0, cookie.httpOnly ? 1 : 0, cookie.sameSite ?? -1);
  }
  database.close();
}

export function writeFirefoxStore(path: string, cookies: readonly FixtureCookie[], options: { version?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const version = options.version ?? 16;
  const database = new DatabaseSync(path);
  database.exec(`create table moz_cookies (id integer primary key, originAttributes text not null default '', name text, value text,
    host text, path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer); pragma user_version = ${version}`);
  const insert = database.prepare("insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const cookie of cookies) {
    const expiry = cookie.expires ? version >= 16 ? cookie.expires * 1000 : cookie.expires : 0;
    insert.run(cookie.originAttributes ?? "", cookie.name, cookie.value, cookie.host, cookie.path ?? "/", expiry, cookie.secure ? 1 : 0, cookie.httpOnly ? 1 : 0, cookie.sameSite ?? 256);
  }
  database.close();
}

const APPLE_EPOCH_SECONDS = 978_307_200;

/** One page of `Cookies.binarycookies`, with the checksum trailer Safari writes. */
export function buildBinaryCookies(cookies: readonly FixtureCookie[]): Buffer {
  const records = cookies.map((cookie) => {
    const strings = [cookie.host, cookie.name, cookie.path ?? "/", cookie.value].map((text) => Buffer.from(`${text}\0`, "utf8"));
    const header = Buffer.alloc(56);
    const size = 56 + strings.reduce((sum, part) => sum + part.length, 0);
    header.writeUInt32LE(size, 0);
    header.writeUInt32LE((cookie.secure ? 0x1 : 0) | (cookie.httpOnly ? 0x4 : 0), 8);
    let offset = 56;
    strings.forEach((part, index) => {
      header.writeUInt32LE(offset, 16 + index * 4);
      offset += part.length;
    });
    header.writeDoubleLE(cookie.expires ? cookie.expires - APPLE_EPOCH_SECONDS : 0, 40);
    return Buffer.concat([header, ...strings]);
  });
  const tableEnd = 12 + records.length * 4;
  const pageHeader = Buffer.alloc(tableEnd);
  pageHeader.writeUInt32BE(0x100, 0);
  pageHeader.writeUInt32LE(records.length, 4);
  let at = tableEnd;
  records.forEach((record, index) => {
    pageHeader.writeUInt32LE(at, 8 + index * 4);
    at += record.length;
  });
  const page = Buffer.concat([pageHeader, ...records]);
  const fileHeader = Buffer.alloc(12);
  fileHeader.write("cook", 0, "latin1");
  fileHeader.writeUInt32BE(1, 4);
  fileHeader.writeUInt32BE(page.length, 8);
  return Buffer.concat([fileHeader, page, Buffer.alloc(8)]);
}

/**
 * A macOS home with Chrome (two profiles), Firefox and Safari, and a
 * `keychain.json` beside them for the fixture keychain.
 */
export function writeFixtureHome(home: string, cookies: { chrome?: FixtureCookie[]; chromeWork?: FixtureCookie[]; firefox?: FixtureCookie[]; safari?: FixtureCookie[] }, secret = "fixture-secret"): void {
  const support = join(home, "Library", "Application Support");
  const chrome = join(support, "Google", "Chrome");
  mkdirSync(chrome, { recursive: true });
  writeFileSync(join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" }, "Profile 1": { name: "Work" } } } }));
  writeChromiumStore(join(chrome, "Default", "Network", "Cookies"), cookies.chrome ?? [], { secret });
  writeChromiumStore(join(chrome, "Profile 1", "Network", "Cookies"), cookies.chromeWork ?? [], { secret });
  const firefox = join(support, "Firefox");
  mkdirSync(firefox, { recursive: true });
  writeFileSync(join(firefox, "profiles.ini"), "[Install1]\nDefault=Profiles/fixture.default\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/fixture.default\n");
  writeFirefoxStore(join(firefox, "Profiles", "fixture.default", "cookies.sqlite"), cookies.firefox ?? []);
  const safari = join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies");
  mkdirSync(safari, { recursive: true });
  writeFileSync(join(safari, "Cookies.binarycookies"), buildBinaryCookies(cookies.safari ?? []));
  writeFileSync(join(home, "keychain.json"), JSON.stringify({ "Chrome Safe Storage": secret }));
}
