import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostModelAuthInteraction, HostModelAuthServices, HostModelProviderAuth } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import createPiProvidersHostExtension, { providerAccount, providerMethods } from "./host.js";

type Flow = { flowId: string; phase: string; browser?: { url: string }; deviceCode?: { url: string; code: string }; prompt?: { id: string; kind: string; options?: unknown[] }; message?: string };
type Report = { methods: Array<{ id: string }>; account?: { signedIn: boolean; label?: string; canSignOut?: boolean }; flow?: Flow };

const GATEWAY: HostModelProviderAuth = { id: "fakegw", name: "Fake gateway", configured: false, apiKey: { name: "Fake gateway API key", interactive: true }, oauth: { name: "Fake gateway", subscription: false } };
const ENVIRONMENT: HostModelProviderAuth = { id: "openai", name: "OpenAI", configured: true, source: "environment", label: "OPENAI_API_KEY", apiKey: { name: "OpenAI API key", interactive: true } };

/** Pi's seam as a script: a login asks which way and shows a device code, then waits for the test. */
function fakeAuth() {
  const stored = new Map<string, "oauth" | "api_key">();
  let approve: () => void = () => undefined;
  const auth: HostModelAuthServices = {
    providers: async () => [GATEWAY, ENVIRONMENT].map((provider) => ({ ...provider, ...(stored.has(provider.id) ? { stored: stored.get(provider.id)!, configured: true } : {}) })),
    login: vi.fn(async (id: string, type: "oauth" | "api_key", interaction: HostModelAuthInteraction) => {
      if (type === "api_key") {
        await interaction.prompt({ type: "secret", message: "Paste the key" });
        stored.set(id, "api_key");
        return;
      }
      const way = await interaction.prompt({ type: "select", message: "Sign in to Fake gateway:", options: [{ id: "browser", label: "Browser" }, { id: "device-code", label: "Device code" }] });
      if (way === "device-code") interaction.notify({ type: "device_code", userCode: "FAKE-1234", verificationUri: "http://127.0.0.1:9/device", expiresInSeconds: 600 });
      else interaction.notify({ type: "auth_url", url: "http://127.0.0.1:9/authorize", instructions: "Continue in your browser." });
      await new Promise<void>((resolve, reject) => {
        approve = resolve;
        interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
      });
      stored.set(id, "oauth");
    }),
    logout: vi.fn(async (id: string) => { stored.delete(id); }),
  };
  return { auth, approve: () => approve() };
}

async function harness() {
  const fake = fakeAuth();
  const events: PublishedKitEvent[] = [];
  const registry = await activateHostKit(createPiProvidersHostExtension(), { modelAuth: fake.auth }, (event) => events.push(event));
  const flows = () => events.filter((event) => event.name === "sign-in").map((event) => event.payload as { target: string; flow?: Flow; report?: Report });
  const flowWhere = async (test: (flow: Flow) => boolean) => {
    let found: Flow | undefined;
    await vi.waitFor(() => { found = flows().map((event) => event.flow).reverse().find((flow) => flow !== undefined && test(flow)); expect(found).toBeDefined(); });
    return found!;
  };
  const finalReport = async (flowId: string) => {
    let found: Report | undefined;
    await vi.waitFor(() => { found = flows().map((event) => event.report).find((report) => report?.flow?.flowId === flowId); expect(found).toBeDefined(); });
    return found!;
  };
  return { registry, fake, flowWhere, finalReport };
}

describe("Pi Providers host half", () => {
  it("lists Pi's providers and what each offers", async () => {
    const { registry } = await harness();
    await expect(registry.invoke("tau.pi-providers", "providers")).resolves.toEqual([GATEWAY, ENVIRONMENT]);
    expect(providerMethods(GATEWAY).map((method) => method.id)).toEqual(["oauth", "api-key"]);
    expect(providerAccount(ENVIRONMENT)).toEqual({ signedIn: true, label: "OPENAI_API_KEY", detail: "from your environment", canSignOut: false });
  });

  it("runs Pi's own login: its question, then the device code, until Pi has stored it", async () => {
    const { registry, fake, flowWhere, finalReport } = await harness();
    const started = await registry.invoke("tau.pi-providers", "sign-in", { target: "fakegw", method: "oauth" }) as Flow;
    const chooser = await flowWhere((flow) => flow.prompt?.kind === "select");
    expect(chooser.prompt?.options).toHaveLength(2);
    await registry.invoke("tau.pi-providers", "sign-in-respond", { target: "fakegw", flowId: started.flowId, value: "device-code" });
    const code = await flowWhere((flow) => flow.deviceCode !== undefined);
    expect(code.deviceCode).toMatchObject({ code: "FAKE-1234", url: "http://127.0.0.1:9/device" });
    fake.approve();
    const report = await finalReport(started.flowId);
    expect(report.flow).toMatchObject({ phase: "succeeded", message: "Signed in to Fake gateway." });
    expect(report.account).toMatchObject({ signedIn: true, label: "Fake gateway", canSignOut: true });

    const out = await registry.invoke("tau.pi-providers", "sign-out", { target: "fakegw" }) as Report;
    expect(out.account).toEqual({ signedIn: false });
    expect(fake.auth.logout).toHaveBeenCalledWith("fakegw");
  });

  it("hands a typed key to Pi, and cancels a login Pi is still waiting on", async () => {
    const { registry, flowWhere, finalReport } = await harness();
    const keyed = await registry.invoke("tau.pi-providers", "sign-in", { target: "fakegw", method: "api-key" }) as Flow;
    await flowWhere((flow) => flow.prompt?.kind === "secret");
    await registry.invoke("tau.pi-providers", "sign-in-respond", { target: "fakegw", flowId: keyed.flowId, value: "sk-fake" });
    expect((await finalReport(keyed.flowId)).account).toMatchObject({ signedIn: true, label: "API key" });
    await registry.invoke("tau.pi-providers", "sign-out", { target: "fakegw" });

    const browser = await registry.invoke("tau.pi-providers", "sign-in", { target: "fakegw", method: "oauth" }) as Flow;
    await flowWhere((flow) => flow.flowId === browser.flowId && flow.prompt?.kind === "select");
    await registry.invoke("tau.pi-providers", "sign-in-respond", { target: "fakegw", flowId: browser.flowId, value: "browser" });
    await flowWhere((flow) => flow.flowId === browser.flowId && flow.browser?.url === "http://127.0.0.1:9/authorize");
    await expect(registry.invoke("tau.pi-providers", "sign-in-cancel", { target: "fakegw", flowId: browser.flowId })).resolves.toMatchObject({ phase: "cancelled" });
  });

  it("refuses to sign out a provider whose key comes from the environment", async () => {
    const { registry } = await harness();
    await expect(registry.invoke("tau.pi-providers", "sign-out", { target: "openai" })).rejects.toThrow(/stores nothing for OpenAI/u);
  });

  it("says so on a host without the seam", async () => {
    const registry = await activateHostKit(createPiProvidersHostExtension(), {});
    await expect(registry.invoke("tau.pi-providers", "providers")).rejects.toThrow(/cannot sign Pi's providers in/u);
  });

  it("fetches a provider's site icon by its id from the address only the host knows, and shows windows the host name alone", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.url === "/favicon.ico") response.writeHead(200, { "content-type": "image/x-icon" }).end(png);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const stateDir = await mkdtemp(join(tmpdir(), "tau-pi-providers-"));
    try {
      const local: HostModelProviderAuth = { id: "local-llm", name: "Local LLM", configured: true, apiKey: { name: "key", interactive: true }, baseUrl: `http://user:secret@127.0.0.1:${port}/v1?key=secret` };
      const auth: HostModelAuthServices = { providers: async () => [local], login: vi.fn(), logout: vi.fn() };
      const registry = await activateHostKit(createPiProvidersHostExtension(), { modelAuth: auth, stateDir }, () => undefined);
      const [listed] = await registry.invoke("tau.pi-providers", "providers") as Array<Record<string, unknown>>;
      expect(listed).toMatchObject({ id: "local-llm", site: `127.0.0.1:${port}` });
      expect(listed).not.toHaveProperty("baseUrl");
      await expect(registry.invoke("tau.pi-providers", "site-icon", { id: "local-llm" })).resolves.toEqual({ site: `127.0.0.1:${port}`, image: `data:image/png;base64,${png.toString("base64")}` });
      await registry.invoke("tau.pi-providers", "site-icon", { id: "local-llm" });
      expect(paths).toEqual(["/", "/favicon.ico"]);
      await expect(registry.invoke("tau.pi-providers", "site-icon", { id: "nobody" })).rejects.toThrow(/knows no provider/u);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
