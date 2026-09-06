// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiPromptAttachment, UiSkillDraft } from "../shared/contracts";
import { createNewThreadRequestId } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { ComposerScopeStore, createDraftKey } from "../workbench/composer-scope-store";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import { createMemoryStorage } from "../workbench/client-storage";
import { draftKey, type NewThreadDraft } from "../workbench/draft-store";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { PreferencesStore } from "./preferences";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { ThreadStore } from "../workbench/thread-store";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { SubmissionController, type SubmissionControllerPorts } from "./submission-controller";

const SESSION_SNAPSHOT: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  allTools: [],
  extensionCount: 0,
  messages: [],
  isStreaming: false,
  activeTools: [],
};

const DRAFT: NewThreadDraft = { kind: "draft", draftId: "draft-1", projectPath: "/project", projectName: "project" };

function harness(options: {
  client?: Partial<HostClient>;
  snapshot?: HostSnapshot;
  pending?: NewThreadDraft;
  slash?: ReturnType<ExtensionRegistry["findSlashCommand"]>;
  prepareNewThread?: ExtensionRegistry["prepareNewThread"];
} = {}) {
  const client = createFakeHostClient(options.client);
  const view = new ThreadViewStore(options.snapshot ?? SESSION_SNAPSHOT);
  const threads = new ThreadStore();
  threads.setActiveThread((options.snapshot ?? SESSION_SNAPSHOT).sessionId);
  const scopes = new ComposerScopeStore();
  const promptHooks = vi.fn(async () => undefined);
  const prepareNewThread = options.prepareNewThread ?? vi.fn(async () => undefined);
  const registry = {
    findSlashCommand: () => options.slash,
    notifyPromptSubmitted: promptHooks,
    prepareNewThread,
  } as unknown as ExtensionRegistry;
  const state = {
    pending: options.pending,
    turn: undefined as TranscriptTurnStart | undefined,
    requestId: createNewThreadRequestId("request-1"),
  };
  const followUps: Array<{ threadId: string; text: string }> = [];
  const host = {
    applyHostUpdate: vi.fn(),
    applyActionResult: vi.fn(() => true),
    applyHostResult: vi.fn(),
    prepareThreadDetail: vi.fn(() => true),
  };
  const actions = { notify: vi.fn() } as unknown as WorkbenchActions;
  const ports: SubmissionControllerPorts = {
    client: () => client,
    view,
    threads,
    scopes,
    registry,
    storage: createMemoryStorage(),
    preferences: new PreferencesStore(),
    notify: (message) => view.setNotice(message),
    actions: () => actions,
    newThread: {
      current: () => state.pending,
      set: (draft) => { state.pending = draft; },
      update: (change) => { state.pending = change(state.pending); },
      requestId: () => state.requestId,
      isCurrent: (pending) => state.pending?.draftId === pending.draftId,
      markAwaitingPromotion: () => true,
      promoteFromUserMessage: (_sessionId, projectPath) => {
        const pending = state.pending;
        if (!pending || pending.projectPath !== projectPath) return undefined;
        const scope = draftKey(undefined, pending);
        state.pending = undefined;
        return scope;
      },
    },
    turn: {
      current: () => state.turn,
      set: (next, expectedTurnId) => {
        if (expectedTurnId !== undefined && state.turn?.turnId !== expectedTurnId) return false;
        state.turn = next;
        return true;
      },
    },
    host,
    enqueueFollowUp: (threadId, item) => { followUps.push({ threadId, text: item.text }); },
    onRecoveriesChanged: vi.fn(),
  };
  const submission = new SubmissionController(ports);
  submission.notifyHostSnapshot();
  return { submission, ports, client, view, threads, scopes, state, followUps, host, promptHooks };
}

const sentPrompts = (client: ReturnType<typeof createFakeHostClient>) =>
  client.calls.filter((call) => call.method === "sendPrompt");

beforeEach(() => { localStorage.clear(); });

describe("SubmissionController", () => {
  it("sends a plain prompt for the thread on screen and shows it at once", async () => {
    const { submission, client, view, state } = harness();

    const result = await submission.submit({ text: "hello " });

    expect(result).toEqual({ accepted: true });
    expect(sentPrompts(client)[0].args.slice(0, 3)).toEqual(["hello", [], "session"]);
    expect(view.getOptimisticMessages().map((entry) => entry.message.text)).toEqual(["hello"]);
    expect(state.turn?.text).toBe("hello");
  });

  it("steers the running thread instead of queueing when asked", async () => {
    const { submission, client, threads } = harness();
    threads.setThreadRunning("session", true);

    await submission.submit({ text: "instead do this", delivery: "steer" });

    expect(client.calls.some((call) => call.method === "steer")).toBe(true);
    expect(sentPrompts(client)).toHaveLength(0);
  });

  it("queues a message typed while the thread is running", async () => {
    const { submission, client, threads, followUps, view } = harness();
    threads.setThreadRunning("session", true);

    const result = await submission.submit({ text: "afterwards" });

    expect(result).toEqual({ accepted: true });
    expect(followUps).toEqual([{ threadId: "session", text: "afterwards" }]);
    expect(client.calls.some((call) => call.method === "preparePrompt")).toBe(false);
    expect(view.getOptimisticMessages()).toEqual([]);
  });

  it("runs a desktop slash command and never reaches the runtime", async () => {
    const run = vi.fn(async () => undefined);
    const { submission, client } = harness({
      slash: { command: { name: "demo", run } as never, args: "now" },
    });

    const result = await submission.submit({ text: "/demo now" });

    expect(result).toEqual({ accepted: true });
    expect(run).toHaveBeenCalledWith("now", expect.anything());
    expect(sentPrompts(client)).toHaveLength(0);
  });

  it("shows a skill by its visible text while sending the full instruction", async () => {
    const skillDraft: UiSkillDraft = { source: "skill", command: "/skill:review", name: "review", visibleText: "src" };
    const { submission, client, view } = harness();

    await submission.submit({ text: "/skill:review src", skillDraft });

    const [optimistic] = view.getOptimisticMessages();
    expect(optimistic.message.text).toBe("src");
    expect(optimistic.message.skill?.command).toBe("/skill:review");
    expect(sentPrompts(client)[0].args[0]).toBe("/skill:review src");
    expect(client.calls.find((call) => call.method === "preparePrompt")?.args[2]).toBe(skillDraft);
  });

  it("keeps the composer's draft when the host rejects the prepared prompt", async () => {
    const { submission, client, view } = harness({
      client: { preparePrompt: async () => { throw new Error("Unknown skill"); } },
    });

    const result = await submission.submit({ text: "/skill:missing" });

    expect(result.accepted).toBe(false);
    expect(view.getNotice()?.message).toContain("Unknown skill");
    expect(sentPrompts(client)).toHaveLength(0);
    expect(view.getOptimisticMessages()).toEqual([]);
  });

  it("creates a thread from a start-screen draft and commits it when the host settles", async () => {
    const { submission, client, scopes, state, view, promptHooks } = harness({
      pending: DRAFT,
      client: {
        newSession: async () => ({
          version: 1,
          submission: { accepted: true },
          sessionId: "created",
          updates: [{
            version: 1,
            type: "thread-detail",
            detail: { sessionId: "created", messages: [], isStreaming: true, activeTools: [] },
          }],
        }),
      },
    });
    const draftScope = createDraftKey(draftKey(undefined, DRAFT));
    scopes.setDraft(draftScope, "first message");

    const result = await submission.submit({ text: "first message" });

    expect(result).toEqual({ accepted: true });
    expect(client.calls.find((call) => call.method === "newSession")?.args[2]).toBe("/project");
    // The runtime exists, but the message is only delivered once the host says so.
    expect(view.getOptimisticMessages()[0].scope).toBe("session:created");
    expect(state.pending?.draftId).toBe(DRAFT.draftId);
    expect(promptHooks).not.toHaveBeenCalled();

    const clientMessageId = view.getOptimisticMessages()[0].message.clientMessageId!;
    expect(submission.settleDelivery(clientMessageId, "created", { accepted: true })).toBe(true);

    expect(state.pending).toBeUndefined();
    expect(scopes.getSnapshot(createDraftKey(draftKey("created"))).draft).toBe("first message");
    expect(promptHooks).toHaveBeenCalledTimes(1);
  });

  it("sends a new thread's first prompt to the workspace a gate named, and stays put when none does", async () => {
    const prepared: string[] = [];
    const prepareNewThread = vi.fn(async (event: { prompt: string; preparing(message: string): void }) => {
      event.preparing("Setting up worktree…");
      return { workspace: { workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix-queue" } };
    }) as unknown as ExtensionRegistry["prepareNewThread"];
    const { submission, state, view } = harness({
      pending: DRAFT,
      prepareNewThread,
      client: {
        newSession: async (...args: unknown[]) => {
          prepared.push(String(args[2]));
          return { version: 1, submission: { accepted: true }, sessionId: "created", updates: [] };
        },
      } as Partial<HostClient>,
    });

    await submission.submit({ text: "fix the queue" });

    expect(prepared).toEqual(["ws1_worktree"]);
    expect(state.pending?.projectPath).toBe("/project-worktrees/fix-queue");
    // The line the gate showed while it worked is gone once the thread starts.
    expect(view.getOptimisticMessages().some((entry) => entry.message.role === "notice")).toBe(false);

    const untouched = harness({ pending: DRAFT, client: { newSession: async () => ({ version: 1, submission: { accepted: true }, sessionId: "created2", updates: [] }) } });
    await untouched.submission.submit({ text: "fix the queue" });
    expect(untouched.client.calls.find((call) => call.method === "newSession")?.args[2]).toBe("/project");
  });

  it("puts a rejected first message back into the draft it came from", async () => {
    const { submission, scopes, state, view } = harness({
      pending: DRAFT,
      client: {
        newSession: async () => ({ version: 1, submission: { accepted: true }, sessionId: "created", updates: [] }),
      },
    });

    await submission.submit({ text: "first message" });
    const clientMessageId = view.getOptimisticMessages()[0].message.clientMessageId!;

    // The host reports the refusal after the call that created the runtime.
    expect(submission.settleDelivery(clientMessageId, "created", {
      accepted: false,
      message: "The runtime rejected the message.",
    })).toBe(true);

    expect(state.pending?.draftId).toBe(DRAFT.draftId);
    expect(scopes.getSnapshot(createDraftKey(draftKey(undefined, state.pending!))).draft).toBe("first message");
  });

  it("drops the optimistic row once the host echoes the same message", async () => {
    const { submission, view } = harness();

    await submission.submit({ text: "hello" });
    const optimistic = view.getOptimisticMessages()[0].message;
    view.dispatch({
      type: "user-message",
      sessionId: "session",
      message: {
        id: "entry-1",
        role: "user",
        text: "hello",
        timestamp: optimistic.timestamp,
        clientTurnId: optimistic.clientTurnId,
        clientMessageId: optimistic.clientMessageId,
      },
    });

    expect(view.getOptimisticMessages()).toEqual([]);
    expect(view.getTranscript().messages).toHaveLength(1);
  });

  it("names no thread until the host has published one for this run", async () => {
    // The bootstrap cache paints the previous run's thread; a cold host has
    // never opened it, so its id must not reach the first prompt.
    const { ports, client } = harness();
    const cold = new SubmissionController(ports);

    await cold.submit({ text: "before the host answers" });
    expect(sentPrompts(client)[0].args[2]).toBeUndefined();
    expect(client.calls.find((call) => call.method === "preparePrompt")?.args[1]).toBeUndefined();

    cold.notifyHostSnapshot();
    await cold.submit({ text: "after the host answers" });
    expect(sentPrompts(client)[1].args[2]).toBe("session");
  });

  it("reports an attachment-only prompt and refuses an empty one", async () => {
    const attachment: UiPromptAttachment = { kind: "image", name: "shot.png", mimeType: "image/png", data: "AAAA", size: 4 };
    const { submission, view, client } = harness();

    expect(await submission.submit({ text: "   " })).toEqual({
      accepted: false,
      message: "Enter a message or attach an image.",
    });

    await submission.submit({ text: "", attachments: [attachment] });
    expect(view.getOptimisticMessages()[0].message.text).toBe("Attached shot.png");
    expect(sentPrompts(client)[0].args[1]).toEqual([attachment]);
  });
});
