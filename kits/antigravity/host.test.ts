import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createAntigravityHostExtension from "./host.js";
import type { AntigravitySessionLike } from "./thread-backend.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function harness(installed: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-host-"));
  directories.push(directory);
  const binary = join(directory, "bin", "agy_acp_server.par");
  if (installed) {
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 }).catch(async () => { const { mkdir } = await import("node:fs/promises"); await mkdir(join(directory, "bin"), { recursive: true }); await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 }); });
    await writeFile(join(directory, "bin", "localharness_external"), "#!/bin/sh\n", { mode: 0o755 });
    await chmod(binary, 0o755);
  }
  const backends: HostRuntimeBackendProvider[] = [];
  const published: Array<{ name: string; payload: unknown }> = [];
  const openSession = vi.fn(async (): Promise<AntigravitySessionLike> => ({
    closed: false, sessionId: undefined, modeId: "default", stderr: "",
    newSession: async () => ({ sessionId: "acp-9" }),
    resumeSession: async (sessionId: string) => ({ sessionId }),
    modelOptions: () => [{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }],
    modeOptions: () => [{ value: "default", name: "Default" }],
    currentModel: () => "gemini-3.8-flash-low",
    setModel: async () => undefined, setMode: async () => undefined,
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined, close: async () => undefined,
  }));
  const registry = await activateHostKit(createAntigravityHostExtension({ openSession, sessionsDir: join(directory, "sessions"), env: { TAU_ANTIGRAVITY_ACP_COMMAND: installed ? binary : "" }, platform: "darwin", arch: "arm64" }), {
    stateDir: join(directory, "state"),
    findCommand: () => undefined,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  }, (event) => { if (event.type === "extension-event") published.push({ name: event.name, payload: event.payload }); });
  return { registry, backends, openSession, published, directory };
}

describe("Antigravity host half", () => {
  it("registers its backend with a label and Google as the model provider, and opens threads through the seam", async () => {
    const { backends, openSession, registry } = await harness(true);
    const [provider] = backends;
    expect(provider).toMatchObject({ kind: "antigravity", label: "Antigravity", modelProvider: "google" });
    expect(provider?.adapter.capabilities).toEqual({ skillInvocationDialect: "antigravity", ownsModelSelection: false, interactiveApprovals: true });
    const backend = await provider!.open("thread-1", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) });
    await backend.prompt({ text: "hi", delivery: "prompt" });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect((openSession.mock.calls as unknown as Array<[unknown]>)[0]![0]).toMatchObject({ threadId: "thread-1", cwd: "/repo", executable: { source: "override" } });
    expect((await provider!.listThreads()).map((thread) => thread.threadId)).toEqual(["thread-1"]);
    expect(await registry.invoke("tau.antigravity", "status")).toMatchObject({ installed: true, source: "override", signedIn: false });
  });

  it("reports a missing runtime from status and refuses to open a thread without it", async () => {
    const { backends, registry } = await harness(false);
    expect(await registry.invoke("tau.antigravity", "status")).toMatchObject({ installed: false, message: expect.stringMatching(/not installed/u) });
    await expect(backends[0]!.open("t", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) })).rejects.toThrow(/not installed/u);
  });
});
