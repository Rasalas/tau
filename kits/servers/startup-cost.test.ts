import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExecutionPolicyProvider, HostExtensionServices, HostThreadLifecycle } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createServersHostExtension } from "./host.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

// Every process the kit starts, counted; the calls still run.
type RuntimeExtensionFactory = Parameters<HostExtensionServices["registerRuntimeExtension"]>[1];

const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const count = <T extends (...args: never[]) => unknown>(name: string, fn: T) => ((...args: Parameters<T>) => {
    const [command, list] = args as unknown[];
    spawned.calls.push(`${name} ${String(command)} ${Array.isArray(list) ? list.join(" ") : ""}`);
    return fn(...args);
  }) as T;
  return { ...actual, spawn: count("spawn", actual.spawn), execFile: count("execFile", actual.execFile) };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Start-up with no server anywhere must not cost the first thread a process (ticket I17).
describe("Servers at start-up, in a project without servers", () => {
  it("starts no process through the start-up hooks, the runtime extensions, the policy and the window's first asks", async () => {
    const project = await tempDir("tau-servers-startup-");
    execFileSync("git", ["init", "-q", project]);
    const state = await tempDir("tau-servers-startup-state-");
    const lifecycles: HostThreadLifecycle[] = [];
    const factories: RuntimeExtensionFactory[] = [];
    let provider: HostExecutionPolicyProvider | undefined;
    const registry = await activateHostKit(createServersHostExtension(), {
      stateDir: state,
      knownWorkspacePath: async (path: string) => path,
      workspaceRef: () => ({ workspaceId: "ws1_startup" }) as never,
      registerThreadLifecycle: (lifecycle: HostThreadLifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
      registerRuntimeExtension: (_name: string, factory: RuntimeExtensionFactory) => { factories.push(factory); return () => undefined; },
      executionPolicy: { provide: (next: HostExecutionPolicyProvider) => { provider = next; return () => undefined; }, changed: () => undefined, for: async () => ({ network: "any", allowHosts: [], reasons: [], sources: [] }), observe: () => () => undefined } as never,
    });
    spawned.calls.length = 0;
    try {
      for (const lifecycle of lifecycles) await lifecycle.beforeWorkspace?.(project);
      const session = { cwd: project, sessionId: "thread-1", sessionFile: join(project, "thread.jsonl") };
      for (const lifecycle of lifecycles) await lifecycle.beforeOpen?.(session as never);
      const pi = { on: () => undefined, registerTool: () => undefined };
      for (const factory of factories) await factory(pi as never, session as never);
      expect(await provider!(project)).toBeUndefined();
      // `check-drift` runs what the drift check a project's opening starts in the background runs.
      for (const command of ["prompts", "status", "drift", "check-drift", "targets"]) await registry.invoke(SERVERS_EXTENSION_ID, command, { cwd: project });
      expect(spawned.calls).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });
});
