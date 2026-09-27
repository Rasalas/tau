import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicIdentity, readPiChatgptIdentity } from "./account-identity.js";

/** The keys Codex and the Agent SDK runtime give the same fixture accounts (their tests pin them too). */
const OPENAI_KEY = "6aebdfd5da11cc4ac9092578eb4af5ffb0b9d3a3dee6976ae83ed5354ce94131";
const ANTHROPIC_KEY = "afc3cb12c42d1e5bc2bdc82626464d958a551fd461eb8a992861f720f57d0ef5";

function fixtureJwt(auth: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": auth })}.fixture`;
}

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Pi account identity", () => {
  it("reads a ChatGPT login from Pi's auth.json the way Codex reads its own", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-pi-identity-"));
    directories.push(agentDir);
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: fixtureJwt({ chatgpt_account_id: "acct-fixture-1", chatgpt_user_id: "user-fixture-1" }), refresh: "fixture-refresh", expires: 1, accountId: "acct-fixture-1" },
      anthropic: { type: "oauth", access: "opaque-fixture", refresh: "fixture-refresh", expires: 1 },
      openrouter: { type: "api_key", key: "fixture-key" },
    }));
    await expect(readPiChatgptIdentity(agentDir, "openai-codex")).resolves.toEqual({ provider: "openai", key: OPENAI_KEY });
    await expect(readPiChatgptIdentity(agentDir, "anthropic")).resolves.toBeUndefined();
    await expect(readPiChatgptIdentity(agentDir, "openrouter")).resolves.toBeUndefined();
    await expect(readPiChatgptIdentity(join(agentDir, "missing"), "openai-codex")).resolves.toBeUndefined();
  });

  it("takes Anthropic's organization from an answer's headers", () => {
    expect(anthropicIdentity({ "Anthropic-Organization-Id": "org-fixture-1" })).toEqual({ provider: "anthropic", key: ANTHROPIC_KEY });
    expect(anthropicIdentity({ "x-codex-primary-used-percent": "3" })).toBeUndefined();
  });
});
