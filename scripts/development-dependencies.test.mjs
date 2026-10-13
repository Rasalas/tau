import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const lockfile = (folder) => JSON.parse(readFileSync(new URL(`${folder}/package-lock.json`, new URL("../", import.meta.url)), "utf8"));
const packages = (lock, name) => Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);

function atLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  const differing = minimum.findIndex((part, index) => parts[index] !== part);
  return differing === -1 || parts[differing] > minimum[differing];
}

describe("development dependency security", () => {
  it("tags the worker with its test file for global process cleanup", () => {
    expect(decodeURIComponent(process.env.TAU_TEST_FILE)).toBe("scripts/development-dependencies.test.mjs");
    expect(process.env.TAU_TEST_RUN).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("uses the patched test runner and mocker without the old worker pool", () => {
    const lock = lockfile(".");
    for (const name of ["vitest", "@vitest/mocker"]) {
      const entries = packages(lock, name);
      expect(entries.length, name).toBeGreaterThan(0);
      for (const [path, entry] of entries) expect(atLeast(entry.version, [4, 1, 11]), `${path}@${entry.version}`).toBe(true);
    }
    expect(packages(lock, "tinypool")).toEqual([]);
  });

  it.each([".", "mobile", "relay"])("locks patched UUID packages in %s", (folder) => {
    const entries = packages(lockfile(folder), "uuid");
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      const major = Number(entry.version.split(".")[0]);
      const minimum = major === 12 || major === 13 ? [major, 0, 1] : [11, 1, 1];
      expect(atLeast(entry.version, minimum), `${folder}/${path}@${entry.version}`).toBe(true);
    }
  });

  it("keeps the FTP fixture's CommonJS UUID API and rejects partial buffer writes", () => {
    const require = createRequire(new URL("../node_modules/ftp-srv/package.json", import.meta.url));
    const uuid = require("uuid");
    expect(uuid.validate(uuid.v4())).toBe(true);
    for (const name of ["v3", "v5"]) {
      const buffer = new Uint8Array(8).fill(0xaa);
      expect(() => uuid[name]("fixture", uuid[name].DNS, buffer, 4)).toThrow(RangeError);
      expect([...buffer]).toEqual(Array(8).fill(0xaa));
    }
  });
});
