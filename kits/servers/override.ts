import { frameworkConfigKind, normalizeProjectPath, type Framework, type SecretFinding } from "./live-config.js";

// The local override per framework (plan-I §1.7): where local settings go so
// the live config never has to change. Pure; the assistant UI applies it.

/** A one-time edit that makes the framework read the override file when it exists. */
export interface OverrideHook {
  /** The file that loads the override. */
  path: string;
  snippet: string;
  /** Without the override file on the server the edit changes nothing there, so uploading it is harmless. */
  uploadSafe: true;
}

export interface OverrideProposal {
  framework?: Framework;
  /** The file with the live values. */
  configPath: string;
  /**
   * Local-only, goes on the upload block list. Equals `configPath` when the
   * framework has no override mechanism: the file itself is kept local.
   */
  overridePath: string;
  /** Content for a new override file, placeholders only; absent when kept in place. */
  overrideTemplate?: string;
  hook?: OverrideHook;
  /** For `.gitignore`, added only when the user asks. */
  gitignoreEntry: string;
  /** One sentence for the assistant. */
  summary: string;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
}

function inPlace(configPath: string, framework: Framework | undefined, summary: string): OverrideProposal {
  return { ...(framework ? { framework } : {}), configPath, overridePath: configPath, gitignoreEntry: `/${configPath}`, summary };
}

const WORDPRESS_TEMPLATE = `<?php
// Local database for development. Tau never uploads this file.
define('DB_NAME', 'local_database');
define('DB_USER', 'local_user');
define('DB_PASSWORD', 'local_password');
define('DB_HOST', '127.0.0.1');
`;

const DRUPAL_TEMPLATE = `<?php
// Local settings for development. Tau never uploads this file.
$databases['default']['default'] = [
  'driver' => 'mysql',
  'database' => 'local_database',
  'username' => 'local_user',
  'password' => 'local_password',
  'host' => '127.0.0.1',
  'port' => '3306',
  'prefix' => '',
];
`;

const TYPO3_TEMPLATE = `<?php
// Local settings for development. Tau never uploads this file.
$GLOBALS['TYPO3_CONF_VARS']['DB']['Connections']['Default'] = array_merge(
    $GLOBALS['TYPO3_CONF_VARS']['DB']['Connections']['Default'] ?? [],
    [
        'dbname' => 'local_database',
        'user' => 'local_user',
        'password' => 'local_password',
        'host' => '127.0.0.1',
    ]
);
`;

const SYMFONY_ENV_TEMPLATE = `# Local settings for development. Symfony reads this after .env; Tau never uploads it.
DATABASE_URL="mysql://local_user:local_password@127.0.0.1:3306/local_database"
`;

const SYMFONY_PARAMETERS_TEMPLATE = `# Local settings for development. Tau never uploads this file.
parameters:
    database_host: 127.0.0.1
    database_name: local_database
    database_user: local_user
    database_password: local_password
`;

function phpInclude(file: string): string {
  return `if (is_file(__DIR__ . '/${file}')) {\n    require __DIR__ . '/${file}';\n}\n`;
}

/**
 * The override Tau proposes for a finding. `framework` is the project's (see
 * `detectFramework`), needed to tell a Laravel `.env` from a Symfony one.
 */
export function proposeOverride(finding: Pick<SecretFinding, "path" | "kind">, framework?: Framework): OverrideProposal | undefined {
  const configPath = normalizeProjectPath(finding.path);
  if (configPath === undefined) return undefined;
  const config = frameworkConfigKind(configPath);
  const dir = dirOf(configPath);
  const local = (file: string) => `${dir}${file}`;
  switch (config?.kind) {
    case "wordpress-config": {
      const overridePath = local("wp-config-local.php");
      return {
        framework: "wordpress", configPath, overridePath, overrideTemplate: WORDPRESS_TEMPLATE,
        hook: { path: configPath, snippet: `// Local settings, never uploaded.\n${phpInclude("wp-config-local.php")}`, uploadSafe: true },
        gitignoreEntry: `/${overridePath}`,
        summary: "wp-config.php loads wp-config-local.php first when it exists, and its DB_* defines only apply where the override set none.",
      };
    }
    case "drupal-settings": {
      const overridePath = local("settings.local.php");
      return {
        framework: "drupal", configPath, overridePath, overrideTemplate: DRUPAL_TEMPLATE,
        hook: { path: configPath, snippet: `\n// Local settings, never uploaded.\n${phpInclude("settings.local.php")}`, uploadSafe: true },
        gitignoreEntry: `/${overridePath}`,
        summary: "settings.php includes settings.local.php at its end when it exists, as Drupal's own example does.",
      };
    }
    case "typo3-configuration": {
      const modern = configPath.endsWith("config/system/settings.php") || configPath.endsWith("config/system/additional.php");
      const hookFile = modern ? "additional.php" : "AdditionalConfiguration.php";
      const overrideFile = modern ? "additional.local.php" : "AdditionalConfiguration.local.php";
      const overridePath = local(overrideFile);
      return {
        framework: "typo3", configPath, overridePath, overrideTemplate: TYPO3_TEMPLATE,
        hook: { path: local(hookFile), snippet: `\n// Local settings, never uploaded.\n${phpInclude(overrideFile)}`, uploadSafe: true },
        gitignoreEntry: `/${overridePath}`,
        summary: `${hookFile} includes ${overrideFile} when it exists; TYPO3 reads it after the system settings.`,
      };
    }
    case "symfony-parameters": {
      const overrideFile = configPath.endsWith(".yaml") ? "parameters.local.yaml" : "parameters.local.yml";
      const overridePath = local(overrideFile);
      const hookPath = dir.endsWith("app/config/") ? local("config.yml") : local("services.yaml");
      return {
        framework: "symfony", configPath, overridePath, overrideTemplate: SYMFONY_PARAMETERS_TEMPLATE,
        hook: { path: hookPath, snippet: `- { resource: ${overrideFile}, ignore_errors: true }`, uploadSafe: true },
        gitignoreEntry: `/${overridePath}`,
        summary: `The config imports ${overrideFile} after the parameters file; a missing file is ignored.`,
      };
    }
    case "dotenv":
      if (framework === "symfony" && configPath.endsWith(".env")) {
        const overridePath = local(".env.local");
        return {
          framework: "symfony", configPath, overridePath, overrideTemplate: SYMFONY_ENV_TEMPLATE,
          gitignoreEntry: `/${overridePath}`,
          summary: "Symfony reads .env.local after .env by itself; no edit needed.",
        };
      }
      return inPlace(configPath, framework, framework === "laravel"
        ? "Laravel reads only one .env, so the local copy keeps local values and Tau never uploads it."
        : "The local copy keeps local values and Tau never uploads it.");
    case "laravel-database":
      return inPlace(configPath, "laravel", "The literal values should move to .env; until then the local copy stays local.");
    case "magento-env":
      return inPlace(configPath, "magento", "Magento keeps each environment's settings in app/etc/env.php, so the local copy keeps local values and Tau never uploads it.");
    case "joomla-configuration":
      return inPlace(configPath, "joomla", "Joomla has no override file, so the local configuration.php keeps local values and Tau never uploads it.");
    default:
      return inPlace(configPath, framework, "The local copy keeps local values and Tau never uploads it.");
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The hook file's new text with the hook applied, or undefined when it is
 * already there or there is no place to put it. `text` is undefined for a
 * hook file that does not exist yet (TYPO3's additional configuration).
 * Values in the file are left as they are.
 */
export function applyOverrideHook(proposal: OverrideProposal, text: string | undefined): string | undefined {
  const hook = proposal.hook;
  if (!hook) return undefined;
  const file = basename(proposal.overridePath);
  if (proposal.framework === "symfony") {
    if (text === undefined || new RegExp(`resource:\\s*['"]?${escapeRegex(file)}`, "u").test(text)) return undefined;
    const lines = text.split("\n");
    const at = lines.findIndex((line) => /^\s*-\s*\{?\s*resource:\s*['"]?parameters\.ya?ml\b/u.test(line));
    if (at < 0) return undefined;
    const indent = /^\s*/u.exec(lines[at]!)![0];
    lines.splice(at + 1, 0, `${indent}${hook.snippet}`);
    return lines.join("\n");
  }
  if (text !== undefined && new RegExp(`^\\s*(?:require|include)(?:_once)?\\b[^\\n]*${escapeRegex(file)}`, "mu").test(text)) return undefined;
  if (proposal.framework === "wordpress") {
    if (text === undefined) return undefined;
    const open = /^<\?php[^\n]*\n/u.exec(text);
    if (!open) return undefined;
    // Redefining a constant warns, so the live defines only fill what the override left unset.
    const rest = text.slice(open[0].length).replace(/^(\s*)(define\s*\(\s*(['"])(DB_[A-Z_]+)\3)/gmu, "$1defined('$4') || $2");
    return `${open[0]}${hook.snippet}\n${rest}`;
  }
  if (text === undefined) return proposal.framework === "typo3" ? `<?php\n${hook.snippet}` : undefined;
  return `${text.replace(/\n*$/u, "\n")}${hook.snippet}`;
}

/** `.gitignore` text with the entry added once; only on the user's request. */
export function withGitignoreEntry(text: string, entry: string): string {
  if (text.split(/\r?\n/u).some((line) => line.trim() === entry)) return text;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${entry}\n`;
}
