import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelAuth, type HostModelAuthEvent, type HostModelAuthPrompt } from "./model-auth.js";
import { startFakeOAuthGateway, type FakeOAuthGateway } from "./test-support/fake-oauth-gateway.js";

let dir: string;
let gateway: FakeOAuthGateway;
const offline = process.env.PI_OFFLINE;

beforeEach(async () => {
  process.env.PI_OFFLINE = "1";
  dir = await mkdtemp(join(tmpdir(), "tau-model-auth-"));
  gateway = await startFakeOAuthGateway();
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { fakegw: { name: "Fake gateway", oauth: "radius", baseUrl: `${gateway.url}/v1` } } }));
});

afterEach(async () => {
  if (offline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = offline;
  await gateway.close();
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const changed = vi.fn();
  const runtime = ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
  return { auth: createModelAuth({ runtime: () => runtime, changed }), changed, runtime };
}

const stored = async () => JSON.parse(await readFile(join(dir, "auth.json"), "utf8").catch(() => "{}")) as Record<string, { type: string; key?: string }>;

describe("createModelAuth", () => {
  it("lists Pi's providers with their sign-in and what is stored for them", async () => {
    const { auth } = setup();
    const providers = await auth.providers();
    expect(providers.find((entry) => entry.id === "fakegw")).toMatchObject({ name: "Fake gateway", oauth: { name: "Fake gateway", subscription: false } });
    expect(providers.find((entry) => entry.id === "anthropic")?.apiKey).toMatchObject({ interactive: true });
    expect(providers.find((entry) => entry.id === "fakegw")?.stored).toBeUndefined();
  });

  it("signs in with a device code against the gateway and out again, in Pi's own file", async () => {
    const { auth, changed } = setup();
    const events: HostModelAuthEvent[] = [];
    const prompts: HostModelAuthPrompt[] = [];
    await auth.login("fakegw", "oauth", {
      signal: new AbortController().signal,
      prompt: async (prompt) => { prompts.push(prompt); return "device-code"; },
      notify: (event) => {
        events.push(event);
        if (event.type === "device_code") gateway.approveDevice();
      },
    });
    expect(prompts[0]).toMatchObject({ type: "select" });
    expect(events).toContainEqual(expect.objectContaining({ type: "device_code", userCode: "FAKE-1234", verificationUri: `${gateway.url}/device` }));
    expect((await stored()).fakegw).toMatchObject({ type: "oauth" });
    expect(changed).toHaveBeenCalledOnce();
    expect((await auth.providers()).find((entry) => entry.id === "fakegw")).toMatchObject({ configured: true, stored: "oauth" });

    await auth.logout("fakegw");
    expect((await stored()).fakegw).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("asks a gateway for the models its account offers once signed in", async () => {
    delete process.env.PI_OFFLINE;
    const { auth, runtime } = setup();
    await auth.login("fakegw", "oauth", {
      signal: new AbortController().signal,
      prompt: async () => "device-code",
      notify: (event) => { if (event.type === "device_code") gateway.approveDevice(); },
    });
    expect(gateway.requests).toContain("/v1/config");
    expect((await runtime).getModels("fakegw").map((model) => model.id)).toContain("fake-small");
  });

  it("stores a key typed for a provider that takes one", async () => {
    const { auth } = setup();
    await auth.login("anthropic", "api_key", {
      signal: new AbortController().signal,
      prompt: async () => "sk-ant-fake",
      notify: () => undefined,
    });
    expect((await stored()).anthropic).toEqual({ type: "api_key", key: "sk-ant-fake" });
  });

  it("refuses a provider Pi does not know", async () => {
    const { auth, changed } = setup();
    const interaction = { signal: new AbortController().signal, prompt: async () => "", notify: () => undefined };
    await expect(auth.login("nobody", "oauth", interaction)).rejects.toThrow(/knows no provider/u);
    expect(changed).not.toHaveBeenCalled();
  });
});
