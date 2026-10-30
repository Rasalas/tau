import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ProjectHistory } from "./project-history.js";
import { refreshProjectRegistration } from "./project-registration.js";
import { WorkspaceIdentity } from "./workspace-identity.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-project-registration-"))); roots.push(root);
  const path = join(root, "private"); await mkdir(path);
  const file = join(root, "projects.json");
  const identity = new WorkspaceIdentity("a".repeat(32));
  const history = new ProjectHistory(file, async () => undefined, { warn: vi.fn() }, (projectPath) => identity.ref(projectPath));
  let promoted = false;
  const onName = vi.fn();
  const facts = new ProjectFactsCache({ onLabel: vi.fn(), onName, onNesting: vi.fn(), recordBackground: vi.fn(), log: vi.fn(), errorMessage: String });
  facts.add({ name: async () => promoted ? "Research" : "No project", nested: async () => !promoted, projectless: async () => !promoted });
  await facts.loadName(path); await facts.projectless(path); await facts.nested(path); await facts.owner(path);
  return { root, path, file, facts, history, identity, onName, promote: () => { promoted = true; } };
}

it("refreshes stale private-workspace facts and persists a root even without any sessions", async () => {
  const f = await fixture();
  const id = f.identity.ref(f.path).workspaceId;
  f.promote();
  await refreshProjectRegistration(f.path, f.facts, f.history);
  expect(f.facts.knownProjectless(f.path)).toBe(false);
  expect(f.facts.isRoot(f.path)).toBe(true);
  expect(f.facts.name(f.path)).toBe("Research");
  expect(f.onName).toHaveBeenCalledWith(f.path, "Research");
  const restarted = new ProjectHistory(f.file, async () => undefined, { warn: vi.fn() }, (path) => f.identity.ref(path));
  await restarted.load();
  expect(restarted.list()).toEqual([expect.objectContaining({ name: "Research", path: f.path, workspaceId: id })]);
  expect(f.identity.ref(f.path).workspaceId).toBe(id);
});

it("restores the previous registration if persistence fails", async () => {
  const f = await fixture();
  f.promote();
  const flush = vi.spyOn(f.history, "flush").mockRejectedValueOnce(new Error("disk full"));
  await expect(refreshProjectRegistration(f.path, f.facts, f.history)).rejects.toThrow("disk full");
  expect(f.history.list()).toEqual([]);
  expect(flush).toHaveBeenCalledTimes(2);
});

it("keeps an explicitly hidden project hidden when restoring persisted registrations", async () => {
  const f = await fixture();
  f.promote();
  await f.history.remove(f.path);
  await refreshProjectRegistration(f.path, f.facts, f.history);
  expect(f.history.isHidden(f.path)).toBe(true);
  expect(f.history.list()).toEqual([]);
  expect(f.facts.knownProjectless(f.path)).toBe(false);
});

it("restores an evicted project when a full history cannot persist a promotion", async () => {
  const f = await fixture();
  for (let index = 0; index < 24; index++) await f.history.remember(join(f.root, `project-${index}`), `Project ${index}`);
  await f.history.flush(); const previous = f.history.list();
  f.promote(); vi.spyOn(f.history, "flush").mockRejectedValueOnce(new Error("disk full"));
  await expect(refreshProjectRegistration(f.path, f.facts, f.history)).rejects.toThrow("disk full");
  expect(f.history.list()).toEqual(previous);
  const restored = new ProjectHistory(f.file, async () => undefined, { warn: vi.fn() }, (projectPath) => f.identity.ref(projectPath));
  await restored.load(); expect(restored.list()).toEqual(previous);
});
