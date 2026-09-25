import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOverrideHook, proposeOverride, withGitignoreEntry } from "./override.js";

const PROJECTS = join(import.meta.dirname, "fixtures", "projects");
const fixture = (path: string) => readFile(join(PROJECTS, path), "utf8");
const hasPhp = spawnSync("php", ["--version"], { stdio: "ignore" }).status === 0;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-override-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("proposeOverride", () => {
  it.each([
    ["wordpress-config", "wp-config.php", undefined, "wp-config-local.php", "wp-config.php"],
    ["wordpress-config", "public/wp-config.php", undefined, "public/wp-config-local.php", "public/wp-config.php"],
    ["drupal-settings", "sites/default/settings.php", undefined, "sites/default/settings.local.php", "sites/default/settings.php"],
    ["typo3-configuration", "typo3conf/LocalConfiguration.php", undefined, "typo3conf/AdditionalConfiguration.local.php", "typo3conf/AdditionalConfiguration.php"],
    ["typo3-configuration", "config/system/settings.php", undefined, "config/system/additional.local.php", "config/system/additional.php"],
    ["symfony-parameters", "app/config/parameters.yml", undefined, "app/config/parameters.local.yml", "app/config/config.yml"],
    ["dotenv", ".env", "symfony", ".env.local", undefined],
  ] as const)("%s at %s gets its own override file", (kind, path, framework, overridePath, hookPath) => {
    const proposal = proposeOverride({ path, kind }, framework)!;
    expect(proposal.configPath).toBe(path);
    expect(proposal.overridePath).toBe(overridePath);
    expect(proposal.hook?.path).toBe(hookPath);
    expect(proposal.overrideTemplate).toContain("local_password");
    expect(proposal.gitignoreEntry).toBe(`/${overridePath}`);
  });

  it.each([
    ["dotenv", ".env", "laravel", "laravel"],
    ["dotenv", ".env", undefined, undefined],
    ["laravel-database", "config/database.php", undefined, "laravel"],
    ["magento-env", "app/etc/env.php", undefined, "magento"],
    ["joomla-configuration", "configuration.php", undefined, "joomla"],
    ["smtp-dsn", "lib/mail.php", undefined, undefined],
  ] as const)("%s at %s is kept local in place", (kind, path, framework, expected) => {
    const proposal = proposeOverride({ path, kind }, framework)!;
    expect(proposal).toMatchObject({ configPath: path, overridePath: path, gitignoreEntry: `/${path}` });
    expect(proposal.framework).toBe(expected);
    expect(proposal.hook).toBeUndefined();
    expect(proposal.overrideTemplate).toBeUndefined();
  });

  it("refuses paths outside the project", () => {
    expect(proposeOverride({ path: "../wp-config.php", kind: "wordpress-config" })).toBeUndefined();
  });
});

describe("applyOverrideHook", () => {
  it("makes wp-config.php load the override first and guards its DB defines, once", async () => {
    const original = await fixture("wordpress/wp-config.php");
    const proposal = proposeOverride({ path: "wp-config.php", kind: "wordpress-config" })!;
    const hooked = applyOverrideHook(proposal, original)!;
    const lines = hooked.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "<?php",
      "// Local settings, never uploaded.",
      "if (is_file(__DIR__ . '/wp-config-local.php')) {",
      "    require __DIR__ . '/wp-config-local.php';",
      "}",
    ]);
    expect(lines.filter((line) => line.startsWith("defined("))).toHaveLength(6);
    expect(hooked).toContain("define( 'AUTH_KEY'");
    expect(hooked).not.toContain("defined('AUTH_KEY')");
    // Every original line is still there, values untouched.
    for (const line of original.split("\n")) expect(lines.some((candidate) => candidate.endsWith(line.trim()))).toBe(true);
    expect(applyOverrideHook(proposal, hooked)).toBeUndefined();
  });

  it.skipIf(!hasPhp)("gives PHP the override's values and the live ones without it", async () => {
    const dir = await tempDir();
    const proposal = proposeOverride({ path: "wp-config.php", kind: "wordpress-config" })!;
    const hooked = applyOverrideHook(proposal, await fixture("wordpress/wp-config.php"))!;
    // Stops before wp-settings.php, which the fixture only stubs.
    await writeFile(join(dir, "wp-config.php"), hooked.replace("require_once ABSPATH . 'wp-settings.php';", "echo DB_HOST === 'db.example.invalid' ? 'live' : (DB_HOST === '127.0.0.1' ? 'local' : 'other');"));
    // No "already defined" warning either way.
    const run = () => {
      const result = spawnSync("php", ["-d", "display_errors=stderr", "-d", "error_reporting=E_ALL", join(dir, "wp-config.php")], { encoding: "utf8" });
      return { out: result.stdout, err: result.stderr, status: result.status };
    };
    expect(run()).toEqual({ out: "live", err: "", status: 0 });
    await writeFile(join(dir, proposal.overridePath), proposal.overrideTemplate!);
    expect(run()).toEqual({ out: "local", err: "", status: 0 });
  });

  it.skipIf(!hasPhp)("leaves Drupal and TYPO3 files valid PHP", async () => {
    const dir = await tempDir();
    const drupal = proposeOverride({ path: "sites/default/settings.php", kind: "drupal-settings" })!;
    const typo3 = proposeOverride({ path: "typo3conf/LocalConfiguration.php", kind: "typo3-configuration" })!;
    const files: Array<[string, string]> = [
      ["settings.php", applyOverrideHook(drupal, await fixture("drupal/sites/default/settings.php"))!],
      ["settings.local.php", drupal.overrideTemplate!],
      ["AdditionalConfiguration.php", applyOverrideHook(typo3, undefined)!],
      ["AdditionalConfiguration.local.php", typo3.overrideTemplate!],
    ];
    for (const [name, text] of files) {
      await writeFile(join(dir, name), text);
      expect(spawnSync("php", ["-l", join(dir, name)], { encoding: "utf8" }).status).toBe(0);
    }
  });

  it("appends Drupal's include even when the commented example is there", async () => {
    const original = await fixture("drupal/sites/default/settings.php");
    const proposal = proposeOverride({ path: "sites/default/settings.php", kind: "drupal-settings" })!;
    const hooked = applyOverrideHook(proposal, original)!;
    expect(hooked.startsWith(original)).toBe(true);
    expect(hooked.endsWith("    require __DIR__ . '/settings.local.php';\n}\n")).toBe(true);
    expect(applyOverrideHook(proposal, hooked)).toBeUndefined();
  });

  it("creates TYPO3's additional configuration when it is missing", () => {
    const proposal = proposeOverride({ path: "typo3conf/LocalConfiguration.php", kind: "typo3-configuration" })!;
    const created = applyOverrideHook(proposal, undefined)!;
    expect(created.startsWith("<?php\n")).toBe(true);
    expect(created).toContain("require __DIR__ . '/AdditionalConfiguration.local.php';");
  });

  it("imports Symfony's local parameters right after parameters.yml", async () => {
    const proposal = proposeOverride({ path: "app/config/parameters.yml", kind: "symfony-parameters" })!;
    const hooked = applyOverrideHook(proposal, await fixture("symfony/app/config/config.yml"))!;
    expect(hooked.split("\n").slice(0, 4)).toEqual([
      "imports:",
      "    - { resource: parameters.yml }",
      "    - { resource: parameters.local.yml, ignore_errors: true }",
      "    - { resource: security.yml }",
    ]);
    expect(applyOverrideHook(proposal, hooked)).toBeUndefined();
    expect(applyOverrideHook(proposal, "framework:\n    secret: x\n")).toBeUndefined();
  });

  it("has nothing to apply for an in-place proposal", () => {
    expect(applyOverrideHook(proposeOverride({ path: "app/etc/env.php", kind: "magento-env" })!, "<?php\n")).toBeUndefined();
  });
});

describe("withGitignoreEntry", () => {
  it("adds the entry once", () => {
    expect(withGitignoreEntry("", "/wp-config-local.php")).toBe("/wp-config-local.php\n");
    expect(withGitignoreEntry("node_modules", "/wp-config-local.php")).toBe("node_modules\n/wp-config-local.php\n");
    expect(withGitignoreEntry("/wp-config-local.php\n", "/wp-config-local.php")).toBe("/wp-config-local.php\n");
  });
});
