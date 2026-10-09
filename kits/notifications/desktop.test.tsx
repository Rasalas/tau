// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAttention, SettingsPageProps, UiSession, WorkbenchActions } from "tau";
import { ThreadStore, ThreadStoreContext, ToastStore, ToastViewport, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import notifications from "./desktop.js";
import { ATTENTION_EVENT, IDLE_AFTER_MS, NOTIFICATIONS_EXTENSION_ID, NOTIFY_EVENT, PRESENCE_REQUEST_EVENT, type AttentionItem } from "./protocol.js";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const item = (threadId: string, reason: AttentionItem["reason"] = "completed"): AttentionItem => ({ threadId, reason, at: 1, title: `Host ${threadId}` });
const session = (id: string): UiSession => ({ id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 1 });

let focused = false;
beforeEach(() => {
  focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(options: { presence?: unknown; mode?: string } = {}) {
  const invoke = vi.fn(async (_id: string, command: string, _input?: unknown) => command === "presence" ? (options.presence ?? { items: [] }) : undefined);
  const outcomes: Array<(outcome: "clicked" | "dismissed") => void> = [];
  const attention = {
    notify: vi.fn(() => new Promise<"clicked" | "dismissed">((resolve) => { outcomes.push(resolve); })),
    setBadge: vi.fn(),
    requestPermission: vi.fn(async () => true),
  } satisfies PlatformAttention;
  const { registry, preferences } = createKitHarness(invoke, undefined, { attention });
  // Off by default; most cases are about what an opted-in client shows.
  if (options.mode !== "default") preferences.setValue(NOTIFICATIONS_EXTENSION_ID, "mode", options.mode ?? "notification");
  registry.activate(notifications);
  const toasts = new ToastStore({ schedule: () => () => undefined });
  const actions = {
    switchSession: vi.fn(async () => true),
    activeThread: vi.fn(() => ({ sessionId: "on-screen", draftPending: false })),
    notify: vi.fn(),
    toast: toasts.show,
  } as unknown as WorkbenchActions;
  const Region = registry.getRegions("composer-above")[0]!.Component;
  const threads = new ThreadStore();
  threads.applyThreadIndex({ projects: [], sessions: [session("t1")] });
  render(<ThreadStoreContext.Provider value={threads}><Region actions={actions} /><ToastViewport store={toasts} /></ThreadStoreContext.Provider>);
  const push = (name: string, payload?: unknown) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: NOTIFICATIONS_EXTENSION_ID, name, payload }));
  const presences = () => invoke.mock.calls.filter((call) => call[1] === "presence").map((call) => call[2] as { clientKey: string; focused: boolean; threadId?: string; idle?: boolean });
  const clientKey = () => presences()[0]!.clientKey;
  return { registry, preferences, invoke, attention, outcomes, actions, toasts, threads, push, presences, clientKey };
}

describe("Notifications on the desktop", () => {
  it("says which thread this window shows and whether it has focus", async () => {
    const { presences, clientKey } = setup();
    await flush();
    expect(presences().at(-1)).toEqual({ clientKey: clientKey(), focused: false, threadId: "on-screen" });
    focused = true;
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(presences().at(-1)).toMatchObject({ focused: true, threadId: "on-screen" });
  });

  it("reports a focused window nobody used for a while as idle, and busy again on the next key", async () => {
    vi.useFakeTimers();
    try {
      focused = true;
      const { presences } = setup();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(presences().at(-1)).toMatchObject({ focused: true });
      expect(presences().at(-1)?.idle).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS); });
      expect(presences().at(-1)).toMatchObject({ focused: true, idle: true });
      act(() => { fireEvent.keyDown(document, { key: "a" }); });
      expect(presences().at(-1)?.idle).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises a system notification for news addressed to it, and opens the thread on a click", async () => {
    const { push, attention, outcomes, actions, clientKey } = setup();
    await flush();
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [item("t1")] });
    expect(attention.notify).toHaveBeenCalledWith({ title: "Thread t1", body: "Finished", tag: "tau.thread:t1" });
    outcomes[0]!("clicked");
    await flush();
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/t1.jsonl");
  });

  it("ignores news addressed to another client", async () => {
    const { push, attention } = setup();
    await flush();
    push(NOTIFY_EVENT, { clientKey: "another-window", items: [item("t1")] });
    expect(attention.notify).not.toHaveBeenCalled();
  });

  it("shows what waited for a client when it first reports", async () => {
    const { attention } = setup({ presence: { items: [item("t1"), item("t2")], delivery: { clientKey: "x", items: [item("t2"), item("t1")] } } });
    await flush();
    expect(attention.notify).toHaveBeenCalledWith({ title: "2 threads need you", body: "Host t2, Thread t1", tag: "tau.threads" });
    expect(attention.setBadge).toHaveBeenCalledWith(2);
  });

  it("keeps the icon's badge at the count of unseen threads, and clears it when turned off", async () => {
    const { push, attention, preferences } = setup();
    await flush();
    push(ATTENTION_EVENT, { items: [item("t1"), item("t2", "question")] });
    expect(attention.setBadge).toHaveBeenLastCalledWith(2);
    act(() => { preferences.setValue(NOTIFICATIONS_EXTENSION_ID, "mode", "off"); });
    expect(attention.setBadge).toHaveBeenLastCalledWith(0);
  });

  it("in a focused window on another thread, toasts instead when asked to, and plays the chosen sound", async () => {
    const oscillators: Array<{ frequency: { value: number } }> = [];
    class FakeAudio {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = async () => undefined;
      createOscillator() { const node = { type: "", frequency: { value: 0 }, connect: (next: unknown) => next, start: () => undefined, stop: () => undefined }; oscillators.push(node); return node; }
      createGain() { return { gain: { value: 1, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: (next: unknown) => next }; }
      createBiquadFilter() { return { type: "", frequency: { value: 0 }, connect: (next: unknown) => next }; }
    }
    vi.stubGlobal("AudioContext", FakeAudio);
    const { push, preferences, attention, actions, toasts, clientKey } = setup();
    await flush();
    act(() => {
      preferences.setValue(NOTIFICATIONS_EXTENSION_ID, "mode", "both");
      preferences.setValue(NOTIFICATIONS_EXTENSION_ID, "sound", "ping");
      preferences.setOption(NOTIFICATIONS_EXTENSION_ID, "toasts", true);
    });
    focused = true;
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [item("t1", "question")] });
    expect(attention.notify).not.toHaveBeenCalled();
    // A question plays Ping's rising phrase, which ends on C7.
    expect(oscillators.map((node) => node.frequency.value)).toContain(2093);
    // On core's stack, one row: the thread's title and what it waits for, with the question mark.
    const toast = await screen.findByText("Thread t1 · Waiting for your answer");
    expect(toast.closest(".toast-item")?.getAttribute("data-type")).toBe("question");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/t1.jsonl");
    await waitFor(() => expect(screen.queryByText("Thread t1 · Waiting for your answer")).toBeNull());
    expect(toasts.getToasts()).toEqual([]);
    // Without the toast the same window gets the system notification.
    act(() => { preferences.setOption(NOTIFICATIONS_EXTENSION_ID, "toasts", false); });
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [item("t1")] });
    expect(attention.notify).toHaveBeenCalledOnce();
  });

  it("names a thread made after the window connected by the title the rail shows, and keeps one toast per thread", async () => {
    const { push, preferences, toasts, threads, clientKey } = setup();
    await flush();
    act(() => { preferences.setOption(NOTIFICATIONS_EXTENSION_ID, "toasts", true); });
    focused = true;
    // Only the window's live index knows the new thread; the host has no title for it.
    act(() => { threads.applyThreadIndex({ projects: [], sessions: [session("t1"), session("t2")] }); });
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [{ threadId: "t2", reason: "completed", at: 1 }] });
    expect(await screen.findByText("Thread t2 · Finished")).toBeTruthy();
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [{ threadId: "t2", reason: "failed", at: 2 }] });
    expect(await screen.findByText("Thread t2 · Stopped with an error")).toBeTruthy();
    expect(toasts.getToasts().map((toast) => toast.type)).toEqual(["error"]);
  });

  it("speaks about the thread on screen only when asked to", async () => {
    const { push, preferences, attention, clientKey } = setup();
    await flush();
    focused = true;
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [item("t1")], seen: true });
    expect(attention.notify).not.toHaveBeenCalled();
    act(() => { preferences.setOption(NOTIFICATIONS_EXTENSION_ID, "when-focused", true); });
    push(NOTIFY_EVENT, { clientKey: clientKey(), items: [item("t1")], seen: true });
    expect(attention.notify).toHaveBeenCalledOnce();
  });

  it("reports again when the host asks, and says goodbye when it stops", async () => {
    const { push, presences, registry, invoke, attention } = setup();
    await flush();
    const before = presences().length;
    push(PRESENCE_REQUEST_EVENT);
    expect(presences().length).toBe(before + 1);
    push(ATTENTION_EVENT, { items: [item("t1")] });
    registry.deactivate(NOTIFICATIONS_EXTENSION_ID);
    expect(invoke.mock.calls.at(-1)?.[1]).toBe("leave");
    expect(attention.setBadge).toHaveBeenLastCalledWith(0);
  });

  it("offers its choices on a settings page of its own", async () => {
    const { registry, preferences, attention } = setup();
    const page = registry.getSettingsPages().find((entry) => entry.id === "notifications.settings")!;
    const props: SettingsPageProps = { onNotify: vi.fn() };
    render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
    for (const title of ["Tell me with", "Sound", "Show a toast instead", "Also for the thread on screen"]) expect(screen.getByRole("heading", { level: 3, name: title })).toBeTruthy();
    const modes = screen.getByRole("radiogroup", { name: "Tell me with" });
    expect(within(modes).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Off", "Notification", "Sound", "Both"]);
    fireEvent.click(within(modes).getByRole("radio", { name: "Both" }));
    expect(preferences.value(NOTIFICATIONS_EXTENSION_ID, "mode")).toBe("both");
    expect(attention.requestPermission).toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Sound" })).getByRole("radio", { name: "Ping" }));
    expect(preferences.value(NOTIFICATIONS_EXTENSION_ID, "sound")).toBe("ping");
    expect(screen.getAllByRole("button", { name: /^Play \w+ for a / }).map((button) => button.textContent)).toEqual(["Done", "Needs you"]);
    fireEvent.click(screen.getByRole("switch", { name: "Show a toast instead" }));
    expect(preferences.optionValue(NOTIFICATIONS_EXTENSION_ID, "toasts", false)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send a test notification" }));
    expect(attention.notify).toHaveBeenCalledWith(expect.objectContaining({ tag: "tau.test" }));
  });

  it("names each row it lists for the search, and the page draws each one", () => {
    const { registry, preferences } = setup();
    const page = registry.getSettingsPages().find((entry) => entry.id === "notifications.settings")!;
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    expect(page.rows?.length).toBeGreaterThan(0);
    for (const row of page.rows ?? []) expect(document.getElementById(row.id), row.id).toBeTruthy();
  });
});
