import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentSdkIdentity } from "./account-identity.js";

/** The key every kit must give this fixture organization; Pi Limits pins the same one. */
const FIXTURE_KEY = "afc3cb12c42d1e5bc2bdc82626464d958a551fd461eb8a992861f720f57d0ef5";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function configDir(oauthAccount: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-agent-sdk-identity-"));
  directories.push(directory);
  await writeFile(join(directory, ".claude.json"), JSON.stringify({ numStartups: 3, oauthAccount }));
  return directory;
}

describe("Agent SDK account identity", () => {
  it("is the organization's hash for a personal plan, read from the config directory", async () => {
    const directory = await configDir({ accountUuid: "user-fixture-1", organizationUuid: "org-fixture-1", emailAddress: "fixture@example.invalid" });
    const identity = await readAgentSdkIdentity({ CLAUDE_CONFIG_DIR: directory }, "max");
    expect(identity).toEqual({ provider: "anthropic", key: FIXTURE_KEY });
    expect(JSON.stringify(identity)).not.toMatch(/fixture/u);
    await expect(readAgentSdkIdentity({ HOME: directory }, "pro")).resolves.toEqual(identity);
  });

  it("adds the user on a shared plan or an unknown one, and has none without a login or a directory", async () => {
    const directory = await configDir({ accountUuid: "user-fixture-1", organizationUuid: "org-fixture-1" });
    const team = await readAgentSdkIdentity({ CLAUDE_CONFIG_DIR: directory }, "team");
    expect(team?.key).toMatch(/^[0-9a-f]{64}$/u);
    expect(team?.key).not.toBe(FIXTURE_KEY);
    await expect(readAgentSdkIdentity({ CLAUDE_CONFIG_DIR: directory }, undefined)).resolves.toEqual(team);
    await expect(readAgentSdkIdentity({ CLAUDE_CONFIG_DIR: await configDir(null) }, "max")).resolves.toBeUndefined();
    await expect(readAgentSdkIdentity({}, "max")).resolves.toBeUndefined();
  });
});
