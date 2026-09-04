import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersistedJson, writePersistedJson } from "./persisted-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempFile(name = "state.json") {
  const directory = await mkdtemp(join(tmpdir(), "tau-persisted-json-"));
  temporaryDirectories.push(directory);
  const nested = join(directory, "nested");
  await mkdir(nested);
  return join(nested, name);
}

interface Stored {
  items: string[];
}

function decode(value: unknown): Stored | undefined {
  if (Array.isArray(value)) return { items: value.filter((item): item is string => typeof item === "string") };
  if (!value || typeof value !== "object") return undefined;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? { items: items.filter((item): item is string => typeof item === "string") } : undefined;
}

describe("persisted-json", () => {
  it("writes atomically: no temp file survives, mode is locked down, and the target parses back", async () => {
    const path = await tempFile();
    await writePersistedJson(path, 1, { items: ["a"] });

    const dir = join(path, "..");
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("state.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, items: ["a"] });
  });

  it("returns undefined for a missing file without logging", async () => {
    const path = await tempFile();
    const logger = { warn: vi.fn() };
    const result = await readPersistedJson(path, { expectedVersion: 1, decode, logger });
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("decodes a legacy bare-array shape", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify(["a", "b"]), "utf8");
    const result = await readPersistedJson(path, { expectedVersion: 1, decode });
    expect(result).toEqual({ data: { items: ["a", "b"] }, version: undefined, readOnly: false });
  });

  it("decodes a legacy unversioned object shape", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify({ items: ["a"] }), "utf8");
    const result = await readPersistedJson(path, { expectedVersion: 1, decode });
    expect(result).toEqual({ data: { items: ["a"] }, version: undefined, readOnly: false });
  });

  it("flags a newer version as read-only and still decodes it best-effort", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify({ version: 99, items: ["a"] }), "utf8");
    const logger = { warn: vi.fn() };
    const result = await readPersistedJson(path, { expectedVersion: 1, decode, logger });
    expect(result).toEqual({ data: { items: ["a"] }, version: 99, readOnly: true });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("quarantines an unparsable file and returns undefined", async () => {
    const path = await tempFile();
    await writeFile(path, "{not valid json", "utf8");
    const logger = { warn: vi.fn() };
    const result = await readPersistedJson(path, { expectedVersion: 1, decode, logger });
    expect(result).toBeUndefined();

    const dir = join(path, "..");
    const entries = await readdir(dir);
    expect(entries).not.toContain("state.json");
    const corrupt = entries.find((name) => name.startsWith("state.json.corrupt-"));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(dir, corrupt!), "utf8")).toBe("{not valid json");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("serializes concurrent writes to the same path so the last value wins", async () => {
    const path = await tempFile();
    await Promise.all([
      writePersistedJson(path, 1, { items: ["1"] }),
      writePersistedJson(path, 1, { items: ["2"] }),
      writePersistedJson(path, 1, { items: ["3"] }),
    ]);
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toEqual({ version: 1, items: ["3"] });
    const entries = await readdir(join(path, ".."));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
