import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createAntigravityHostExtension from "./host.js";
import { AntigravitySessionStore } from "./session-store.js";
import type { AntigravitySessionLike } from "./thread-backend.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function harness(installed: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-host-"));
  directories.push(directory);
  const geminiDir = join(directory, "gemini");
  await mkdir(join(geminiDir, "config", "skills"), { recursive: true });
  await writeFile(join(geminiDir, "settings.json"), JSON.stringify({ mcpServers: { pencil: { command: "/opt/pencil" } } }));
  const binary = join(directory, "bin", "agy_acp_server.par");
  if (installed) {
    await mkdir(join(directory, "bin"), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(directory, "bin", "localharness_external"), "#!/bin/sh\n", { mode: 0o755 });
    await chmod(binary, 0o755);
    await chmod(join(directory, "bin", "localharness_external"), 0o755);
  }
  const backends: HostRuntimeBackendProvider[] = [];
  const published: Array<{ name: string; payload: unknown }> = [];
  const loggedOut: string[] = [];
  const openSession = vi.fn(async (): Promise<AntigravitySessionLike> => ({
    closed: false, sessionId: undefined, modeId: "default", stderr: "",
    logout: async () => { loggedOut.push("out"); },
    newSession: async () => ({ sessionId: "acp-9" }),
    resumeSession: async (sessionId: string) => ({ sessionId }),
    modelOptions: () => [{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }],
    modeOptions: () => [{ value: "default", name: "Default" }],
    currentModel: () => "gemini-3.8-flash-low",
    setModel: async () => undefined, setMode: async () => undefined,
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined, close: async () => undefined,
  }));
  const registry = await activateHostKit(createAntigravityHostExtension({ openSession, sessionsDir: join(directory, "sessions"), env: { TAU_ANTIGRAVITY_ACP_COMMAND: installed ? binary : "" }, platform: "darwin", arch: "arm64", geminiDir }), {
    stateDir: join(directory, "state"),
    findCommand: () => undefined,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  }, (event) => { if (event.type === "extension-event") published.push({ name: event.name, payload: event.payload }); });
  return { registry, backends, openSession, published, directory, geminiDir, loggedOut };
}

describe("Antigravity host half", () => {
  it("registers its backend with a label and Google as the model provider, and opens threads through the seam", async () => {
    const { backends, openSession, registry } = await harness(true);
    const [provider] = backends;
    expect(provider).toMatchObject({ kind: "antigravity", label: "Antigravity", modelProvider: "google" });
    expect(provider?.adapter.capabilities).toEqual({ skillInvocationDialect: "antigravity", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true });
    const backend = await provider!.open("thread-1", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) });
    await backend.prompt({ text: "hi", delivery: "prompt" });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect((openSession.mock.calls as unknown as Array<[unknown]>)[0]![0]).toMatchObject({ threadId: "thread-1", cwd: "/repo", executable: { source: "override" } });
    expect((await provider!.listThreads()).map((thread) => thread.threadId)).toEqual(["thread-1"]);
    expect(await registry.invoke("tau.antigravity", "status")).toMatchObject({ installed: true, source: "override", signedIn: false });
  });

  it("keeps the account's models for the next start, and reports the user's MCP servers and the release it can install", async () => {
    const { backends, registry, geminiDir } = await harness(true);
    const thread = { projectName: "repo", permissionLevel: () => "full" as const, onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true as const }) };
    const backend = await backends[0]!.open("thread-1", "/repo", { resume: false }, thread);
    await backend.prompt({ text: "hi", delivery: "prompt" });
    await backend.dispose();

    // A second thread has no session of its own yet and still lists the models.
    const next = await backends[0]!.open("thread-2", "/repo", { resume: false }, thread);
    expect((await next.models()).map((model) => model.id)).toEqual(["gemini-3.8-flash-low"]);
    const status = await registry.invoke("tau.antigravity", "status") as { mcpServers: string[]; models: number; available: string };
    expect(status.mcpServers).toEqual(["pencil"]);
    expect(status.models).toBe(1);
    expect(status.available).toMatch(/^agy_acp_server_/u);
    expect(existsSync(join(geminiDir, "config", "skills"))).toBe(true);
  });

  it("signs out through the agent, without opening a sign-in first", async () => {
    const { registry, openSession, loggedOut } = await harness(true);
    expect(await registry.invoke("tau.antigravity", "logout")).toEqual({ signedOut: true });
    expect(loggedOut).toEqual(["out"]);
    expect((openSession.mock.calls as unknown as Array<[{ authenticate?: boolean }]>)[0]![0].authenticate).toBe(false);
  });

  it("reports a missing runtime from status and refuses to open a thread without it", async () => {
    const { backends, registry } = await harness(false);
    expect(await registry.invoke("tau.antigravity", "status")).toMatchObject({ installed: false, message: expect.stringMatching(/not installed/u) });
    await expect(backends[0]!.open("t", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) })).rejects.toThrow(/not installed/u);
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, directory } = await harness(true);
    const store = new AntigravitySessionStore({ filePath: AntigravitySessionStore.defaultPath(join(directory, "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6, costUsd: 0, turns: 2 });
    await store.setObservedModel("thread-1", "/repo", "gemini-3.8-flash-low");
    const reader = (id: string): HostExtension & { read?: () => Promise<unknown> } => {
      const extension: HostExtension & { read?: () => Promise<unknown> } = {
        id,
        name: id,
        activate(context) { extension.read = () => context.invokeHostExtension("tau.antigravity", "usage"); },
      };
      return extension;
    };
    const usageKit = reader("tau.usage");
    const stranger = reader("acme.stranger");
    await registry.activate(usageKit);
    await registry.activate(stranger);
    expect(await usageKit.read!()).toEqual({
      threads: [expect.objectContaining({ threadId: "thread-1", cwd: "/repo", model: "gemini-3.8-flash-low", usage: expect.objectContaining({ totalTokens: 6, turns: 2 }) })],
    });
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.antigravity/usage.");
  });
});
