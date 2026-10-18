import { afterEach, expect, it, vi } from "vitest";
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
import { createKeychainKeyProvider } from "./cookie-keys.js";
import { cookieImportEnvironment } from "./cookie-import.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("accounts for the actual mocked keychain subprocess before starting it", async () => {
  vi.stubEnv("VITEST", undefined);
  const events: string[] = [];
  const note = vi.fn(() => events.push("note"));
  execFile.mockImplementation((...args: unknown[]) => {
    events.push("spawn");
    (args.at(-1) as (error: null, stdout: string) => void)(null, "synthetic\n");
  });
  await expect(createKeychainKeyProvider(note).secret({ service: "Fixture Safe Storage", account: "Fixture" })).resolves.toBe("synthetic");
  expect(events).toEqual(["note", "spawn"]);
  expect(execFile).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-w", "-s", "Fixture Safe Storage", "-a", "Fixture"], expect.any(Object), expect.any(Function));
});
it("refuses actual keychain access under test without bookkeeping or spawning", async () => {
  vi.stubEnv("VITEST", "true");
  const note = vi.fn();
  await expect(createKeychainKeyProvider(note).secret({ service: "Fixture", account: "Fixture" })).rejects.toThrow("never read under test");
  expect(note).not.toHaveBeenCalled(); expect(execFile).not.toHaveBeenCalled();
});
it("uses the fixture keychain without accounting for a subprocess", async () => {
  const note = vi.fn();
  const environment = cookieImportEnvironment(() => { throw new Error("no writes"); }, { TAU_IMPORT_ROOTS: "/nonexistent-tau-fixture-keychain" }, "darwin", note);
  await expect(environment.keys.secret({ service: "Fixture", account: "Fixture" })).rejects.toThrow("fixture keychain");
  expect(note).not.toHaveBeenCalled(); expect(execFile).not.toHaveBeenCalled();
});
