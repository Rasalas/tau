import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles, scanFiles, scanText, scanTree } from "./secrets-scan.js";

// Fixture values are fake and shaped so no push-protection scanner takes them
// for real ones; AWS and private-key shapes are only ever built here at runtime.
const PROJECTS = join(import.meta.dirname, "fixtures", "projects");
const FAKE_VALUES = ["fake-password-not-real", "db.example.invalid", "fake_user", "fake_database", "TESTONLY", "VEVTVE9OTFk", "fake-secret-not-real", "fake-encryption-key"];
const AWS_KEY = ["AK", "IA", "TESTONLYEXAMPLE0"].join("");
const PRIVATE_KEY = ["-----BEGIN ", "OPENSSH PRIVATE", " KEY-----"].join("");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-secrets-scan-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function expectNoValues(result: unknown, values: readonly string[] = FAKE_VALUES): void {
  const text = JSON.stringify(result);
  for (const value of values) expect(text).not.toContain(value);
}

describe("scanTree on the fixture projects", () => {
  it.each([
    ["wordpress", [{ path: "wp-config.php", kind: "wordpress-config", line: 7, framework: "wordpress" }]],
    ["laravel", [
      { path: ".env", kind: "dotenv", line: 3 },
      { path: ".env", kind: "redis-dsn", line: 13 },
      { path: ".env", kind: "smtp-dsn", line: 14 },
      { path: ".env", kind: "stripe-live-key", line: 16 },
    ]],
    ["drupal", [{ path: "sites/default/settings.php", kind: "drupal-settings", line: 6, framework: "drupal" }]],
    ["magento", [{ path: "app/etc/env.php", kind: "magento-env", line: 14, framework: "magento" }]],
    ["typo3", [{ path: "typo3conf/LocalConfiguration.php", kind: "typo3-configuration", line: 10, framework: "typo3" }]],
    ["joomla", [{ path: "configuration.php", kind: "joomla-configuration", line: 7, framework: "joomla" }]],
    ["symfony", [
      { path: ".env", kind: "dotenv", line: 3 },
      { path: ".env", kind: "postgres-dsn", line: 3 },
      { path: "app/config/parameters.yml", kind: "symfony-parameters", line: 3, framework: "symfony" },
    ]],
    ["plain", []],
  ])("finds the live config of %s by path, kind and line only", async (project, expected) => {
    const findings = await scanTree(join(PROJECTS, project));
    expect(findings).toEqual(expected);
    expectNoValues(findings);
  });

  it("leaves env templates and env()-only framework config alone", async () => {
    const findings = await scanFiles(join(PROJECTS, "laravel"), [".env.example", "config/database.php", "artisan"]);
    expect(findings).toEqual([]);
  });
});

describe("scanText", () => {
  it("finds key shapes in any file without returning them", () => {
    const text = [
      "const config = {",
      `  accessKeyId: "${AWS_KEY}",`,
      "};",
      PRIVATE_KEY,
      "not-a-key-body",
      ["-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"].join(""),
    ].join("\n");
    const findings = scanText("src/deploy.js", text);
    expect(findings).toEqual([
      { path: "src/deploy.js", kind: "aws-access-key", line: 2 },
      { path: "src/deploy.js", kind: "private-key", line: 4 },
      { path: "src/deploy.js", kind: "private-key", line: 6 },
    ]);
    expectNoValues(findings, [AWS_KEY, "not-a-key-body"]);
  });

  it("reports connection URLs only when they carry a password", () => {
    const findings = scanText("config.txt", [
      "mysql://127.0.0.1/app",
      "postgres://fake_user@db.example.invalid/app",
      "mariadb://fake_user:fake-password-not-real@db.example.invalid/app",
      "redis://:${REDIS_PASSWORD}@cache.example.invalid",
      "smtps://fake_user:%env(MAIL_PASSWORD)%@mail.example.invalid",
      "pgsql://fake_user:fake-password-not-real@db.example.invalid/app",
    ].join("\n"));
    expect(findings).toEqual([
      { path: "config.txt", kind: "mysql-dsn", line: 3 },
      { path: "config.txt", kind: "postgres-dsn", line: 6 },
    ]);
  });

  it("skips placeholders and non-literal values in framework config", () => {
    expect(scanText("wp-config.php", "<?php\ndefine('DB_PASSWORD', getenv('DB_PASSWORD'));\ndefine('DB_HOST', DB_HOST_FROM_ENV);\n")).toEqual([]);
    expect(scanText("app/config/parameters.yml", "parameters:\n    database_host: ~\n    database_password: null\n    database_user: '%env(DB_USER)%'\n")).toEqual([]);
    expect(scanText(".env.local", "DB_PASSWORD=\nAPI_TOKEN=${API_TOKEN}\nSECRET=\"<secret>\"\nAPP_NAME=Fixture\n")).toEqual([]);
    expect(scanText("config/database.php", "<?php\nreturn ['password' => env('DB_PASSWORD', '')];\n")).toEqual([]);
  });

  it("flags literal credentials in Laravel's database config and any .env variant but the templates", () => {
    expect(scanText("config/database.php", "<?php\nreturn [\n  'password' => 'fake-password-not-real',\n];\n"))
      .toEqual([{ path: "config/database.php", kind: "laravel-database", line: 3, framework: "laravel" }]);
    expect(scanText(".env.production", "# fake\nexport DB_HOST=db.example.invalid\n")).toEqual([{ path: ".env.production", kind: "dotenv", line: 2 }]);
    expect(scanText(".env.example", "DB_HOST=db.example.invalid\n")).toEqual([]);
    expect(scanText("wp-config-sample.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\n")).toEqual([]);
  });

  it("reports the config once, at its first credential line, with Windows line endings too", () => {
    const text = "<?php\r\ndefine('DB_NAME', 'fake_database');\r\ndefine('DB_HOST', 'db.example.invalid');\r\n";
    expect(scanText("public\\wp-config.php", text)).toEqual([{ path: "public/wp-config.php", kind: "wordpress-config", line: 2, framework: "wordpress" }]);
  });
});

describe("scanFiles", () => {
  it("skips binary, oversized, missing, symlinked and outside paths", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const line = `DB_HOST=db.example.invalid\n`;
    await writeFile(join(root, ".env"), line);
    await writeFile(join(root, "binary.env"), Buffer.concat([Buffer.from(`url=mysql://u:fake-password-not-real@db.example.invalid/x\n`), Buffer.from([0, 1, 2])]));
    await writeFile(join(root, "big.txt"), `${"x".repeat(2048)}\n${PRIVATE_KEY}\n`);
    await writeFile(join(outside, ".env"), line);
    await mkdir(join(root, "linked"));
    await symlink(join(outside, ".env"), join(root, "linked", ".env"));

    const findings = await scanFiles(root, [".env", "binary.env", "big.txt", "missing.env", "linked/.env", "../outside/.env", "/etc/hosts"], { maxBytes: 1024 });
    expect(findings).toEqual([{ path: ".env", kind: "dotenv", line: 1 }]);
  });
});

describe("listProjectFiles", () => {
  it("lists regular files sorted, leaving out .git, node_modules and vendor", async () => {
    const root = await tempDir();
    for (const dir of [".git", "node_modules/pkg", "vendor/pkg", "src/deep"]) await mkdir(join(root, dir), { recursive: true });
    for (const file of [".git/config", "node_modules/pkg/.env", "vendor/pkg/.env", "src/deep/b.php", "src/a.php", ".env"]) await writeFile(join(root, file), "");
    expect(await listProjectFiles(root)).toEqual([".env", "src/a.php", "src/deep/b.php"]);
    expect(await listProjectFiles(root, { maxFiles: 2 })).toEqual([".env", "src/a.php"]);
  });
});
