import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentCatalog, SecretStorageUnavailableError, type SavedEnvironment, type SecretBox } from "./environment-catalog.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-environments-"));
  directories.push(directory);
  return join(directory, "environments.json");
}

/** Reversible and visibly not the plain text, like safeStorage. */
const box = (available = true): SecretBox => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`sealed:${text}`).toString("base64"),
  decrypt: (data) => {
    const text = Buffer.from(data, "base64").toString();
    if (!text.startsWith("sealed:")) throw new Error("not ours");
    return text.slice("sealed:".length);
  },
});

const studio: SavedEnvironment = {
  id: "host-studio",
  name: "studio",
  endpoints: [{ url: "https://192.168.1.4:7788/", kind: "lan" }],
  fingerprint: "AB:CD",
  token: "tau_client_secret",
  addedAt: "2026-09-24T10:00:00.000Z",
};

describe("the catalog of saved machines", () => {
  it("keeps each token encrypted in a file only its user may read", async () => {
    const file = path();
    const catalog = await EnvironmentCatalog.open(file, box());
    await catalog.save(studio);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("tau_client_secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = await EnvironmentCatalog.open(file, box());
    expect(again.get("host-studio")).toEqual(studio);
  });

  it("saves nothing where nothing can be encrypted", async () => {
    const catalog = await EnvironmentCatalog.open(path(), box(false));
    await expect(catalog.save(studio)).rejects.toBeInstanceOf(SecretStorageUnavailableError);
    expect(catalog.list()).toEqual([]);
  });

  it("forgets a machine whose token no longer decrypts, and keeps the others", async () => {
    const file = path();
    const catalog = await EnvironmentCatalog.open(file, box());
    await catalog.save(studio);
    await catalog.save({ ...studio, id: "host-laptop", name: "laptop" });
    const stored = JSON.parse(readFileSync(file, "utf8")) as { environments: Array<{ id: string; token: string }> };
    stored.environments[0]!.token = Buffer.from("someone else's").toString("base64");
    writeFileSync(file, JSON.stringify(stored));
    const again = await EnvironmentCatalog.open(file, box());
    expect(again.list().map((entry) => entry.id)).toEqual(["host-laptop"]);
  });

  it("renames, remembers the last address, replaces a machine paired again, and removes", async () => {
    const catalog = await EnvironmentCatalog.open(path(), box());
    await catalog.save(studio);
    await catalog.update("host-studio", { name: "  Studio  ", lastUrl: "https://192.168.1.4:7788/" });
    expect(catalog.get("host-studio")).toMatchObject({ name: "Studio", lastUrl: "https://192.168.1.4:7788/" });
    await catalog.save({ ...studio, token: "tau_client_new" });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get("host-studio")!.token).toBe("tau_client_new");
    expect(await catalog.remove("host-studio")).toBe(true);
    expect(await catalog.remove("host-studio")).toBe(false);
    expect(catalog.list()).toEqual([]);
  });
});
