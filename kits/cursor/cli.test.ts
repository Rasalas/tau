import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_VERSION_POLICY, comparableVersion, cursorCompatibility, cursorLatestVersion, cursorUpdateCommand, parseCursorAbout, parseCursorVersion } from "./cli.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Cursor CLI facts", () => {
  it("reads date versions and judges them against the ACP minimum", () => {
    expect(parseCursorVersion("2026.09.18-9a7762b\n")).toBe("2026.09.18-9a7762b");
    expect(comparableVersion("2026.04.08-abc")).toBe("2026.4.8");
    expect(cursorCompatibility(CURSOR_VERSION_POLICY, "2025.09.18-7ae6800")).toMatchObject({ status: "broken" });
    expect(cursorCompatibility(CURSOR_VERSION_POLICY, "2026.04.08-1234567")).toBeUndefined();
    expect(cursorCompatibility(CURSOR_VERSION_POLICY, undefined)).toBeUndefined();
  });

  it("reads who `about` is signed in as, and says nothing when it cannot tell", () => {
    expect(parseCursorAbout('{"cliVersion":"x","userEmail":"me@example.com","subscriptionTier":"team_plan"}')).toEqual({ signedIn: true, account: "me@example.com", plan: "Team Plan" });
    expect(parseCursorAbout('{"userEmail":null}')).toEqual({ signedIn: false });
    expect(parseCursorAbout('{"userEmail":"Not logged in"}')).toEqual({ signedIn: false });
    expect(parseCursorAbout("About Cursor CLI")).toEqual({});
  });

  it("reads the newest release from the install script once a day and keeps it when the network fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-cursor-latest-"));
    directories.push(directory);
    const cacheFile = join(directory, "latest.json");
    let clock = 0;
    const fetch = vi.fn(async () => ({ ok: true, text: async () => 'X="https://downloads.cursor.com/lab/2026.10.02-abc1234/${OS}/x"' }) as unknown as Response);
    await expect(cursorLatestVersion({ cacheFile, fetch: fetch as never, now: () => clock })).resolves.toBe("2026.10.02-abc1234");
    await expect(cursorLatestVersion({ cacheFile, fetch: fetch as never, now: () => clock })).resolves.toBe("2026.10.02-abc1234");
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = 2 * 24 * 60 * 60 * 1000;
    const failing = vi.fn(async () => { throw new Error("offline"); });
    await expect(cursorLatestVersion({ cacheFile, fetch: failing as never, now: () => clock })).resolves.toBe("2026.10.02-abc1234");
  });

  it("quotes a path with spaces in the update command", () => {
    expect(cursorUpdateCommand("/usr/local/bin/cursor-agent")).toBe("/usr/local/bin/cursor-agent update");
    expect(cursorUpdateCommand("/Users/me/My Tools/cursor-agent")).toBe('"/Users/me/My Tools/cursor-agent" update');
  });
});
