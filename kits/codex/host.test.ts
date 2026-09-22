import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findExecutable, type HostExtension, type HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { CodexAppServer } from "./app-server.js";
import createCodexHostExtension from "./host.js";
import { spawnRpcProcess } from "./rpc.js";
import { CodexSessionStore } from "./session-store.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-app-server.mjs", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A `codex` on the PATH that resolves into a Homebrew cask, as the real install does. */
async function caskInstall(root: string): Promise<string> {
  const real = join(root, "Caskroom", "codex", "0.154.0", "bin", "codex");
  await mkdir(join(root, "Caskroom", "codex", "0.154.0", "bin"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(real, "");
  await symlink(real, join(root, "bin", "codex"));
  return join(root, "bin", "codex");
}

async function harness(options: { installed?: string | undefined; found?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-codex-host-"));
  directories.push(root);
  const path = await caskInstall(root);
  const backends: HostRuntimeBackendProvider[] = [];
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.155.1" }) }) as Response);
  const extension = createCodexHostExtension({
    env: options.env ?? {},
    fetch,
    readVersion: async () => "installed" in options ? options.installed : "0.154.0",
    openSession: (input) => CodexAppServer.open({
      command: process.execPath,
      cwd: input.cwd,
      env: { ...process.env, CODEX_HOME: join(root, "home") },
      clientVersion: "test",
      spawn: (spawn) => spawnRpcProcess({ ...spawn, args: [STUB, ...spawn.args] }),
      onNotification: input.onNotification,
      onRequest: input.onRequest,
      onExit: input.onExit,
    }),
  });
  const registry = await activateHostKit(extension, {
    findCommand: (name) => name === "codex" ? (options.found !== false ? path : undefined) : findExecutable(name),
    sessionsDir: join(root, "agent", "sessions"),
    stateDir: join(root, "state"),
    noteSubprocess: () => undefined,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  });
  return { registry, provider: backends[0]!, root, fetch };
}

const context = { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) } as never;

describe("Codex host half", () => {
  it("registers a Codex backend that asks for approvals and takes files", async () => {
    const { provider } = await harness();
    expect(provider).toMatchObject({ kind: "codex", label: "Codex", modelProvider: "openai" });
    expect(provider.adapter.capabilities).toMatchObject({ skillInvocationDialect: "codex", interactiveApprovals: true, fileAttachments: true });
    expect(provider.composerCommands("/repo")).toEqual([]);
  });

  it("reports the installed and newest version and the command of the package manager that owns the CLI", async () => {
    const { provider, fetch } = await harness();
    await expect(provider.version!()).resolves.toEqual({ tool: "codex", installed: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex" });
    await provider.version!();
    // The registry is asked once a day, not once per question.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a thread on a CLI older than the protocol it speaks, or on none", async () => {
    const old = await harness({ installed: "0.150.0" });
    await expect(old.provider.open("t", "/repo", { resume: false }, context)).rejects.toThrow("Codex 0.150.0 is older than 0.154.0, the oldest release Tau speaks to. Update it with: brew upgrade --cask codex");
    const missing = await harness({ found: false });
    await expect(missing.provider.open("t", "/repo", { resume: false }, context)).rejects.toThrow("was not found on the PATH");
    await expect(missing.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex", message: expect.stringContaining("Settings → Providers") });
  });

  it("reports the CLI, its update and the account it is signed in as", async () => {
    const { registry, root } = await harness();
    await expect(registry.invoke("tau.codex", "status")).resolves.toEqual({
      command: "codex",
      path: join(root, "bin", "codex"),
      version: "0.154.0",
      latest: "0.155.1",
      updateCommand: "brew upgrade --cask codex",
      updateAvailable: true,
      account: { kind: "chatgpt", plan: "pro" },
      signedIn: true,
      models: 5,
      codexHome: join(root, "home"),
    });
  });

  it("keeps a path set on the Providers card, refuses one that is no executable, and lets the environment win", async () => {
    const { registry, root } = await harness({ found: false });
    const path = join(root, "bin", "codex");
    await expect(registry.invoke("tau.codex", "set-command", { command: join(root, "nothing") })).rejects.toThrow("No executable");
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex", message: expect.stringContaining("not found") });
    await chmod(path, 0o755);
    await expect(registry.invoke("tau.codex", "set-command", { command: path })).resolves.toEqual({ command: path });
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: path, commandSource: "setting", version: "0.154.0" });
    expect(JSON.parse(await readFile(join(root, "state", "tau.codex", "settings.json"), "utf8"))).toEqual({ command: path });
    await registry.invoke("tau.codex", "set-command", { command: "" });
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex" });

    const pinned = await harness({ env: { TAU_CODEX_COMMAND: path } });
    await expect(pinned.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: path, commandSource: "env" });
    await expect(pinned.registry.invoke("tau.codex", "set-command", { command: "" })).rejects.toThrow("TAU_CODEX_COMMAND is set");
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new CodexSessionStore({ filePath: CodexSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 17, costUsd: 0, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", "gpt-5.6-luna");
    const reader = (id: string): HostExtension & { read?: () => Promise<unknown> } => {
      const extension: HostExtension & { read?: () => Promise<unknown> } = { id, name: id, activate(activation) { extension.read = () => activation.invokeHostExtension("tau.codex", "usage"); } };
      return extension;
    };
    const usageKit = reader("tau.usage");
    const stranger = reader("acme.stranger");
    await registry.activate(usageKit);
    await registry.activate(stranger);
    await expect(usageKit.read!()).resolves.toMatchObject({ threads: [{ threadId: "thread-1", cwd: "/repo", model: "gpt-5.6-luna", usage: { totalTokens: 17, turns: 1 } }] });
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.codex/usage.");
  });
});
