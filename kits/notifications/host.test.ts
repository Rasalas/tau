import { afterEach, describe, expect, it } from "vitest";
import type {
  ExtensionUiPrompt,
  HostClientObserver,
  HostExtensionServices,
  HostThread,
  HostThreadLifecycle,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createNotificationsHostExtension } from "./host.js";
import { ATTENTION_EVENT, NOTIFICATIONS_EXTENSION_ID, NOTIFY_EVENT, PRESENCE_REQUEST_EVENT, type PresenceReply } from "./protocol.js";

const registries: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.dispose())); });

async function harness() {
  const events: PublishedKitEvent[] = [];
  const observers: HostTurnObserver[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const decorators: Array<(prompt: ExtensionUiPrompt) => void> = [];
  const clientObservers: HostClientObserver[] = [];
  const threads: Record<string, Partial<HostThread>> = {
    t1: { sessionId: "t1", sessionFile: "/sessions/t1.jsonl", sessionName: () => "Fix the build" },
    child: { sessionId: "child", parentThreadId: "t1", sessionName: () => "Index 1" },
  };
  const services: Partial<HostExtensionServices> = {
    thread: (sessionId) => (sessionId ? threads[sessionId] : undefined) as HostThread | undefined,
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    decorateUiPrompt: (decorator) => { decorators.push(decorator); return () => undefined; },
    clients: { count: () => clientObservers.length, observe: (observer) => { clientObservers.push(observer); return () => undefined; } },
  };
  let now = 1_000;
  const registry = await activateHostKit(createNotificationsHostExtension({ now: () => now, debounceMs: 5_000 }), services, (event) => events.push(event));
  registries.push(registry);
  const presence = (input: unknown) => registry.invoke(NOTIFICATIONS_EXTENSION_ID, "presence", input) as Promise<PresenceReply>;
  const named = (name: string) => events.filter((event) => event.name === name).map((event) => event.payload);
  return { events, observers, lifecycles, decorators, clientObservers, presence, named, registry, tick: (ms: number) => { now += ms; } };
}

describe("the notifications host half", () => {
  it("activates guarded by the permissions its manifest names", async () => {
    const { registry } = await harness();
    expect(registry.summaries().find((entry) => entry.id === NOTIFICATIONS_EXTENSION_ID)?.active).toBe(true);
  });

  it("tells the one client that is not looking when a turn ends, with the thread's title and file", async () => {
    const { observers, presence, named } = await harness();
    await presence({ clientKey: "window", focused: false, threadId: "t2" });
    await observers[0]!.ended!("t1", "turn-1", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([{ clientKey: "window", items: [{ threadId: "t1", reason: "completed", title: "Fix the build", path: "/sessions/t1.jsonl", at: 1_000 }] }]);
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t1" }] });
  });

  it("reports a failed turn and a question as what they are", async () => {
    const { observers, decorators, presence, named, tick } = await harness();
    await presence({ clientKey: "window", focused: false });
    await observers[0]!.ended!("t1", "turn-1", "failed");
    tick(10_000);
    decorators[0]!({ id: "q1", sessionId: "t1", kind: "confirm", title: "Run rm?" });
    expect(named(NOTIFY_EVENT).map((payload) => (payload as { items: Array<{ reason: string }> }).items[0]?.reason)).toEqual(["failed", "question"]);
  });

  it("counts nothing for a thread a focused client shows, and ignores a sub-agent", async () => {
    const { observers, presence, named } = await harness();
    await presence({ clientKey: "window", focused: true, threadId: "t1" });
    await observers[0]!.ended!("t1", "turn-1", "completed");
    await observers[0]!.ended!("child", "turn-2", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([{ clientKey: "window", items: [expect.objectContaining({ threadId: "t1" })], seen: true }]);
    expect(named(ATTENTION_EVENT)).toEqual([]);
  });

  it("answers presence with the list and clears the thread the client now shows", async () => {
    const { observers, presence, named } = await harness();
    await presence({ clientKey: "window", focused: false, threadId: "t1" });
    await observers[0]!.ended!("t1", "turn-1", "completed");
    await expect(presence({ clientKey: "window", focused: false, threadId: "t1" })).resolves.toMatchObject({ items: [{ threadId: "t1" }] });
    await expect(presence({ clientKey: "window", focused: true, threadId: "t1" })).resolves.toEqual({ items: [] });
    expect(named(ATTENTION_EVENT).at(-1)).toEqual({ items: [] });
  });

  it("hands news that found nobody to the first client that reports", async () => {
    const { observers, presence, named } = await harness();
    await observers[0]!.ended!("t1", "turn-1", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([]);
    const reply = await presence({ clientKey: "window", focused: false });
    expect(reply.delivery).toMatchObject({ clientKey: "window", items: [{ threadId: "t1" }] });
  });

  it("asks the remaining clients to report again when one detaches", async () => {
    const { clientObservers, named } = await harness();
    clientObservers[0]!.detached!("client-1");
    expect(named(PRESENCE_REQUEST_EVENT)).toHaveLength(1);
  });

  it("drops a deleted thread from the list", async () => {
    const { observers, lifecycles, presence, named } = await harness();
    await presence({ clientKey: "window", focused: false });
    await observers[0]!.ended!("t1", "turn-1", "completed");
    await lifecycles[0]!.threadDeleted!("t1", "/project");
    expect(named(ATTENTION_EVENT).at(-1)).toEqual({ items: [] });
  });

  it("refuses a presence report it cannot read", async () => {
    const { presence } = await harness();
    await expect(presence({ focused: true })).rejects.toThrow(/clientKey/u);
  });
});
