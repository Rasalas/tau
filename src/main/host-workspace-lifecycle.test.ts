import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiHost } from "./pi-host.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { HostExtension } from "./host-extensions.js";
import { ThreadTrash } from "./thread-trash.js";

function idleThread(threadId: string, cwd: string) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd,
    turnReporting: "streamed" as const,
    capabilities: {},
    state: () => ({
      streaming: false,
      idle: true,
      hasMessages: true,
      sessionFile: `/${threadId}.jsonl`,
      activeTools: [],
      supportsImageInput: false,
      extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never, { session: { sessionId: threadId } } as never);
}

/** A host with the collaborators a workspace switch would otherwise really drive. */
async function hostWithHooks(order: string[]): Promise<{ host: PiHost; internals: Record<string, any> }> {
  const extension: HostExtension = {
    id: "test.workspace",
    name: "Workspace",
    activate: (context) => {
      context.services.registerThreadLifecycle({
        beforeWorkspace: async (cwd) => { order.push(`open ${cwd}`); },
        afterWorkspaceClose: async (cwd, reason) => { order.push(`close ${cwd} ${reason}`); },
        threadDeleted: async (sessionId, cwd) => { order.push(`deleted ${sessionId} ${cwd}`); },
      });
    },
  };
  const host = new PiHost("/repo", () => undefined, {} as never, false, false, { hostExtensions: [extension] });
  const internals = host as unknown as Record<string, any>;
  await internals.activateHostExtensions();
  const thread = idleThread("session", "/repo");
  await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
  internals.threads.setActive("session");
  internals.rememberProject = async () => {};
  internals.activeUpdates = async () => ({ version: 1, updates: [] });
  internals.attached = { session: { attach: async () => false, detach: () => undefined, owns: () => false } };
  internals.initialSessionManager = async () => ({ getSessionFile: () => "/other.jsonl" });
  internals.runtimes = { open: async () => idleThread("other", "/other"), settleOpening: async () => undefined };
  internals.liveThreadForPath = () => undefined;
  internals.activateThread = async () => true;
  internals.logReplacement = () => undefined;
  return { host, internals };
}

describe("workspace lifecycle hooks", () => {
  it("closes the workspace it leaves before the next one opens", async () => {
    const order: string[] = [];
    const { host } = await hostWithHooks(order);
    await host.setWorkspace("/other");
    expect(order).toEqual(["close /repo switch", "open /other"]);
  });

  it("does not close a workspace the host stays in", async () => {
    const order: string[] = [];
    const { host } = await hostWithHooks(order);
    await host.setWorkspace("/repo");
    expect(order).toEqual(["open /repo"]);
  });

  it("closes every open workspace when the host stops", async () => {
    const order: string[] = [];
    const { host, internals } = await hostWithHooks(order);
    internals.prewarm = { dispose: () => undefined, discardSpare: async () => undefined };
    internals.index = { dispose: async () => undefined };
    internals.hostExtensions = { dispose: async () => undefined };
    internals.projectHistory = { flush: async () => undefined, list: () => [] };
    // The teardown after the hooks touches collaborators this harness does not
    // build; the hook order is what this test is about.
    await host.dispose().catch(() => undefined);
    expect(order).toEqual(["close /repo shutdown"]);
  });

  it("moves a deleted thread to the trash and announces it only when purged", async () => {
    const order: string[] = [];
    const { host, internals } = await hostWithHooks(order);
    const directory = await mkdtemp(join(tmpdir(), "tau-remove-"));
    const path = join(directory, "gone.jsonl");
    await writeFile(path, "{}\n", "utf8");
    const announced: Array<[string, string]> = [];
    const refreshed: string[] = [];
    const byId = (sessionId: string) => sessionId === "gone" ? { id: "gone", path, projectPath: "/repo", title: "Gone" } : undefined;
    internals.index = {
      byId,
      find: async (sessionId: string) => byId(sessionId),
      refresh: async (publish: string) => { refreshed.push(publish); },
    };
    internals.trash = new ThreadTrash({
      backend: () => undefined,
      threadDeleted: async (sessionId, cwd) => { announced.push([sessionId, cwd]); },
      log: () => undefined,
    }, { dir: join(directory, "trash") });

    await host.removeThread("gone");
    expect(await readdir(directory)).toEqual(["trash"]);
    expect(announced).toEqual([]);

    await host.restoreThread("gone");
    expect(await readdir(directory)).toEqual(["gone.jsonl", "trash"]);

    await host.removeThread("gone");
    await host.purgeThread("gone");
    expect(announced).toEqual([["gone", "/repo"]]);
    expect(refreshed).toEqual(["changes", "changes", "changes"]);
  });

  it("refuses to delete the thread on screen", async () => {
    const order: string[] = [];
    const { host, internals } = await hostWithHooks(order);
    const session = { id: "session", path: "/session.jsonl", projectPath: "/repo" };
    internals.index = { byId: () => session, find: async () => session };
    await expect(host.removeThread("session")).rejects.toThrow(/on screen/iu);
  });
});
