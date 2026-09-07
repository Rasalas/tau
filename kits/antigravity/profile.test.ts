import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_URL_PREFIX, BROWSER_MARKER, agentEnvironment, browserCommand, parseAuthorizationLink, prepareProfile } from "./profile.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const link = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A43125%2F&scope=openid";

describe("Antigravity profile", () => {
  it("prepares a private home that names the auth method and nothing else", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-agy-profile-"));
    directories.push(stateDir);
    const profile = await prepareProfile(stateDir);
    expect(profile.geminiHome).toBe(join(stateDir, "profile"));
    expect(JSON.parse(await readFile(profile.settingsPath, "utf8"))).toEqual({ auth: { type: "oauth-personal" } });
    expect(profile.tokenPath).toBe(join(profile.acpDirectory, "acp_token.json"));
  });

  it("strips every Google credential and knob from the environment and sets Tau's", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-agy-profile-"));
    directories.push(stateDir);
    const profile = await prepareProfile(stateDir);
    const env = agentEnvironment({ PATH: "/bin", GEMINI_API_KEY: "secret", gemini_home: "/elsewhere", BROWSER: "firefox", HOME: "/Users/x" }, profile, "/opt/harness", "helper %s");
    expect(env).toEqual({ PATH: "/bin", HOME: "/Users/x", GEMINI_HOME: profile.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "helper %s", PYTHONUNBUFFERED: "1", ELECTRON_RUN_AS_NODE: "1", ANTIGRAVITY_HARNESS_PATH: "/opt/harness" });
  });

  it("builds a browser command free of colons and semicolons, quoted for the agent's shell", () => {
    const command = browserCommand("/Applications/My App.app/Contents/MacOS/node");
    expect(command.startsWith("'/Applications/My App.app/Contents/MacOS/node' -e '")).toBe(true);
    expect(command.endsWith("' -- %s")).toBe(true);
    expect(command.slice(command.indexOf("-e"))).not.toMatch(/[:;]/u);
    expect(command).toContain(BROWSER_MARKER);
  });

  it("accepts only Google's own sign-in link with a loopback redirect, from either line shape", () => {
    expect(parseAuthorizationLink(`${AUTH_URL_PREFIX}${link}`)).toEqual({ authorizationUrl: link, redirectUri: "http://127.0.0.1:43125/", state: "abc123" });
    expect(parseAuthorizationLink(`${BROWSER_MARKER}${JSON.stringify(link)}`)?.state).toBe("abc123");
    expect(parseAuthorizationLink(`${AUTH_URL_PREFIX}https://evil.example/o/oauth2/v2/auth?response_type=code&state=a&redirect_uri=http%3A%2F%2F127.0.0.1%3A43125%2F`)).toBeUndefined();
    expect(parseAuthorizationLink(`${AUTH_URL_PREFIX}${link.replace("127.0.0.1%3A43125", "10.0.0.1%3A43125")}`)).toBeUndefined();
    expect(parseAuthorizationLink(`${AUTH_URL_PREFIX}${link}&state=second`)).toBeUndefined();
    expect(parseAuthorizationLink('{"jsonrpc":"2.0","id":1,"result":{}}')).toBeUndefined();
  });
});
