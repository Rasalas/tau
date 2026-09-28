import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HostExtension, type HostMcpConnection, type HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { startFakeOpenCode, type FakeOpenCode } from "./fixtures/fake-server.js";
import createOpenCodeHostExtension, { openCodeEnvironment } from "./host.js";
import { connectOpenCodeServer, type OpenCodeServeInput } from "./server.js";
import { OpenCodeSessionStore } from "./session-store.js";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-serve.mjs", import.meta.url));
const TAU_SERVER: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };
const directories: string[] = [];
const fakes: FakeOpenCode[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness(options: { installed?: string; found?: boolean; env?: (root: string) => NodeJS.ProcessEnv; config?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-opencode-host-"));
  directories.push(root);
  const fake = await startFakeOpenCode({ ...(options.config ? { config: options.config } : {}) });
  const external = await startFakeOpenCode({ password: "pw", version: "1.16.0" });
  fakes.push(fake, external);
  const backends: HostRuntimeBackendProvider[] = [];
  const events: PublishedKitEvent[] = [];
  const starts: Array<OpenCodeServeInput & { instance: string }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).includes("registry.npmjs.org")
    ? { ok: true, json: async () => ({ version: "1.19.0" }) } as Response
    : globalThis.fetch(url, init));
  const extension = createOpenCodeHostExtension({
    env: options.env?.(root) ?? { PATH: process.env.PATH },
    fetch: fetch as unknown as typeof globalThis.fetch,
    readVersion: async () => options.installed ?? "1.18.32",
    startServer: async (input) => { starts.push(input); return connectOpenCodeServer(fake.url, undefined); },
  });
  const registry = await activateHostKit(extension, {
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async () => TAU_SERVER },
    findCommand: (name) => name === "opencode" && options.found !== false ? FAKE_CLI : undefined,
    sessionsDir: join(root, "agent", "sessions"),
    stateDir: join(root, "state"),
    noteSubprocess: () => undefined,
    sessions: { refreshIndex: async () => ({ threads: [] }) } as never,
    registerRuntimeBackend: (provider) => {
      backends.push(provider);
      return () => { backends.splice(backends.indexOf(provider), 1); };
    },
  }, (event) => events.push(event));
  const backend = (kind: string) => backends.find((entry) => entry.kind === kind);
  return { registry, provider: backends[0]!, backend, backends, events, root, fake, external, starts };
}

const context = { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) } as never;

/** A kit that may call OpenCode's commands for another kit. */
function caller(id: string): HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } {
  const extension: HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } = {
    id, name: id,
    activate(activation) { extension.call = (command, input) => activation.invokeHostExtension("tau.opencode", command, input); },
  };
  return extension;
}

describe("OpenCode host half", () => {
  it("registers an OpenCode backend that asks for approvals, takes files and plans", async () => {
    const { provider } = await harness();
    expect(provider).toMatchObject({ kind: "opencode", label: "OpenCode", order: 40, restrictsTools: true });
    expect(provider.adapter.capabilities).toMatchObject({ interactiveApprovals: true, fileAttachments: true, modes: ["plan"], ownsModelSelection: false });
  });

  it("lists the connected providers' models for a new thread, from a server that runs no thread", async () => {
    const { provider, starts, root } = await harness({ config: { model: "github-copilot/gpt-5.5" } });
    const catalog = await provider.newThreadCatalog!();
    expect(catalog?.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["opencode/big-pickle", "opencode/gpt-5.6-luna", "github-copilot/gpt-5.5"]);
    expect(catalog?.model).toMatchObject({ provider: "github-copilot", id: "gpt-5.5" });
    // The probe gets no Tau tools and runs in the kit's own folder.
    expect(starts).toEqual([expect.objectContaining({ cwd: join(root, "state", "tau.opencode"), instance: "default" })]);
    expect(starts[0]!.config).toBeUndefined();
  });

  it("says OpenCode is missing instead of listing nothing", async () => {
    const { provider } = await harness({ found: false });
    await expect(provider.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "not-installed" });
  });

  it("starts a thread's server with Tau's MCP server laid over the config, and runs a turn on it", async () => {
    const { provider, starts, root } = await harness();
    const backend = await provider.open("tau-thread", root, { resume: false }, context);
    try {
      await expect(backend.prompt({ text: "Reply with one word.", delivery: "prompt" })).resolves.toEqual({ assistantText: "ok" });
    } finally {
      await backend.dispose();
    }
    const thread = starts.find((start) => start.cwd === root)!;
    expect(thread.config).toEqual({ mcp: { tau: { type: "remote", url: TAU_SERVER.url, headers: { Authorization: "Bearer secret" }, oauth: false, enabled: true } } });
    expect(thread.command).toBe(FAKE_CLI);
  });

  it("reports the installed and newest version and the package manager's update command", async () => {
    const { provider, registry } = await harness();
    await expect(provider.version!()).resolves.toMatchObject({ tool: "opencode", installed: "1.18.32", latest: "1.19.0" });
    await expect(registry.invoke("tau.opencode", "status")).resolves.toMatchObject({
      instance: "default", command: "opencode", path: FAKE_CLI, version: "1.18.32", latest: "1.19.0", updateAvailable: true, signedIn: true, account: "OpenCode Zen, GitHub Copilot",
      providers: [{ id: "opencode", name: "OpenCode Zen", models: 3 }, { id: "github-copilot", name: "GitHub Copilot", models: 1 }],
    });
  });

  it("refuses a thread on a release older than the API it speaks", async () => {
    const { provider, root } = await harness({ installed: "1.10.0" });
    await expect(provider.version!()).resolves.toMatchObject({ compatibility: { status: "broken", recommendedVersion: "1.18.32" } });
    const backend = await provider.open("tau-old", root, { resume: false }, context);
    await expect(backend.prompt({ text: "Hi", delivery: "prompt" })).rejects.toThrow(/does not work with Tau/u);
    await backend.dispose();
  });

  it("connects an instance to a server the user runs, with its password, and never hands the password back", async () => {
    const { registry, backend, external, starts } = await harness();
    await registry.invoke("tau.opencode", "save-instance", { instance: { id: "remote", name: "Remote" } });
    const report = await registry.invoke("tau.opencode", "set-server", { instance: "remote", url: `${external.url}/`, password: "pw" });
    expect(report).toMatchObject({ instances: [{ id: "default" }, { id: "remote", kind: "opencode@remote", serverUrl: external.url, hasPassword: true }] });
    expect(JSON.stringify(report)).not.toContain("\"pw\"");
    const status = await registry.invoke("tau.opencode", "status", { instance: "remote" });
    expect(status).toMatchObject({ serverUrl: external.url, version: "1.16.0", signedIn: true });
    const remote = backend("opencode@remote")!;
    await expect(remote.version!()).resolves.toMatchObject({ installed: "1.16.0" });
    await expect(remote.newThreadCatalog!()).resolves.toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "big-pickle" })]) });
    // Nothing was started for it.
    expect(starts).toHaveLength(0);
    await expect(registry.invoke("tau.opencode", "set-server", { instance: "remote", url: "ftp://nope" })).rejects.toThrow(/http/u);
    await expect(registry.invoke("tau.opencode", "set-server", { instance: "remote", url: "http://me:pw@host" })).rejects.toThrow(/own field/u);
  });

  it("gives an instance's home to OpenCode as its four XDG folders", () => {
    expect(openCodeEnvironment({ TAU_OPENCODE_HOME: "/shadow", PATH: "/bin" })).toEqual({
      TAU_OPENCODE_HOME: "/shadow", PATH: "/bin",
      XDG_CONFIG_HOME: "/shadow/config", XDG_DATA_HOME: "/shadow/data", XDG_STATE_HOME: "/shadow/state", XDG_CACHE_HOME: "/shadow/cache",
    });
    expect(openCodeEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("registers a backend per instance and starts its server with the instance's home and arguments", async () => {
    const { registry, backend, starts, root } = await harness();
    await registry.invoke("tau.opencode", "save-instance", { instance: { id: "work", name: "Work", home: join(root, "work"), args: "--log-level WARN" } });
    const work = backend("opencode@work")!;
    expect(work.label).toBe("OpenCode · Work");
    await work.newThreadCatalog!();
    expect(starts.at(-1)).toMatchObject({ instance: "work", args: ["--log-level", "WARN"], env: expect.objectContaining({ XDG_DATA_HOME: join(root, "work", "data") }) });
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new OpenCodeSessionStore({ filePath: OpenCodeSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 17, costUsd: 0.01, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", { provider: "opencode", id: "big-pickle" });
    await store.setSession("thread-1", "/repo", "ses-1");
    const usage = caller("tau.usage");
    const stranger = caller("acme.stranger");
    await registry.activate(usage);
    await registry.activate(stranger);
    await expect(usage.call!("usage")).resolves.toMatchObject({ threads: [{ threadId: "thread-1", sessionId: "ses-1", model: "big-pickle", usage: { costUsd: 0.01 } }] });
    await expect(stranger.call!("usage")).rejects.toThrow(/not allowed/u);
  });

  it("names each local instance's data folder for the Usage kit, from the instance's own home, and no remote server's", async () => {
    const { registry, root, external } = await harness({ env: (dir) => ({ PATH: process.env.PATH, HOME: join(dir, "home") }) });
    await registry.invoke("tau.opencode", "save-instance", { instance: { id: "work", home: join(root, "work") } });
    // A server the user runs keeps its data wherever it runs.
    await registry.invoke("tau.opencode", "save-instance", { instance: { id: "remote" } });
    await registry.invoke("tau.opencode", "set-server", { instance: "remote", url: external.url, password: "pw" });
    const usage = caller("tau.usage");
    await registry.activate(usage);
    await expect(usage.call!("usage-logs")).resolves.toEqual({ folders: [
      { format: "opencode", path: join(root, "home", ".local", "share", "opencode"), instance: "opencode" },
      { format: "opencode", path: join(root, "work", "data", "opencode"), instance: "opencode@work" },
    ] });
  });

  it("lists OpenCode's own sessions for Onboarding and imports them as threads that resume them", async () => {
    const { registry, fake, provider } = await harness();
    const session = fake.addSession({ id: "ses_old", directory: "/work/app", title: "Fix the flaky test", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }, cost: 0.02 });
    session.messages.push(
      { info: { id: "msg_1", sessionID: "ses_old", role: "user", time: { created: 1 } }, parts: [{ id: "p1", type: "text", text: "Fix the flaky test" }, { id: "p2", type: "text", text: "<file>", synthetic: true }] },
      { info: { id: "msg_2", sessionID: "ses_old", role: "assistant", providerID: "opencode", modelID: "big-pickle", time: { created: 2 } }, parts: [{ id: "p3", type: "reasoning", text: "hm" }, { id: "p4", type: "text", text: "Done." }] },
    );
    fake.addSession({ id: "ses_child", directory: "/work/app", parentID: "ses_old" });
    const onboarding = caller("tau.onboarding");
    await registry.activate(onboarding);
    const scan = await onboarding.call!("import-scan") as { source: string; sessions: Array<{ sessionId: string; imported: boolean }> };
    expect(scan).toMatchObject({ source: "opencode", truncated: false, sessions: [{ path: "ses_old", sessionId: "ses_old", cwd: "/work/app", title: "Fix the flaky test", imported: false }] });
    const outcome = await onboarding.call!("import-sessions", { paths: ["ses_old", "ses_missing"] }) as { imported: string[]; failed: unknown[] };
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.failed).toEqual([{ path: "ses_missing", reason: "not a session of OpenCode" }]);
    const [thread] = await provider.listThreads();
    expect(thread).toMatchObject({ cwd: "/work/app", title: "Fix the flaky test", messages: [{ role: "user", text: "Fix the flaky test" }, { role: "assistant", text: "Done." }] });
    await expect(onboarding.call!("import-sessions", { paths: ["ses_old"] })).resolves.toMatchObject({ imported: [], skipped: 1 });
    expect(((await onboarding.call!("import-scan")) as { sessions: Array<{ imported: boolean }> }).sessions[0]!.imported).toBe(true);
  });

  it("reads an import from the fixture home an import root names, never OpenCode's own", async () => {
    const { registry, starts, root } = await harness({ env: (scratch) => ({ PATH: process.env.PATH, TAU_IMPORT_ROOTS: join(scratch, "roots") }) });
    const onboarding = caller("tau.onboarding");
    await registry.activate(onboarding);
    await onboarding.call!("import-scan");
    expect(starts.at(-1)!.env).toMatchObject({ XDG_DATA_HOME: join(root, "roots", "opencode", "data") });
  });
});
