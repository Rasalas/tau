import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFramework, frameworkConfigKind, guardUploadSelection, isUploadBlocked, normalizeProjectPath, type UploadCandidate } from "./live-config.js";
import { applyOverrideHook, proposeOverride } from "./override.js";
import { listProjectFiles, scanFiles } from "./secrets-scan.js";

const PROJECTS = join(import.meta.dirname, "fixtures", "projects");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function copyProject(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `tau-live-config-${name}-`)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await cp(join(PROJECTS, name), dir, { recursive: true });
  return dir;
}

describe("normalizeProjectPath and the block list", () => {
  it("keeps paths inside the project only", () => {
    expect(normalizeProjectPath("./a//b\\c.php")).toBe("a/b/c.php");
    expect(normalizeProjectPath("dir/")).toBe("dir");
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "C:/x", "a/./b"]) expect(normalizeProjectPath(bad)).toBeUndefined();
  });

  it("matches blocked paths exactly after normalizing", () => {
    expect(isUploadBlocked("./wp-config-local.php", ["wp-config-local.php"])).toBe(true);
    expect(isUploadBlocked("sub/wp-config-local.php", ["wp-config-local.php"])).toBe(false);
  });
});

describe("frameworkConfigKind", () => {
  it.each([
    ["wp-config.php", "wordpress-config"],
    ["public/wp-config.php", "wordpress-config"],
    ["config/database.php", "laravel-database"],
    ["app/config/parameters.yml", "symfony-parameters"],
    ["web/sites/default/settings.php", "drupal-settings"],
    ["configuration.php", "joomla-configuration"],
    ["app/etc/env.php", "magento-env"],
    ["typo3conf/LocalConfiguration.php", "typo3-configuration"],
    ["config/system/settings.php", "typo3-configuration"],
    [".env", "dotenv"],
    [".env.local", "dotenv"],
  ])("names %s a %s", (path, kind) => {
    expect(frameworkConfigKind(path)?.kind).toBe(kind);
  });

  it.each(["wp-config-sample.php", ".env.example", ".env.dist", "settings.php", "src/database.php", "index.php"])("leaves %s alone", (path) => {
    expect(frameworkConfigKind(path)).toBeUndefined();
  });
});

describe("detectFramework", () => {
  it.each([
    ["wordpress", "wordpress"], ["laravel", "laravel"], ["drupal", "drupal"], ["magento", "magento"],
    ["typo3", "typo3"], ["joomla", "joomla"], ["symfony", "symfony"], ["plain", undefined],
  ])("tells %s apart", async (project, framework) => {
    expect(detectFramework(await listProjectFiles(join(PROJECTS, project)))).toBe(framework);
  });
});

describe("guardUploadSelection", () => {
  const findings = [
    { path: "wp-config.php", kind: "wordpress-config" as const, line: 7, framework: "wordpress" as const },
    { path: "lib/mail.php", kind: "smtp-dsn" as const, line: 3 },
    { path: "lib/mail.php", kind: "mysql-dsn" as const, line: 9 },
  ];

  it("starts credential files unchecked and marked, withholds blocked paths, keeps order", () => {
    const candidates: UploadCandidate[] = [
      { path: "index.php", op: "modify" },
      { path: "wp-config.php", op: "modify" },
      { path: "wp-config-local.php", op: "add" },
      { path: "lib/mail.php", op: "add" },
      { path: "old.php", op: "delete" },
    ];
    const result = guardUploadSelection(candidates, { findings, blocklist: ["wp-config-local.php"] });
    expect(result.withheld).toEqual(["wp-config-local.php"]);
    expect(result.rows).toEqual([
      { candidate: candidates[0], selected: true },
      { candidate: candidates[1], selected: false, guard: { reason: "credentials", kinds: ["wordpress-config"] } },
      { candidate: candidates[3], selected: false, guard: { reason: "credentials", kinds: ["mysql-dsn", "smtp-dsn"] } },
      { candidate: candidates[4], selected: true },
    ]);
  });

  it("guards deleting a framework config even with no finding for it", () => {
    const { rows } = guardUploadSelection([{ path: "app/etc/env.php", op: "delete" }, { path: "app/etc/config.php", op: "delete" }], { findings: [], blocklist: [] });
    expect(rows.map((row) => [row.candidate.path, row.selected, row.guard?.kinds])).toEqual([
      ["app/etc/env.php", false, []],
      ["app/etc/config.php", true, undefined],
    ]);
  });

  it("keeps the caller's own row fields", () => {
    const { rows } = guardUploadSelection([{ path: "a.php", op: "add" as const, size: 3 }], { findings: [], blocklist: [] });
    expect(rows[0]!.candidate.size).toBe(3);
  });
});

describe("the WordPress deployment case", () => {
  it("deselects a changed DB_HOST, and the override file never shows as pending", async () => {
    const root = await copyProject("wordpress");
    const config = join(root, "wp-config.php");
    await writeFile(config, (await readFile(config, "utf8")).replace("db.example.invalid", "db2.example.invalid"));
    await writeFile(join(root, "index.php"), "<?php\n// changed\n");

    // What I10 will do: scan the pending files, then default the selection.
    const pending: UploadCandidate[] = [{ path: "index.php", op: "modify" }, { path: "wp-config.php", op: "modify" }];
    const first = guardUploadSelection(pending, { findings: await scanFiles(root, pending.map((row) => row.path)), blocklist: [] });
    expect(first.rows.map((row) => [row.candidate.path, row.selected, row.guard?.reason])).toEqual([
      ["index.php", true, undefined],
      ["wp-config.php", false, "credentials"],
    ]);

    // The assistant's override: the hook goes into wp-config.php, the override file onto the block list.
    const proposal = proposeOverride({ path: "wp-config.php", kind: "wordpress-config" }, "wordpress")!;
    await writeFile(config, applyOverrideHook(proposal, await readFile(config, "utf8"))!);
    await writeFile(join(root, proposal.overridePath), proposal.overrideTemplate!);
    const after: UploadCandidate[] = [...pending, { path: proposal.overridePath, op: "add" }];
    const second = guardUploadSelection(after, { findings: await scanFiles(root, after.map((row) => row.path)), blocklist: [proposal.overridePath] });
    expect(second.withheld).toEqual(["wp-config-local.php"]);
    expect(second.rows.map((row) => row.candidate.path)).toEqual(["index.php", "wp-config.php"]);
    expect(second.rows[1]!.selected).toBe(false);
  });
});
