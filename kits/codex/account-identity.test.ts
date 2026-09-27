import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatgptIdentity, readCodexIdentity } from "./account-identity.js";

/** The key every kit must give this fixture account; Pi Limits pins the same one. */
const FIXTURE_KEY = "6aebdfd5da11cc4ac9092578eb4af5ffb0b9d3a3dee6976ae83ed5354ce94131";

/** A made-up token in the shape the ChatGPT login issues; its signature is not one. */
function fixtureJwt(auth: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": auth })}.fixture`;
}

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Codex account identity", () => {
  it("hashes the ChatGPT account and user a login's token names, and never returns them", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-codex-identity-"));
    directories.push(home);
    const access = fixtureJwt({ chatgpt_account_id: "acct-fixture-1", chatgpt_user_id: "user-fixture-1" });
    await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: access, id_token: "not-a-jwt", refresh_token: "fixture-refresh", account_id: "acct-fixture-1" } }));
    const identity = await readCodexIdentity(home);
    expect(identity).toEqual({ provider: "openai", key: FIXTURE_KEY });
    expect(JSON.stringify(identity)).not.toMatch(/fixture-1|fixture-refresh/u);
  });

  it("falls back to the stored account id, and has none for an API key, a keyring login or a broken file", async () => {
    expect(chatgptIdentity({ accessToken: "opaque", accountId: "acct-fixture-1" })?.key).toMatch(/^[0-9a-f]{64}$/u);
    expect(chatgptIdentity({ accessToken: "opaque" })).toBeUndefined();
    const home = await mkdtemp(join(tmpdir(), "tau-codex-identity-"));
    directories.push(home);
    await expect(readCodexIdentity(home)).resolves.toBeUndefined();
    await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-fixture", tokens: null }));
    await expect(readCodexIdentity(home)).resolves.toBeUndefined();
    await writeFile(join(home, "auth.json"), "{");
    await expect(readCodexIdentity(home)).resolves.toBeUndefined();
  });
});
