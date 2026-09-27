// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiAnswer, ExtensionUiPrompt, HostEvent } from "../shared/contracts";
import { ExtensionUiCoordinator } from "../main/extension-ui-coordinator";
import { applyHostEvent, type HostEventTargets } from "./host-events";
import type { HostClient } from "./host-client";
import type { HostConnectionState } from "./host-connection";
import { followOpenPrompts } from "./open-prompts";
import { ThreadStore } from "./thread-store";
import { threadSupervisionStatus } from "./thread-supervision";
import { ThreadViewStore } from "./thread-view-store";
import { PreferencesStore } from "../renderer/preferences";

/**
 * One host, two clients (a desktop window and a tablet), wired the way the
 * workbench wires them: host events through `applyHostEvent`, the rail's
 * waiting state from the open questions, answers through the host client.
 */
function world() {
  const clients: Client[] = [];
  const host = new ExtensionUiCoordinator(
    (_thread, event) => { for (const each of clients) each.receive(event); },
    () => undefined,
  );

  function client(shows: string): Client {
    const threadStore = new ThreadStore();
    threadStore.setActiveThread(shows);
    const view = new ThreadViewStore();
    view.beginThread(shows);
    view.subscribeToPrompts(() => threadStore.setWaiting(view.getUiPrompts().map((prompt) => prompt.sessionId)));
    const targets = {
      registry: { dispatchWorkbenchEvent: vi.fn(), dispatchExtensionEvent: vi.fn(), interceptPrompt: () => undefined },
      threadStore,
      view,
      preferences: new PreferencesStore(),
      submission: { hasRecovery: () => false, recoveryScope: () => undefined, markWithoutUserTurn: vi.fn(), promoteRecovery: () => true, settleDelivery: () => true },
      currentDraftKey: () => undefined,
      transcriptTurnStart: () => undefined,
      setTranscriptTurnStart: vi.fn(),
      applyHostUpdate: vi.fn(),
      setUpdateReady: vi.fn(),
      applyThreadIndex: vi.fn(),
      syncDesktopExtensions: vi.fn(),
    } as unknown as HostEventTargets;
    let online = true;
    let state: HostConnectionState = "connected";
    const stateListeners = new Set<(state: HostConnectionState) => void>();
    const hostClient = {
      answerExtensionUi: async (id: string, answer: ExtensionUiAnswer) => host.answer(id, answer),
      syncExtensionUi: async () => host.replay(),
      getConnectionState: () => state,
      onConnectionState: (listener: (next: HostConnectionState) => void) => {
        stateListeners.add(listener);
        return () => { stateListeners.delete(listener); };
      },
    } satisfies Pick<HostClient, "answerExtensionUi" | "syncExtensionUi" | "getConnectionState" | "onConnectionState">;
    const setState = (next: HostConnectionState) => {
      state = next;
      for (const listener of stateListeners) listener(next);
    };
    const entry: Client = {
      receive: (event) => { if (online) applyHostEvent(event, targets); },
      prompts: () => view.getUiPrompts(),
      status: (threadId) => threadSupervisionStatus(threadId, threadStore.getActivity()),
      // What ThreadCommands.answerUiPrompt does: off the screen at once, then to the host.
      answer: async (id, answer) => {
        view.setUiPrompts((current) => current.filter((prompt) => prompt.id !== id));
        await hostClient.answerExtensionUi(id, answer);
      },
      disconnect: () => { online = false; setState("reconnecting"); },
      reconnect: () => { online = true; setState("connected"); },
      follow: () => followOpenPrompts(hostClient, view),
    };
    clients.push(entry);
    return entry;
  }

  return { host, client };
}

interface Client {
  receive(event: HostEvent): void;
  prompts(): readonly ExtensionUiPrompt[];
  status(threadId: string): string;
  answer(id: string, answer: ExtensionUiAnswer): Promise<void>;
  disconnect(): void;
  reconnect(): void;
  follow(): () => void;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const QUESTIONS: Array<{ name: string; prompt: ExtensionUiPrompt; answer: ExtensionUiAnswer }> = [
  { name: "a single choice", prompt: { id: "q-single", sessionId: "asking", kind: "select", title: "Which color?", options: ["Red", "Blue"] }, answer: { value: "Red" } },
  { name: "a choice answered in free text", prompt: { id: "q-typed", sessionId: "asking", kind: "select", title: "Which color?", options: ["Red", "Blue", "Type something."] }, answer: { value: "Green", typed: true } },
  { name: "a multiple choice", prompt: { id: "q-multi", sessionId: "asking", kind: "select", title: "Which colors?", options: ["Red", "Blue"], extras: { "tau.questionnaire": { multi: true } } }, answer: { value: "Red, Blue" } },
  { name: "a free-text question", prompt: { id: "q-text", sessionId: "asking", kind: "input", title: "Your name?" }, answer: { value: "Ada" } },
  { name: "an approval", prompt: { id: "q-approve", sessionId: "asking", kind: "confirm", title: "Run rm?", message: "rm -rf build" }, answer: { confirmed: true } },
];

describe("a question answered on one client", () => {
  it.each(QUESTIONS)("is gone on the other, which shows another thread: $name", async ({ prompt, answer }) => {
    const { host, client } = world();
    const desktop = client("elsewhere");
    const tablet = client("asking");

    const asked = host.ask(prompt);
    expect(desktop.status("asking")).toBe("waiting");
    expect(tablet.prompts().map((entry) => entry.id)).toEqual([prompt.id]);

    await tablet.answer(prompt.id, answer);

    await expect(asked).resolves.toBeDefined();
    expect(desktop.prompts()).toEqual([]);
    expect(desktop.status("asking")).toBe("done");
    expect(tablet.status("asking")).toBe("done");
  });

  it("is gone on a client that was away when it was answered, once it is back", async () => {
    const { host, client } = world();
    const desktop = client("elsewhere");
    const tablet = client("asking");
    const stop = desktop.follow();
    await settled();

    void host.ask(QUESTIONS[0].prompt);
    desktop.disconnect();
    await tablet.answer("q-single", { value: "Red" });
    void host.ask({ id: "q-next", sessionId: "asking", kind: "input", title: "Why red?" });
    expect(desktop.status("asking")).toBe("waiting");

    desktop.reconnect();
    await settled();

    expect(desktop.prompts().map((entry) => entry.id)).toEqual(["q-next"]);
    stop();
  });

  it("shows once on a client that syncs while it is open", async () => {
    const { host, client } = world();
    const desktop = client("asking");
    void host.ask(QUESTIONS[0].prompt);

    const stop = desktop.follow();
    await settled();

    expect(desktop.prompts().map((entry) => entry.id)).toEqual(["q-single"]);
    stop();
  });

  it("keeps a question asked while the sync was on its way", async () => {
    const view = new ThreadViewStore();
    const earlier: ExtensionUiPrompt = { id: "old", sessionId: "t", kind: "input", title: "Old?" };
    const later: ExtensionUiPrompt = { id: "new", sessionId: "t", kind: "input", title: "New?" };
    view.setUiPrompts([earlier]);
    let reply: (open: ExtensionUiPrompt[]) => void = () => undefined;
    const stop = followOpenPrompts({
      syncExtensionUi: () => new Promise((resolve) => { reply = resolve; }),
      getConnectionState: () => "connected",
      onConnectionState: () => () => undefined,
    }, view);

    view.setUiPrompts((current) => [...current, later]);
    reply([]);
    await settled();

    expect(view.getUiPrompts()).toEqual([later]);
    stop();
  });

  it("leaves a client alone whose host lists no open questions", async () => {
    const view = new ThreadViewStore();
    const prompt: ExtensionUiPrompt = { id: "p", sessionId: "t", kind: "input", title: "?" };
    view.setUiPrompts([prompt]);
    const stop = followOpenPrompts({
      syncExtensionUi: async () => undefined,
      getConnectionState: () => "connected",
      onConnectionState: () => () => undefined,
    }, view);
    await settled();

    expect(view.getUiPrompts()).toEqual([prompt]);
    stop();
  });
});

describe("the host's open questions", () => {
  it("list a question a runtime asks elsewhere until it is resolved", () => {
    const host = new ExtensionUiCoordinator(() => undefined, () => undefined);
    const elsewhere: ExtensionUiPrompt = { id: "bridge-await-t", sessionId: "t", kind: "select", title: "Pi asks", answerElsewhere: true };

    host.observe({ type: "extension-ui-prompt", sessionId: "t", prompt: elsewhere });
    expect(host.replay()).toEqual([elsewhere]);

    host.observe({ type: "extension-ui-resolved", sessionId: "t", id: elsewhere.id });
    expect(host.replay()).toEqual([]);
  });

  it("tell a decorator when its question is answered, cancelled or expires", async () => {
    const host = new ExtensionUiCoordinator(() => undefined, () => undefined);
    const done = vi.fn();
    host.addDecorator(() => done);

    const asked = host.ask({ id: "q", sessionId: "t", kind: "confirm", title: "Go?" });
    expect(done).not.toHaveBeenCalled();
    host.answer("q", { confirmed: true });
    await asked;
    expect(done).toHaveBeenCalledTimes(1);

    const cancelled = host.ask({ id: "q2", sessionId: "t", kind: "confirm", title: "Go?" });
    host.cancelFor("t");
    await cancelled;
    expect(done).toHaveBeenCalledTimes(2);
  });
});
