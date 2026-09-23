import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import createAntigravityHostExtension from "./host.js";
import { agentEnvironment, profileTokenPath, type AntigravityProfile } from "./profile.js";
import { callbackAddress, credentialEnvironment } from "./sign-in.js";
import type { AntigravitySessionInput, AntigravitySessionLike } from "./thread-backend.js";

const directories: string[] = [];
const servers: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Flow = { flowId: string; phase: string; browser?: { url: string }; prompt?: { id: string; message: string }; message?: string };
type Report = { methods: Array<{ id: string; unavailable?: string }>; account?: { signedIn: boolean; label?: string; detail?: string }; flow?: Flow };

/** The agent's side of a Google sign-in: a loopback listener that stores a token once Google's redirect reaches it. */
async function fakeAgent(stateDir: string) {
  let reached: () => void = () => undefined;
  const signedIn = new Promise<void>((resolve) => { reached = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.end("ok");
    if (url.searchParams.get("state") === "st-1" && url.searchParams.get("code")) {
      void mkdir(dirname(profileTokenPath(stateDir)), { recursive: true })
        .then(() => writeFile(profileTokenPath(stateDir), "{}"))
        .then(() => reached());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/`;
  return {
    redirectUri,
    link: { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=st-1&redirect_uri=${encodeURIComponent(redirectUri)}`, redirectUri, state: "st-1" },
    signedIn,
  };
}

async function harness(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-sign-in-"));
  directories.push(directory);
  // The registry gives the kit its own folder under the state root.
  const stateDir = join(directory, "state", "tau.antigravity");
  const binary = join(directory, "bin", "agy_acp_server.par");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(directory, "bin", "localharness_external"), "#!/bin/sh\n", { mode: 0o755 });
  const agent = await fakeAgent(stateDir);
  const opened: Array<AntigravitySessionInput & { profile: AntigravityProfile }> = [];
  const session = { close: async () => undefined, logout: async () => { await rm(profileTokenPath(stateDir), { force: true }); } } as unknown as AntigravitySessionLike;
  const openSession = vi.fn(async (input: AntigravitySessionInput & { profile: AntigravityProfile }): Promise<AntigravitySessionLike> => {
    opened.push(input);
    if (input.authenticate === false || input.threadId !== "sign-in") return session;
    const settings = JSON.parse(await readFile(input.profile.settingsPath, "utf8")) as { auth: { type: string } };
    if (settings.auth.type === "oauth-personal" || settings.auth.type === "oauth-business") {
      input.onSignIn(agent.link);
      await Promise.race([agent.signedIn, new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true }))]);
    }
    return session;
  });
  const events: PublishedKitEvent[] = [];
  const backends: HostRuntimeBackendProvider[] = [];
  const registry = await activateHostKit(createAntigravityHostExtension({ openSession: openSession as never, sessionsDir: join(directory, "sessions"), env: { TAU_ANTIGRAVITY_ACP_COMMAND: binary, ...env }, platform: "darwin", arch: "arm64", geminiDir: join(directory, "gemini") }), {
    stateDir: join(directory, "state"),
    findCommand: () => undefined,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => { backends.splice(backends.indexOf(provider), 1); }; },
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async () => undefined },
  }, (event) => events.push(event));
  const flowWhere = async (test: (flow: Flow) => boolean) => {
    let found: Flow | undefined;
    await vi.waitFor(() => {
      found = events.filter((event) => event.name === "sign-in").map((event) => (event.payload as { flow?: Flow }).flow).reverse().find((flow) => flow !== undefined && test(flow));
      expect(found).toBeDefined();
    });
    return found!;
  };
  const finalReport = async (flowId: string) => {
    let found: Report | undefined;
    await vi.waitFor(() => {
      found = events.filter((event) => event.name === "sign-in").map((event) => (event.payload as { report?: Report }).report).find((report) => report?.flow?.flowId === flowId);
      expect(found).toBeDefined();
    });
    return found!;
  };
  return { registry, backends, opened, stateDir, agent, events, flowWhere, finalReport };
}

describe("Antigravity sign-in", () => {
  it("offers the four methods and says what each still needs", async () => {
    const { registry } = await harness();
    const report = await registry.invoke("tau.antigravity", "sign-in-state") as Report;
    expect(report.methods.map((method) => [method.id, method.unavailable])).toEqual([
      ["oauth-personal", undefined],
      ["oauth-business", "Set the Google Cloud project and location below first."],
      ["gemini-api-key", "Set GEMINI_API_KEY in your shell profile and restart Tau; Tau stores no key."],
      ["agent-platform", "Set GOOGLE_API_KEY in your shell profile, or a Google Cloud project and location below."],
    ]);
    expect(report.account).toEqual({ signedIn: false });
  });

  it("signs in with Google, finishing through an address the user pastes when the loopback page did not load", async () => {
    const { registry, stateDir, agent, flowWhere, finalReport, backends } = await harness();
    const before = backends[0];
    const started = await registry.invoke("tau.antigravity", "sign-in", { method: "oauth-personal" }) as Flow;
    const waiting = await flowWhere((flow) => flow.flowId === started.flowId && flow.prompt !== undefined);
    expect(waiting.browser?.url).toBe(agent.link.authorizationUrl);

    await registry.invoke("tau.antigravity", "sign-in-respond", { flowId: started.flowId, value: `${agent.redirectUri}?state=other&code=x` });
    const again = await flowWhere((flow) => flow.flowId === started.flowId && flow.prompt?.id === "p2");
    expect(again.prompt?.message).toMatch(/^That address belongs to another sign-in/u);

    await registry.invoke("tau.antigravity", "sign-in-respond", { flowId: started.flowId, value: `${agent.redirectUri}?state=st-1&code=4%2F0abc&scope=openid` });
    const report = await finalReport(started.flowId);
    expect(report.flow).toMatchObject({ phase: "succeeded", message: "Signed in with the Google account." });
    expect(report.account).toMatchObject({ signedIn: true, label: "Google account" });
    await expect(readFile(profileTokenPath(stateDir), "utf8")).resolves.toBe("{}");
    // Registered anew, so the host asks the runtime again.
    expect(backends).toHaveLength(1);
    expect(before).toBeDefined();

    const out = await registry.invoke("tau.antigravity", "sign-out") as Report & { note?: string };
    expect(out).toMatchObject({ account: { signedIn: false }, note: "Signed out of Antigravity." });
  });

  it("cancels a Google sign-in nobody finished, and ends the agent it started", async () => {
    const { registry, opened, flowWhere } = await harness();
    const started = await registry.invoke("tau.antigravity", "sign-in", { method: "oauth-personal" }) as Flow;
    await flowWhere((flow) => flow.flowId === started.flowId && flow.browser !== undefined);
    await registry.invoke("tau.antigravity", "sign-in-cancel", { flowId: started.flowId });
    expect(opened.at(-1)?.signal?.aborted).toBe(true);
  });

  it("connects with a Gemini API key from the environment, and forgets the choice on sign-out", async () => {
    const { registry, finalReport } = await harness({ GEMINI_API_KEY: "AIza-fake" });
    const started = await registry.invoke("tau.antigravity", "sign-in", { method: "gemini-api-key" }) as Flow;
    const report = await finalReport(started.flowId);
    expect(report.account).toEqual({ signedIn: true, label: "Gemini API key", detail: "GEMINI_API_KEY from your environment", canSignOut: true });
    await expect(registry.invoke("tau.antigravity", "status")).resolves.toMatchObject({ signedIn: true, authMethod: "gemini-api-key" });
    const out = await registry.invoke("tau.antigravity", "sign-out") as Report & { note?: string };
    expect(out.note).toMatch(/no longer uses the Gemini API key/u);
    await expect(registry.invoke("tau.antigravity", "status")).resolves.toMatchObject({ authMethod: "oauth-personal" });
  });

  it("keeps the Google Cloud project for Enterprise, refuses a malformed one and hands it to the agent's profile", async () => {
    const { registry, opened, events, finalReport } = await harness();
    await expect(registry.invoke("tau.antigravity", "set-sign-in", { gcpProject: "Not A Project", gcpLocation: "us-central1" })).rejects.toThrow(/no Google Cloud project name/u);
    await registry.invoke("tau.antigravity", "set-sign-in", { gcpProject: "acme-dev", gcpLocation: "us-central1" });
    const published = events.filter((event) => event.name === "sign-in").at(-1)?.payload as { report?: Report };
    expect(published.report?.methods.find((method) => method.id === "oauth-business")?.unavailable).toBeUndefined();

    const started = await registry.invoke("tau.antigravity", "sign-in", { method: "agent-platform" }) as Flow;
    await finalReport(started.flowId);
    const settings = JSON.parse(await readFile(opened.at(-1)!.profile.settingsPath, "utf8")) as unknown;
    expect(settings).toEqual({ auth: { type: "agent-platform" }, gcp: { project: "acme-dev", location: "us-central1" } });
  });
});

describe("the agent's environment", () => {
  const profile = { geminiHome: "/p", acpDirectory: "/p/a", tokenPath: "/p/a/t", settingsPath: "/p/a/s" };
  it("passes on only the chosen method's credential from the user's environment", () => {
    const base = { PATH: "/bin", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" };
    expect(agentEnvironment(base, profile, "/h", "b")).not.toHaveProperty("GEMINI_API_KEY");
    const key = agentEnvironment(base, profile, "/h", "b", credentialEnvironment(base, { method: "gemini-api-key" }));
    expect(key).toMatchObject({ GEMINI_API_KEY: "g" });
    expect(key).not.toHaveProperty("GOOGLE_API_KEY");
    expect(credentialEnvironment(base, { method: "agent-platform" })).toEqual({ GOOGLE_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" });
    expect(credentialEnvironment(base, { method: "oauth-personal" })).toEqual({});
  });

  it("takes a pasted address only for the agent's own listener and the sign-in's state", () => {
    const link = { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", redirectUri: "http://127.0.0.1:43125/", state: "s" };
    expect(callbackAddress(" http://127.0.0.1:43125/?state=s&code=c ", link)).toBe("http://127.0.0.1:43125/?state=s&code=c");
    expect(() => callbackAddress("http://127.0.0.1:1/?state=s&code=c", link)).toThrow(/starts with http:\/\/127\.0\.0\.1:43125\//u);
    expect(() => callbackAddress("http://127.0.0.1:43125/?state=s", link)).toThrow(/no answer/u);
    expect(() => callbackAddress("not a url", link)).toThrow(/not the address/u);
  });
});
