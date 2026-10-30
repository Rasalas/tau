import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretFiles } from "./files.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const input = { label: "Deployment key", reason: "Authenticate the deployment CLI", filename: "credential.pem", lifetimeMinutes: 15 };
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "tau-secret-files-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const events: unknown[] = [];
  const files = await SecretFiles.open(join(root, "files"), () => { events.push(files.list()); });
  cleanups.push(() => files.close());
  return { root, files, events };
}

describe("private CLI secret files", () => {
  it("returns a thread-bound reference and private file without publishing the secret", async () => {
    const h = await harness();
    const answer = h.files.request("thread", input);
    const request = h.files.list()[0]!;
    expect(request.status).toBe("pending");
    await h.files.submit(request.id, "sensitive\nvalue\n");
    const binding = (await answer)!;
    expect(binding.secretRef).toBeTypeOf("string");
    expect(await readFile(binding.path, "utf8")).toBe("sensitive\nvalue\n");
    if (process.platform !== "win32") {
      expect((await stat(binding.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(binding.path, ".."))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.stringify([h.events, h.files.list(), binding])).not.toContain("sensitive");
    await expect(h.files.release("another-thread", binding.secretRef)).rejects.toThrow("does not belong");
    expect(await readFile(binding.path, "utf8")).toBe("sensitive\nvalue\n");
    await h.files.release("thread", binding.secretRef);
    await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ends pending requests and active files together when a thread stops", async () => {
    const h = await harness();
    const first = h.files.request("thread", input);
    await h.files.submit(h.files.list()[0]!.id, "private");
    const binding = (await first)!;
    const second = h.files.request("thread", input);
    await h.files.end("thread");
    await expect(second).resolves.toBeUndefined();
    await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.files.list().every((request) => request.status === "ended")).toBe(true);
    await expect(h.files.submit(h.files.list()[1]!.id, "late private value")).rejects.toThrow("ended");
  });

  it("expires waiting requests and deletes ready files at their configured deadline", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const pending = h.files.request("waiting", input);
    await vi.advanceTimersByTimeAsync(600_001);
    await expect(pending).resolves.toBeUndefined();
    const ready = h.files.request("ready", { ...input, lifetimeMinutes: 15 });
    await h.files.submit(h.files.list().find((request) => request.threadId === "ready")!.id, "private");
    const binding = (await ready)!;
    await vi.advanceTimersByTimeAsync(900_001);
    await vi.waitFor(async () => { await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" }); });
  });

  it("recovers unexpired leases after a crash and cleans expired files on restart", async () => {
    const h = await harness();
    const old = join(h.root, "restart-files");
    const files = await SecretFiles.open(old, () => undefined);
    const answer = files.request("old-thread", input);
    await files.submit(files.list()[0]!.id, "private");
    const binding = (await answer)!;
    const reopened = await SecretFiles.open(old, () => undefined);
    cleanups.push(() => reopened.close());
    expect(await readFile(binding.path, "utf8")).toBe("private");
    expect(reopened.list()).toEqual(files.list());
    expect(await readFile(join(binding.path, "..", ".lease.json"), "utf8")).not.toContain('"private"');
    vi.useFakeTimers();
    vi.setSystemTime(binding.expiresAt + 1);
    const expired = await SecretFiles.open(old, () => undefined);
    cleanups.push(() => expired.close());
    await expect(stat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(old)).toEqual([]);
    await files.close();
  });

  it("allows the owner to shorten but never extend a requested lifetime", async () => {
    const h = await harness();
    const answer = h.files.request("thread", { ...input, lifetimeMinutes: 60 });
    const id = h.files.list()[0]!.id;
    await expect(h.files.submit(id, "private", 480)).rejects.toThrow("only be shortened");
    await h.files.submit(id, "private", 15);
    expect((await answer)!.expiresAt - Date.now()).toBeLessThanOrEqual(900_000);
    expect(h.files.list()[0]!.lifetimeMinutes).toBe(15);
  });

  it("does not accept traversing filenames, duplicates, oversized values or expired submissions", async () => {
    const h = await harness();
    await expect(h.files.request("thread", { ...input, filename: "../outside" })).rejects.toThrow("without folders");
    const answer = h.files.request("thread", input);
    await expect(h.files.request("thread", input)).rejects.toThrow("already waiting");
    await expect(h.files.submit(h.files.list()[0]!.id, "🔒".repeat(20_000))).rejects.toThrow("64 KiB");
    expect(await readdir(join(h.root, "files"))).toEqual([]);
    await h.files.decline(h.files.list()[0]!.id);
    await expect(answer).resolves.toBeUndefined();
    await expect(h.files.submit(h.files.list()[0]!.id, "private")).rejects.toThrow("ended");
  });

  it("aborts a pending request without materializing a value", async () => {
    const h = await harness();
    const controller = new AbortController();
    const answer = h.files.request("thread", input, controller.signal);
    controller.abort();
    await expect(answer).resolves.toBeUndefined();
    expect(await readdir(join(h.root, "files"))).toEqual([]);
  });

  it("never overwrites a file outside its generated directory", async () => {
    const h = await harness();
    const outside = join(h.root, "credential.pem");
    await writeFile(outside, "existing");
    const answer = h.files.request("thread", input);
    await h.files.submit(h.files.list()[0]!.id, "private");
    expect((await answer)!.path).not.toBe(outside);
    expect(await readFile(outside, "utf8")).toBe("existing");
  });
});
