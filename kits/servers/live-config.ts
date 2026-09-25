// Live credentials in a server project (plan-I §1.7): what the scan reports and
// how an upload selection treats it. No imports, so the desktop half may read it.

/** A framework whose config file holds the live database credentials. */
export type Framework = "wordpress" | "laravel" | "symfony" | "drupal" | "joomla" | "magento" | "typo3";
export const FRAMEWORKS: readonly Framework[] = ["wordpress", "laravel", "symfony", "drupal", "joomla", "magento", "typo3"];

export type ConfigSecretKind =
  | "wordpress-config"
  | "laravel-database"
  | "symfony-parameters"
  | "drupal-settings"
  | "joomla-configuration"
  | "magento-env"
  | "typo3-configuration"
  | "dotenv";
export type DsnSecretKind = "mysql-dsn" | "postgres-dsn" | "redis-dsn" | "smtp-dsn";
export type KeySecretKind = "stripe-live-key" | "aws-access-key" | "private-key";
export type SecretKind = ConfigSecretKind | DsnSecretKind | KeySecretKind;

/**
 * One place a file holds credentials. Never the value: the kind names the
 * pattern, the line (1-based) where it starts.
 */
export interface SecretFinding {
  /** Relative to the scanned root, `/`-separated. */
  path: string;
  kind: SecretKind;
  line: number;
  /** Set for a framework's own config file. */
  framework?: Framework;
}

export const SECRET_KIND_LABELS: Readonly<Record<SecretKind, string>> = {
  "wordpress-config": "WordPress database settings",
  "laravel-database": "Laravel database config",
  "symfony-parameters": "Symfony parameters",
  "drupal-settings": "Drupal database settings",
  "joomla-configuration": "Joomla configuration",
  "magento-env": "Magento env.php",
  "typo3-configuration": "TYPO3 system settings",
  dotenv: "Environment file",
  "mysql-dsn": "MySQL connection URL",
  "postgres-dsn": "PostgreSQL connection URL",
  "redis-dsn": "Redis connection URL",
  "smtp-dsn": "SMTP connection URL",
  "stripe-live-key": "Stripe live key",
  "aws-access-key": "AWS access key",
  "private-key": "Private key",
};

/** The mark on a guarded row, for the deployment preview. */
export const CREDENTIALS_GUARD_NOTE = "Contains credentials – a local change would go live";

// ---- Upload block list ----------------------------------------------------

/** Relative, `/`-separated, no `.`/`..` segments; undefined for anything else. */
export function normalizeProjectPath(path: string): string | undefined {
  const slashed = path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!slashed || slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed)) return undefined;
  if (slashed.split("/").some((segment) => segment === "." || segment === ".." || segment === "")) return undefined;
  return slashed;
}

/** Paths on the kit's own list never go to the server and never show as pending. */
export function isUploadBlocked(path: string, blocklist: readonly string[]): boolean {
  const normalized = normalizeProjectPath(path);
  return normalized !== undefined && blocklist.includes(normalized);
}

// ---- Upload selection guard -------------------------------------------------

export type UploadOp = "add" | "modify" | "delete";

/** One pending row as the deployment selection (I10) lists it. */
export interface UploadCandidate {
  path: string;
  op: UploadOp;
}

export interface UploadCredentialsGuard {
  reason: "credentials";
  /** What the scan found in the local file or in the server's copy; empty for a deleted framework config found by name. */
  kinds: SecretKind[];
}

export interface GuardedUploadRow<C extends UploadCandidate = UploadCandidate> {
  candidate: C;
  /** The row's default checkbox state; a guarded row starts unchecked. */
  selected: boolean;
  guard?: UploadCredentialsGuard;
}

export interface GuardedUploadSelection<C extends UploadCandidate = UploadCandidate> {
  rows: Array<GuardedUploadRow<C>>;
  /** Blocked paths taken out of the list; they must not show as pending. */
  withheld: string[];
}

export interface UploadGuardInput {
  /**
   * Findings for the local files and for the mirror state (the server's copy):
   * a file whose server copy holds credentials is guarded even when the local
   * copy lost them, since uploading it would overwrite the live values.
   */
  findings: readonly SecretFinding[];
  blocklist: readonly string[];
}

/**
 * The deployment selection's defaults: blocked paths leave the list, a file
 * with credentials starts unchecked and marked, everything else starts checked
 * (deletions too, per the user's decision). Order is kept.
 */
export function guardUploadSelection<C extends UploadCandidate>(candidates: readonly C[], input: UploadGuardInput): GuardedUploadSelection<C> {
  const kindsByPath = new Map<string, Set<SecretKind>>();
  for (const finding of input.findings) {
    const path = normalizeProjectPath(finding.path);
    if (path === undefined) continue;
    const kinds = kindsByPath.get(path) ?? new Set<SecretKind>();
    kinds.add(finding.kind);
    kindsByPath.set(path, kinds);
  }
  const rows: Array<GuardedUploadRow<C>> = [];
  const withheld: string[] = [];
  for (const candidate of candidates) {
    const path = normalizeProjectPath(candidate.path) ?? candidate.path;
    if (isUploadBlocked(path, input.blocklist)) {
      withheld.push(path);
      continue;
    }
    const kinds = kindsByPath.get(path);
    const byName = candidate.op === "delete" && frameworkConfigKind(path) !== undefined;
    if (kinds || byName) {
      rows.push({ candidate, selected: false, guard: { reason: "credentials", kinds: kinds ? [...kinds].sort() : [] } });
    } else {
      rows.push({ candidate, selected: true });
    }
  }
  return { rows, withheld };
}

// ---- Framework config files by path ------------------------------------------

const ENV_TEMPLATE = /^\.env\.(?:example|sample|dist|template|defaults)$/u;

/**
 * The config kind a path names by itself, before its content is read: the
 * files that hold a framework's live settings. `wp-config-sample.php` and
 * `.env.example` are templates, not config.
 */
export function frameworkConfigKind(path: string): { kind: ConfigSecretKind; framework?: Framework } | undefined {
  const normalized = normalizeProjectPath(path);
  if (normalized === undefined) return undefined;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const at = (suffix: string) => normalized === suffix || normalized.endsWith(`/${suffix}`);
  if (name === "wp-config.php") return { kind: "wordpress-config", framework: "wordpress" };
  if (at("config/database.php")) return { kind: "laravel-database", framework: "laravel" };
  if (name === "parameters.yml" || name === "parameters.yaml") return { kind: "symfony-parameters", framework: "symfony" };
  if (/(?:^|\/)sites\/[^/]+\/settings\.php$/u.test(normalized)) return { kind: "drupal-settings", framework: "drupal" };
  if (name === "configuration.php") return { kind: "joomla-configuration", framework: "joomla" };
  if (at("app/etc/env.php")) return { kind: "magento-env", framework: "magento" };
  if (at("typo3conf/LocalConfiguration.php") || at("typo3conf/AdditionalConfiguration.php") || at("config/system/settings.php") || at("config/system/additional.php")) {
    return { kind: "typo3-configuration", framework: "typo3" };
  }
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATE.test(name)) return { kind: "dotenv" };
  return undefined;
}

/**
 * Which framework a project is, from its file list (relative paths). `.env`
 * alone says nothing, so Laravel and Symfony are told apart by their markers.
 */
export function detectFramework(paths: Iterable<string>): Framework | undefined {
  const set = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeProjectPath(path);
    if (normalized !== undefined) set.add(normalized);
  }
  const has = (...candidates: string[]) => candidates.some((candidate) => set.has(candidate));
  if (has("wp-config.php", "wp-settings.php", "wp-config-sample.php")) return "wordpress";
  if (has("app/etc/env.php", "bin/magento")) return "magento";
  if (has("typo3conf/LocalConfiguration.php", "config/system/settings.php", "typo3/index.php", "public/typo3/index.php")) return "typo3";
  if ([...set].some((path) => /(?:^|\/)sites\/default\/settings\.php$/u.test(path)) || has("core/lib/Drupal.php", "web/core/lib/Drupal.php")) return "drupal";
  if (has("configuration.php") && has("libraries/src/Factory.php", "administrator/index.php")) return "joomla";
  if (has("artisan")) return "laravel";
  if (has("symfony.lock", "bin/console", "app/config/parameters.yml", "config/parameters.yml")) return "symfony";
  if (has("configuration.php")) return "joomla";
  return undefined;
}
