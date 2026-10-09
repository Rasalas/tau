import { afterEach, describe, expect, it } from "vitest";
import type {
  ExtensionUiPrompt,
  HostClientObserver,
  HostExtensionServices,
  HostExtensionSettings,
  HostThread,
  HostThreadLifecycle,
  HostTurnObserver,
} from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createNotificationsHostExtension } from "./host.js";
import { ATTENTION_EVENT, NOTIFICATIONS_EXTENSION_ID, NOTIFY_EVENT, PRESENCE_REQUEST_EVENT, silenced, type PresenceReply } from "./protocol.js";

const registries: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.dispose())); });

async function harness(settings?: HostExtensionSettings) {
  const events: PublishedKitEvent[] = [];
  const observers: HostTurnObserver[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const decorators: Array<(prompt: ExtensionUiPrompt) => void | (() => void)> = [];
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
    ...(settings ? { settings: async () => settings } : {}),
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
    await observers[0]!.runEnded!("t1", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([{ clientKey: "window", items: [{ threadId: "t1", reason: "completed", title: "Fix the build", path: "/sessions/t1.jsonl", at: 1_000 }] }]);
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t1" }] });
  });

  it("reports a failed turn, a permission and a question as what they are", async () => {
    const { observers, decorators, presence, named, tick } = await harness();
    await presence({ clientKey: "window", focused: false });
    await observers[0]!.runEnded!("t1", "failed");
    tick(10_000);
    decorators[0]!({ id: "q1", sessionId: "t1", kind: "confirm", title: "Run rm?" });
    tick(10_000);
    decorators[0]!({ id: "q2", sessionId: "t1", kind: "select", title: "Codex wants to run a command", options: ["Allow", "Allow for this session", "Deny"] });
    tick(10_000);
    decorators[0]!({ id: "q3", sessionId: "t1", kind: "select", title: "Which file?", options: ["a.ts", "b.ts"] });
    expect(named(NOTIFY_EVENT).map((payload) => (payload as { items: Array<{ reason: string }> }).items[0]?.reason)).toEqual(["failed", "approval", "approval", "question"]);
  });

  it("counts nothing for a thread a focused client shows, and ignores a sub-agent", async () => {
    const { observers, presence, named } = await harness();
    await presence({ clientKey: "window", focused: true, threadId: "t1" });
    await observers[0]!.runEnded!("t1", "completed");
    await observers[0]!.runEnded!("child", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([{ clientKey: "window", items: [expect.objectContaining({ threadId: "t1" })], seen: true }]);
    expect(named(ATTENTION_EVENT)).toEqual([]);
  });

  it("answers presence with the list and clears the thread the client now shows", async () => {
    const { observers, presence, named } = await harness();
    await presence({ clientKey: "window", focused: false, threadId: "t1" });
    await observers[0]!.runEnded!("t1", "completed");
    await expect(presence({ clientKey: "window", focused: false, threadId: "t1" })).resolves.toMatchObject({ items: [{ threadId: "t1" }] });
    await expect(presence({ clientKey: "window", focused: true, threadId: "t1" })).resolves.toEqual({ items: [] });
    expect(named(ATTENTION_EVENT).at(-1)).toEqual({ items: [] });
  });

  it("hands news that found nobody to the first client that reports", async () => {
    const { observers, presence, named } = await harness();
    await observers[0]!.runEnded!("t1", "completed");
    expect(named(NOTIFY_EVENT)).toEqual([]);
    const reply = await presence({ clientKey: "window", focused: false });
    expect(reply.delivery).toMatchObject({ clientKey: "window", items: [{ threadId: "t1" }] });
  });

  it("asks the remaining clients to report again when one detaches", async () => {
    const { clientObservers, named } = await harness();
    clientObservers[0]!.detached!("client-1");
    expect(named(PRESENCE_REQUEST_EVENT)).toHaveLength(1);
  });

  it("drops a thread's question once another client answered it, and keeps the news of a finished turn", async () => {
    const { observers, decorators, presence, named, tick } = await harness();
    await presence({ clientKey: "window", focused: false, threadId: "t2" });
    const first = decorators[0]!({ id: "q1", sessionId: "t1", kind: "select", title: "Which file?", options: ["a.ts", "b.ts"] });
    const second = decorators[0]!({ id: "q2", sessionId: "t1", kind: "input", title: "Why?" });
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t1", reason: "question" }] });

    (first as () => void)();
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t1" }] });
    (second as () => void)();
    expect(named(ATTENTION_EVENT).at(-1)).toEqual({ items: [] });

    tick(10_000);
    await observers[0]!.runEnded!("t1", "completed");
    const third = decorators[0]!({ id: "q3", sessionId: "t2", kind: "confirm", title: "Run rm?" });
    tick(10_000);
    await observers[0]!.runEnded!("t2", "completed");
    const before = named(ATTENTION_EVENT).length;
    (third as () => void)();
    expect(named(ATTENTION_EVENT)).toHaveLength(before);
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t2", reason: "completed" }, { threadId: "t1", reason: "completed" }] });
  });

  it("drops a deleted thread from the list", async () => {
    const { observers, lifecycles, presence, named } = await harness();
    await presence({ clientKey: "window", focused: false });
    await observers[0]!.runEnded!("t1", "completed");
    await lifecycles[0]!.threadDeleted!("t1", "/project");
    expect(named(ATTENTION_EVENT).at(-1)).toEqual({ items: [] });
  });

  it("tells Push whether someone is at a focused client that was used lately", async () => {
    const { presence, registry } = await harness();
    const attended = () => registry.invoke(NOTIFICATIONS_EXTENSION_ID, "attended");
    await expect(attended()).resolves.toEqual({ attended: false, muted: false });
    await presence({ clientKey: "window", focused: true, threadId: "t2" });
    await expect(attended()).resolves.toEqual({ attended: true, muted: false });
    await presence({ clientKey: "window", focused: true, threadId: "t2", idle: true });
    await expect(attended()).resolves.toEqual({ attended: false, muted: false });
  });

  it("keeps news the user silenced from every client and from Push, and still counts it", async () => {
    const { observers, presence, named, registry, tick } = await harness({ options: { "event-completed": false }, values: {} });
    await presence({ clientKey: "window", focused: false });
    await observers[0]!.runEnded!("t1", "completed");
    tick(10_000);
    await observers[0]!.runEnded!("t1", "failed");
    await expect.poll(() => named(NOTIFY_EVENT).length).toBe(1);
    expect(named(NOTIFY_EVENT)[0]).toMatchObject({ items: [{ reason: "failed" }] });
    expect(named(ATTENTION_EVENT).at(-1)).toMatchObject({ items: [{ threadId: "t1" }] });
    await expect(registry.invoke(NOTIFICATIONS_EXTENSION_ID, "attended", { kind: "completed" })).resolves.toEqual({ attended: false, muted: true });
    await expect(registry.invoke(NOTIFICATIONS_EXTENSION_ID, "attended", { kind: "question" })).resolves.toEqual({ attended: false, muted: false });
  });

  it("is quiet between the hours the user chose, across midnight too", () => {
    const at = (hours: number, minutes = 0) => new Date(2026, 9, 1, hours, minutes);
    const night = { options: { quiet: true }, values: {} };
    expect(silenced("question", night, at(23, 30))).toBe(true);
    expect(silenced("question", night, at(6, 59))).toBe(true);
    expect(silenced("question", night, at(7, 0))).toBe(false);
    expect(silenced("question", { options: { quiet: true }, values: { "quiet-from": "12:00", "quiet-to": "13:00" } }, at(12, 30))).toBe(true);
    expect(silenced("question", { options: { quiet: false }, values: {} }, at(23, 30))).toBe(false);
  });

  it("refuses a presence report it cannot read", async () => {
    const { presence } = await harness();
    await expect(presence({ focused: true })).rejects.toThrow(/clientKey/u);
  });
});
