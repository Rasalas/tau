import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { frameworkConfigKind, normalizeProjectPath, type ConfigSecretKind, type SecretFinding, type SecretKind } from "./live-config.js";

// Finds live credentials in a project (plan-I §1.7). A finding is path, kind and
// line, never the value: nothing here returns, logs or throws matched text.

function isPlaceholder(value: string): boolean {
  const bare = value.trim().replace(/^['"]|['"]$/gu, "").trim();
  return bare === "" || bare === "~" || /^null$/iu.test(bare) || /^\$\{.*\}$/u.test(bare) || /^%[^%]*%$/u.test(bare) || /^\{\{.*\}\}$/u.test(bare) || /^<[^>]*>$/u.test(bare);
}

// `define('DB_HOST', 'literal')`; `getenv()` and constants are not literals.
const WORDPRESS_LINE = /\bdefine\s*\(\s*['"]DB_(?:HOST|USER|PASSWORD|NAME)['"]\s*,\s*['"][^'"]/u;
// `'password' => 'literal'` in a PHP array; Laravel's `env('DB_HOST')` is not a literal.
const PHP_ARRAY_LINE = /['"](?:password|passwd|host|username|user|encryptionKey)['"]\s*=>\s*['"][^'"]/u;
const JOOMLA_LINE = /\bpublic\s+\$(?:host|user|password|secret|smtppass)\s*=\s*['"][^'"]/u;
const YAML_KEY = /^\s*([\w.-]+)\s*:\s*(.*)$/u;
const YAML_SECRET_KEY = /(?:password|passwd|host|user|secret)/iu;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u;
const ENV_SECRET_KEY = /(?:PASSWORD|PASSWD|_PASS$|SECRET|TOKEN|API_?KEY|APP_KEY|PRIVATE_KEY|ACCESS_KEY|(?:^|_)DB_HOST$|DATABASE_HOST|DATABASE_URL|REDIS_URL|_DSN$)/iu;

function yamlLineHasSecret(line: string): boolean {
  const match = YAML_KEY.exec(line);
  if (!match || !YAML_SECRET_KEY.test(match[1]!)) return false;
  const value = match[2]!.replace(/\s+#.*$/u, "");
  return !isPlaceholder(value) && !/%env\(/u.test(value);
}

function envLineHasSecret(line: string): boolean {
  const match = ENV_ASSIGNMENT.exec(line);
  if (!match || !ENV_SECRET_KEY.test(match[1]!)) return false;
  const raw = match[2]!.trim();
  const value = raw.startsWith("\"") || raw.startsWith("'") ? raw : raw.replace(/\s+#.*$/u, "");
  return !isPlaceholder(value);
}

const CONFIG_LINE: Record<ConfigSecretKind, (line: string) => boolean> = {
  "wordpress-config": (line) => WORDPRESS_LINE.test(line),
  "laravel-database": (line) => PHP_ARRAY_LINE.test(line),
  "drupal-settings": (line) => PHP_ARRAY_LINE.test(line),
  "magento-env": (line) => PHP_ARRAY_LINE.test(line),
  "typo3-configuration": (line) => PHP_ARRAY_LINE.test(line),
  "joomla-configuration": (line) => JOOMLA_LINE.test(line),
  "symfony-parameters": yamlLineHasSecret,
  dotenv: envLineHasSecret,
};

const DSN_KINDS: Record<string, SecretKind> = {
  mysql: "mysql-dsn", mysqli: "mysql-dsn", mysql2: "mysql-dsn", mariadb: "mysql-dsn", pdo_mysql: "mysql-dsn",
  postgres: "postgres-dsn", postgresql: "postgres-dsn", pgsql: "postgres-dsn", pdo_pgsql: "postgres-dsn",
  redis: "redis-dsn", rediss: "redis-dsn",
  smtp: "smtp-dsn", smtps: "smtp-dsn",
};
// Only a URL that carries a password: `scheme://user:password@` or `scheme://:password@`.
const DSN = /\b(mysql|mysqli|mysql2|mariadb|pdo_mysql|postgres|postgresql|pgsql|pdo_pgsql|redis|rediss|smtp|smtps):\/\/[^\s:@/'"]*:([^\s@/'"]+)@/giu;
const KEY_PATTERNS: Array<[SecretKind, RegExp]> = [
  ["stripe-live-key", /\b[rs]k_live_[0-9A-Za-z]{10,}/u],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u],
];

/** Scans one file's text. `path` is relative to the project and only labels the findings. */
export function scanText(path: string, text: string): SecretFinding[] {
  const label = normalizeProjectPath(path) ?? path;
  const config = frameworkConfigKind(label);
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: SecretKind, line: number, framework?: SecretFinding["framework"]) => {
    const key = `${kind}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(framework ? { path: label, kind, line, framework } : { path: label, kind, line });
  };
  const lines = text.split(/\r?\n/u);
  let configLine: number | undefined;
  lines.forEach((line, index) => {
    if (config && configLine === undefined && CONFIG_LINE[config.kind](line)) configLine = index + 1;
    for (const match of line.matchAll(DSN)) {
      if (!isPlaceholder(match[2]!) && !/[$%{]/u.test(match[2]!)) add(DSN_KINDS[match[1]!.toLowerCase()]!, index + 1);
    }
    for (const [kind, pattern] of KEY_PATTERNS) if (pattern.test(line)) add(kind, index + 1);
  });
  if (config && configLine !== undefined) add(config.kind, configLine, config.framework);
  return findings.sort(compareFindings);
}

function compareFindings(a: SecretFinding, b: SecretFinding): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}

export interface ScanFilesOptions {
  /** Larger files are skipped; the default is 1 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const BINARY_PROBE = 8000;

// Regular files only: a symlink could lead out of the project.
async function readText(file: string, maxBytes: number): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > maxBytes) return undefined;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = await handle.readFile();
    if (buffer.subarray(0, BINARY_PROBE).includes(0)) return undefined;
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Scans the given files below `root` (relative paths, e.g. a download's file
 * list or the pending changes). Missing, binary, oversized and non-regular
 * files are skipped without a word.
 */
export async function scanFiles(root: string, paths: Iterable<string>, options: ScanFilesOptions = {}): Promise<SecretFinding[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const findings: SecretFinding[] = [];
  for (const path of new Set(paths)) {
    const relative = normalizeProjectPath(path);
    if (relative === undefined) continue;
    const text = await readText(join(root, ...relative.split("/")), maxBytes);
    if (text !== undefined) findings.push(...scanText(relative, text));
  }
  return findings.sort(compareFindings);
}

export interface ScanTreeOptions extends ScanFilesOptions {
  /** Folder names left out at any depth; the default skips `.git`, `node_modules` and `vendor`. */
  skipDirs?: readonly string[];
  /** Stops listing after this many files; the default is 20000. */
  maxFiles?: number;
}

/** Relative paths of the regular files below `root`, sorted, without following symlinks. */
export async function listProjectFiles(root: string, options: Pick<ScanTreeOptions, "skipDirs" | "maxFiles"> = {}): Promise<string[]> {
  const skip = new Set(options.skipDirs ?? [".git", "node_modules", "vendor"]);
  const maxFiles = options.maxFiles ?? 20_000;
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative ? join(root, ...relative.split("/")) : root, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await walk("");
  return files;
}

/** Scans a whole local copy, e.g. a folder linked to a target before the sync engine has listed it. */
export async function scanTree(root: string, options: ScanTreeOptions = {}): Promise<SecretFinding[]> {
  return scanFiles(root, await listProjectFiles(root, options), options);
}
