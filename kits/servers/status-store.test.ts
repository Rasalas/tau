import { describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { ServersStatusStore } from "./status-store";
import { SERVERS_STATUS_EVENT, SERVERS_STATUS_TOPIC, type ServersStatus } from "./view-protocol";

const status = (checkedAt?: string): ServersStatus => ({ workspace: "/real/site", repository: true, targets: [{ targetId: "t", ...(checkedAt ? { checkedAt } : {}) } as never] });

describe("the desktop's server status", () => {
  it("watches the topic while subscribed, and keeps an event that overtook the answer to an earlier ask", async () => {
    let listener: ((payload: unknown) => void) | undefined;
    let answer: (value: unknown) => void = () => undefined;
    const unwatch = vi.fn();
    const host: HostExtensionClient = {
      invoke: vi.fn(() => new Promise((resolve) => { answer = resolve; })),
      onEvent: (_name, next) => { listener = next; return () => { listener = undefined; }; },
      watch: vi.fn(() => unwatch),
    };
    const store = new ServersStatusStore(host);
    const stop = store.subscribe(() => undefined);
    expect(host.watch).toHaveBeenCalledWith(SERVERS_STATUS_TOPIC);
    // The client names the project through a link; the host answers with the real path.
    const loading = store.load("/link/site", false);
    listener!({ workspace: "/real/site", status: status("2026-09-25T10:00:00Z") });
    answer(status());
    await loading;
    expect(store.get("/link/site").status?.targets[0]?.checkedAt).toBe("2026-09-25T10:00:00Z");
    // Later events reach the entry by the workspace the answer named.
    listener!({ workspace: "/real/site", status: status("2026-09-25T10:05:00Z") });
    expect(store.get("/link/site").status?.targets[0]?.checkedAt).toBe("2026-09-25T10:05:00Z");
    stop();
    expect(unwatch).toHaveBeenCalled();
    expect(listener).toBeUndefined();
    expect(SERVERS_STATUS_EVENT).toBe("status");
  });

  it("asks again after a turn only for projects that have servers", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(async (_command: string, input: unknown) => (input as { cwd: string }).cwd === "/plain"
        ? { workspace: "/plain", repository: true, targets: [] }
        : status());
      const host: HostExtensionClient = { invoke, onEvent: () => () => undefined, watch: () => () => undefined };
      const store = new ServersStatusStore(host);
      store.subscribe(() => undefined);
      await store.load("/plain", false);
      await store.load("/real/site", false);
      invoke.mockClear();
      store.refreshLoaded(undefined, true);
      await vi.runAllTimersAsync();
      expect(invoke.mock.calls.map(([, input]) => (input as { cwd: string }).cwd)).toEqual(["/real/site"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
