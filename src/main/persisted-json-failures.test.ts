import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";
import { TurnsInFlight } from "./turns-in-flight.js";
import { QueuedMessages } from "./queued-messages.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  vi.mocked(readFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-persisted-failures-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json"), logger: { warn: vi.fn() } };
}

describe("persisted JSON failures", () => {
  it.each(["EACCES", "EIO", "ENOTDIR"])("rejects %s instead of treating the file as missing", async (code) => {
    const { path, logger } = await fixture();
    const failed = Object.assign(new Error("read failed"), { code });
    vi.mocked(readFile).mockRejectedValueOnce(failed);
    await expect(readPersistedJson(path, { expectedVersion: 1, decode: (value) => value, logger })).rejects.toBe(failed);
  });

  it("keeps a marker file after EACCES even when the caller catches the read error", async () => {
    const { path, logger } = await fixture();
    const original = JSON.stringify({ version: 1, turns: [], retained: "original" });
    await writeFile(path, original);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(readFile).mockRejectedValueOnce(denied);
    const turns = new TurnsInFlight({ filePath: path, logger });
    await turns.load().catch(() => undefined);
    turns.record({ sessionId: "new", cwd: "/repo", turnId: "turn", backend: "test-runtime", startedAt: 1, prompt: { text: "new" } });
    await turns.flush();
    expect(await readFile(path, "utf8")).toBe(original);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("allows writes again only after a successful read", async () => {
    const { path, logger } = await fixture();
    await writeFile(path, JSON.stringify({ version: 1, items: ["old"] }));
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const options = { expectedVersion: 1, decode: (value: unknown) => value, logger };
    vi.mocked(readFile).mockRejectedValueOnce(denied);
    await expect(readPersistedJson(path, options)).rejects.toBe(denied);
    await expect(writePersistedJson(path, 1, { items: [] }, { logger })).rejects.toBe(denied);
    await readPersistedJson(path, options);
    await writePersistedJson(path, 1, { items: ["new"] }, { logger });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, items: ["new"] });
  });

  it("keeps corrupt data when quarantine fails", async () => {
    const { path, logger } = await fixture();
    await writeFile(path, "{broken");
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(rename).mockRejectedValueOnce(denied);
    await expect(readPersistedJson(path, { expectedVersion: 1, decode: (value) => value, logger })).rejects.toBe(denied);
    await expect(writePersistedJson(path, 1, { items: [] }, { logger })).rejects.toBe(denied);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("saves on Windows after a scanner briefly holds the target", async () => {
    const { directory, path, logger } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" })).mockImplementation(actual.rename);
    await writePersistedJson(path, 1, { items: ["kept"] }, { logger });
    platform.mockRestore();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, items: ["kept"] });
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["open", "writeFile", "sync", "close", "rename", "directorySync"] as const)("cleans up and reports a %s failure", async (stage) => {
    const { directory, path, logger } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const original = JSON.stringify({ version: 1, items: ["old"] });
    await writeFile(path, original);
    const failed = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    if (stage === "rename") vi.mocked(rename).mockRejectedValueOnce(failed);
    else if (stage === "directorySync") {
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[0] === directory) vi.spyOn(handle, "sync").mockRejectedValueOnce(failed);
        return handle;
      });
    } else {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        if (stage === "open") { await handle.close(); throw failed; }
        if (stage === "close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw failed; });
        } else vi.spyOn(handle, stage).mockRejectedValueOnce(failed);
        return handle;
      });
    }
    await expect(writePersistedJson(path, 1, { items: ["new"] }, { logger })).rejects.toBe(failed);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(`failed to persist ${path}`, failed);
    if (stage !== "directorySync") expect(await readFile(path, "utf8")).toBe(original);
  });

  it("syncs and closes the file before rename, then syncs and closes the directory", async () => {
    const { directory, path, logger } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const events: string[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const kind = args[0] === directory ? "directory" : "file";
      for (const method of ["sync", "close"] as const) {
        const call = handle[method].bind(handle);
        vi.spyOn(handle, method).mockImplementation(async () => { events.push(`${kind}.${method}`); await call(); });
      }
      return handle;
    });
    vi.mocked(rename).mockImplementation(async (...args) => { events.push("rename"); await actual.rename(...args); });
    await writePersistedJson(path, 1, { items: [] }, { logger });
    expect(events).toEqual(["file.sync", "file.close", "rename", "directory.sync", "directory.close"]);
  });

  it("warns once per path during repeated failures and retries subsequent writes", async () => {
    const { path, logger } = await fixture();
    const failed = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(open).mockRejectedValueOnce(failed).mockRejectedValueOnce(failed);
    const first = writePersistedJson(path, 1, { items: ["a"] }, { logger });
    const second = writePersistedJson(path, 1, { items: ["b"] }, { logger });
    expect((await Promise.allSettled([first, second])).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await writePersistedJson(path, 1, { items: ["c"] }, { logger });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, items: ["c"] });
    vi.mocked(open).mockRejectedValueOnce(failed);
    await expect(writePersistedJson(path, 1, { items: [] }, { logger })).rejects.toBe(failed);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("reports repeated marker write failures even when the store catches them", async () => {
    const { path, logger } = await fixture();
    const failed = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(open).mockRejectedValueOnce(failed).mockRejectedValueOnce(failed);
    const turns = new TurnsInFlight({ filePath: path, logger });
    const marker = { sessionId: "new", cwd: "/repo", turnId: "turn", backend: "test-runtime", startedAt: 1, prompt: { text: "new" } };
    turns.record(marker);
    turns.record(marker);
    await turns.flush();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(`failed to persist ${path}`, failed);
  });

  it.each(["EINVAL", "ENOTSUP"])("closes the directory when its filesystem cannot sync it with %s", async (code) => {
    const { directory, path, logger } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const closed = vi.fn();
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === directory) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code }));
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); closed(); });
      }
      return handle;
    });
    await writePersistedJson(path, 1, { items: [] }, { logger });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("protects a newer version even when its shape cannot be decoded", async () => {
    const { path, logger } = await fixture();
    const original = JSON.stringify({ version: 99, future: "data" });
    await writeFile(path, original);
    await readPersistedJson(path, { expectedVersion: 1, decode: () => undefined, logger });
    await expect(writePersistedJson(path, 1, { items: [] }, { logger })).rejects.toThrow("version 99");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("protects newer queue data during restore and mutations", async () => {
    const { path, logger } = await fixture();
    const original = JSON.stringify({ version: 99, threads: {}, future: "data" });
    await writeFile(path, original);
    const queue = new QueuedMessages({ busy: () => true, waitForIdle: async () => undefined, deliver: async () => undefined, publish: () => undefined, log: () => undefined }, { filePath: path, logger });
    await queue.restore();
    queue.add("new", { text: "new", attachments: [] });
    await queue.flush();
    expect(await readFile(path, "utf8")).toBe(original);
    expect(logger.warn.mock.calls.filter(([message]) => message.startsWith("failed to persist"))).toHaveLength(1);
  });
});
