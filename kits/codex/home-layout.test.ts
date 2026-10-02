import { lstat, realpath, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalCodexHome, prepareCodexHome } from "./home-layout.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "tau-auth-overlay-")); directories.push(dir); return dir; }

it("shares canonical sessions and OAuth locks while synthetic credentials stay private", async () => {
  const root = await scratch();
  const shared = join(root, "shared");
  const a = join(root, "a");
  const b = join(root, "b");
  const envA = await prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: a });
  const envB = await prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: b });
  await writeFile(join(a, "auth.json"), "synthetic account A");
  await writeFile(join(b, "auth.json"), "synthetic account B");
  await writeFile(join(a, "models_cache.json"), "catalog A");
  await writeFile(join(a, "sessions", "rollout.jsonl"), "canonical session");
  await writeFile(join(a, "mcp-oauth-locks", "lock"), "shared lock");
  expect(await readFile(join(b, "sessions", "rollout.jsonl"), "utf8")).toBe("canonical session");
  expect(await readFile(join(b, "mcp-oauth-locks", "lock"), "utf8")).toBe("shared lock");
  expect(await readFile(join(b, "auth.json"), "utf8")).toBe("synthetic account B");
  expect((await lstat(join(a, "models_cache.json"))).isSymbolicLink()).toBe(false);
  expect(envA.CODEX_HOME).toBe(await realpath(a));
  expect(envB.CODEX_HOME).toBe(await realpath(b));
  expect(await canonicalCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: b })).toBe(await realpath(shared));
  await expect(prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: a })).resolves.toEqual(envA);
});

it("refuses linked credentials and existing conflicting data without changing them", async () => {
  const root = await scratch();
  const shared = join(root, "shared");
  const auth = join(root, "auth");
  await mkdir(shared); await mkdir(auth);
  await writeFile(join(shared, "auth.json"), "synthetic secret");
  await symlink(join(shared, "auth.json"), join(auth, "auth.json"));
  await expect(prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: auth })).rejects.toThrow("must be private");
  expect(await readFile(join(shared, "auth.json"), "utf8")).toBe("synthetic secret");
  await rm(join(auth, "auth.json"));
  await mkdir(join(auth, "sessions"));
  await writeFile(join(auth, "sessions", "keep"), "existing history");
  await expect(prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: auth })).rejects.toThrow("conflicting sessions");
  expect(await readFile(join(auth, "sessions", "keep"), "utf8")).toBe("existing history");
});

it("rejects aliases of the same home and nested overlays", async () => {
  const root = await scratch();
  const shared = join(root, "shared"); await mkdir(shared);
  const alias = join(root, "alias"); await symlink(shared, alias);
  await expect(prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: alias })).rejects.toThrow("resolves");
  await expect(prepareCodexHome({ CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: join(shared, "nested") })).rejects.toThrow("resolves");
});
