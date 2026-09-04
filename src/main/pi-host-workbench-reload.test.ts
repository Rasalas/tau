import { describe, expect, it, vi } from "vitest";
import { PiHost } from "./pi-host.js";
import { ThreadRuntime } from "./thread-runtime.js";

type HostInternals = {
  threads: {
    adopt(record: { threadId: string; cwd: string; runtime: ThreadRuntime; isolation: "in-process" }): Promise<void>;
  };
};

function hostWithRun() {
  let idle = false;
  const waitForIdle = vi.fn(async () => { idle = true; });
  const abort = vi.fn(async () => { idle = true; });
  const backend = {
    kind: "external-test",
    threadId: "thread-running",
    cwd: "/repo",
    isIdle: () => idle,
    isStreaming: () => !idle,
    waitForIdle,
    abort,
  };
  const host = new PiHost("/repo", () => undefined, {} as never, false, false);
  const runtime = new ThreadRuntime(backend as never);
  return {
    host,
    waitForIdle,
    abort,
    adopt: () => (host as unknown as HostInternals).threads.adopt({
      threadId: "thread-running",
      cwd: "/repo",
      runtime,
      isolation: "in-process",
    }),
  };
}

describe("PiHost workbench reload preparation", () => {
  it("reports running threads without interrupting them", async () => {
    const fixture = hostWithRun();
    await fixture.adopt();

    await expect(fixture.host.prepareWorkbenchReload("inspect")).resolves.toEqual({ ready: false, runningThreads: 1 });
    expect(fixture.waitForIdle).not.toHaveBeenCalled();
    expect(fixture.abort).not.toHaveBeenCalled();
  });

  it("waits for running threads and then blocks new work", async () => {
    const fixture = hostWithRun();
    await fixture.adopt();

    await expect(fixture.host.prepareWorkbenchReload("wait")).resolves.toEqual({ ready: true, runningThreads: 0 });
    expect(fixture.waitForIdle).toHaveBeenCalledOnce();
    await expect(fixture.host.prompt("new work")).rejects.toThrow("Tau is waiting to apply changes");
    await fixture.host.releaseWorkbenchReload();
    await expect(fixture.host.prompt("new work")).rejects.toThrow("Pi runtime is not ready");
  });

  it("stops every running thread only when requested", async () => {
    const fixture = hostWithRun();
    await fixture.adopt();

    await expect(fixture.host.prepareWorkbenchReload("abort")).resolves.toEqual({ ready: true, runningThreads: 0 });
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.waitForIdle).not.toHaveBeenCalled();
  });
});
