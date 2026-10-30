import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SecretFiles } from "./files.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) };
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.mocked(fs.rm).mockRestore(); vi.mocked(fs.writeFile).mockRestore(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const input = { label: "Key", reason: "CLI authentication", filename: "key.txt", lifetimeMinutes: 60 };
async function harness() {
  const root = await fs.mkdtemp(join(tmpdir(), "tau-secret-cleanup-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const files = await SecretFiles.open(join(root, "files"), () => undefined);
  cleanups.push(() => files.close());
  return { files, root };
}

it("keeps an interrupted write reachable when both Stop and rollback cannot delete it", async () => {
  const h = await harness();
  const answer = h.files.request("thread", input);
  const id = h.files.list()[0]!.id;
  const actualWrite = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
  const actualRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
  let path = "";
  let unblock!: () => void;
  let written!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const didWrite = new Promise<void>((resolve) => { written = resolve; });
  vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
    await actualWrite(...args);
    if (args[1] === "private-test-value") { path = String(args[0]); written(); await blocked; }
  });
  let refuse = true;
  vi.mocked(fs.rm).mockImplementation(async (target, options) => {
    if (refuse && String(target).includes("secret-")) throw Object.assign(new Error("Deletion refused"), { code: "EACCES" });
    await actualRm(target, options);
  });
  const saving = h.files.submit(id, "private-test-value");
  const failedSave = expect(saving).rejects.toThrow();
  await didWrite;
  const stopping = h.files.end("thread").catch(() => undefined);
  unblock(); await failedSave; await stopping; await answer;
  expect(h.files.list().find((request) => request.id === id)?.cleanupFailed).toBe(true);
  refuse = false;
  await h.files.revoke(id);
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not evict a failed deletion when answered-request history reaches its limit", async () => {
  const h = await harness();
  const answer = h.files.request("thread", input);
  const id = h.files.list()[0]!.id;
  await h.files.submit(id, "private-test-value");
  const binding = (await answer)!;
  const actualRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
  let refuse = true;
  vi.mocked(fs.rm).mockImplementation(async (target, options) => {
    if (refuse && String(target) === join(binding.path, "..")) throw Object.assign(new Error("Deletion refused"), { code: "EACCES" });
    await actualRm(target, options);
  });
  await expect(h.files.revoke(id)).rejects.toMatchObject({ code: "EACCES" });
  for (let at = 0; at < 105; at++) {
    const waiting = h.files.request(`other-${at}`, input);
    await h.files.decline(h.files.list().at(-1)!.id);
    await waiting;
  }
  expect(h.files.list().some((request) => request.id === id && request.cleanupFailed)).toBe(true);
  refuse = false;
  await h.files.revoke(id);
  await expect(fs.stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
});
