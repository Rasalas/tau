// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiPromptAttachment, UiSkillDraft } from "../shared/contracts";
import { createNewThreadRequestId } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { HostRequestError } from "../workbench/host-connection";
import { ComposerScopeStore, createDraftKey } from "../workbench/composer-scope-store";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import { createMemoryStorage } from "../workbench/client-storage";
import { draftKey, type NewThreadDraft } from "../workbench/draft-store";
import { HostSessionState } from "../workbench/host-session-state";
import { NewThreadDeliveryCoordinator, type NewThreadDeliveryPort } from "../workbench/new-thread-delivery";
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
  hostSessionApplied?: boolean;
  slash?: ReturnType<ExtensionRegistry["findSlashCommand"]>;
  prepareNewThread?: ExtensionRegistry["prepareNewThread"];
  claimNewThread?: ExtensionRegistry["claimNewThread"];
  newThreadRuntime?: string;
} = {}) {
  const client = createFakeHostClient(options.client);
  const view = new ThreadViewStore(options.snapshot ?? SESSION_SNAPSHOT);
  const threads = new ThreadStore();
  threads.setActiveThread((options.snapshot ?? SESSION_SNAPSHOT).sessionId);
  const scopes = new ComposerScopeStore();
  const hostSession = new HostSessionState();
  if (options.hostSessionApplied ?? true) hostSession.markApplied();
  const promptHooks = vi.fn(async (_event?: unknown) => undefined);
  const prepareNewThread = options.prepareNewThread ?? vi.fn(async () => undefined);
  const registry = {
    findSlashCommand: () => options.slash,
    notifyPromptSubmitted: promptHooks,
    prepareNewThread,
    claimNewThread: options.claimNewThread ?? vi.fn(async () => false),
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
  const actions = {
    notify: vi.fn(),
    runShellAction: vi.fn(async () => ({ output: "output", exitCode: 0, cancelled: false, truncated: false })),
  } as unknown as WorkbenchActions;
  const storage = createMemoryStorage();
  const newThread = {
    current: () => state.pending,
    set: (draft: NewThreadDraft | undefined) => { state.pending = draft; },
    update: (change: (current: NewThreadDraft | undefined) => NewThreadDraft | undefined) => { state.pending = change(state.pending); },
    requestId: () => state.requestId,
    isCurrent: (pending: NewThreadDraft) => state.pending?.draftId === pending.draftId,
    markAwaitingPromotion: () => true,
    promoteFromUserMessage: (_sessionId: string, projectPath: string) => {
      const pending = state.pending;
      if (!pending || pending.projectPath !== projectPath) return undefined;
      const scope = draftKey(undefined, pending);
      state.pending = undefined;
      return scope;
    },
  };
  const turn = {
    current: () => state.turn,
    set: (next: TranscriptTurnStart | undefined, expectedTurnId?: string) => {
      if (expectedTurnId !== undefined && state.turn?.turnId !== expectedTurnId) return false;
      state.turn = next;
      return true;
    },
  };
  const delivery = new NewThreadDeliveryCoordinator({
    projection: { view, threads, scopes, storage, newThread, turn },
    notification: {
      notifyPromptSubmitted: (event) => {
        void promptHooks(event);
        return true;
      },
    },
  });
  const deliveryPort: NewThreadDeliveryPort = {
    register: (clientMessageId, recovery) => delivery.register(clientMessageId, recovery),
    hasRecovery: delivery.hasRecovery,
    recoveryScope: delivery.recoveryScope,
    markWithoutUserTurn: delivery.markWithoutUserTurn,
    markIpcSettled: delivery.markIpcSettled,
    promoteReportedThread: (sessionId, message, requestId) => {
      const plan = delivery.promoteReportedThread(sessionId, message, requestId);
      if (plan.detail) host.applyHostUpdate(plan.detail);
      delivery.finishPromotion(plan);
      return plan.promoted;
    },
    promoteRecovery: (clientMessageId, sessionId, message) => {
      const plan = delivery.promoteRecovery(clientMessageId, sessionId, message);
      if (plan.detail) host.applyHostUpdate(plan.detail);
      delivery.finishPromotion(plan);
      return plan.promoted;
    },
    settleDelivery: (clientMessageId, sessionId, settlement) => {
      const plan = delivery.settleDeliveryPlan(clientMessageId, sessionId, settlement);
      if (plan.promotion?.detail) host.applyHostUpdate(plan.promotion.detail);
      if (plan.promotion?.promoted) delivery.finishPromotion(plan.promotion);
      return plan.handled;
    },
    detachPendingDelivery: delivery.detachPendingDelivery,
    release: delivery.release,
    rehomeDetached: delivery.rehomeDetached,
    notifyPromptSubmitted: delivery.notifyPromptSubmitted,
  };
  const ports: SubmissionControllerPorts = {
    client: () => client,
    view,
    threads,
    scopes,
    registry,
    storage,
    preferences: (() => { const preferences = new PreferencesStore(); if (options.newThreadRuntime) preferences.setNewThreadRuntime(options.newThreadRuntime); return preferences; })(),
    hostSession,
    notify: (message) => view.setNotice(message),
    actions: () => actions,
    delivery: deliveryPort,
    newThread,
    turn,
    host,
    enqueueFollowUp: async (threadId, item) => { followUps.push({ threadId, text: item.text }); },
  };
  const submission = new SubmissionController(ports);
  return { submission, ports, client, view, threads, scopes, state, followUps, host, promptHooks, actions, hostSession };
}

const sentPrompts = (client: ReturnType<typeof createFakeHostClient>) =>
  client.calls.filter((call) => call.method === "sendPrompt");

beforeEach(() => {
  try {
    window.localStorage?.clear?.();
  } catch {
    // localStorage might not be initialized in Node 22 without storage file
  }
});

describe("issue 13 client refusal presentation", () => {
  // Client-only contract test. The host refusal is injected here; this does not
  // reproduce or identify the phone incident's admission cause.
  it("retains a refused draft and retries once, without counting the refusal as accepted", async () => {
    const reason = "Wait for compaction to finish and retry.";
    let attempts = 0;
    const h = harness({ client: { sendPrompt: async () => {
      if (++attempts === 1) throw new HostRequestError(reason, "runtime-refused");
    } } });
    const text = "text-only follow-up";
    const attachments = [{ kind: "image" as const, name: "fixture.png", mimeType: "image/png", data: "fixture", size: 7, id: 1, previewUrl: "fixture://image" }];
    const scope = createDraftKey(draftKey("session"));
    h.scopes.setDraft(scope, text);
    h.scopes.setAttachments(scope, attachments);
    await expect(h.submission.submit({ text, attachments })).resolves.toEqual({ accepted: false, message: reason });
    expect(h.view.getOptimisticMessages()).toEqual([]);
    expect(h.state.turn).toBeUndefined();
    expect(h.promptHooks).not.toHaveBeenCalled();
    expect(h.scopes.getSnapshot(scope).draft).toBe(text);
    expect(h.scopes.getSnapshot(scope).attachments).toEqual(attachments);
    await expect(h.submission.submit({ text, attachments })).resolves.toEqual({ accepted: true });
    expect(attempts).toBe(2);
    expect(h.promptHooks).toHaveBeenCalledOnce();
    expect(h.view.getOptimisticMessages()).toHaveLength(1);
    expect(sentPrompts(h.client).map((call) => call.args.slice(0, 2))).toEqual([[text, attachments], [text, attachments]]);
  });

  it("normalizes a preparation refusal in both the inline result and toast", async () => {
    const reason = "This skill is unavailable.";
    const h = harness({ client: { preparePrompt: async () => { throw new HostRequestError(reason, "runtime-refused"); } } });
    await expect(h.submission.submit({ text: "/skill:missing" })).resolves.toEqual({ accepted: false, message: reason });
    expect(h.view.getNotice()?.message).toBe(reason);
    expect(sentPrompts(h.client)).toHaveLength(0);
    expect(h.view.getOptimisticMessages()).toEqual([]);
    expect(h.state.turn).toBeUndefined();
    expect(h.promptHooks).not.toHaveBeenCalled();
  });

  it("leaves a newer draft and turn alone when an old prompt is refused after navigation", async () => {
    let refuse!: (error: unknown) => void;
    const h = harness({ client: { sendPrompt: () => new Promise<void>((_resolve, reject) => { refuse = reject; }) } });
    const oldSubmission = h.submission.submit({ text: "old follow-up" });
    await vi.waitFor(() => expect(sentPrompts(h.client)).toHaveLength(1));

    h.view.setSnapshot({ ...SESSION_SNAPSHOT, sessionId: "other" });
    const newerScope = createDraftKey(draftKey("other"));
    h.scopes.setDraft(newerScope, "newer draft");
    const newerTurn = { ...h.state.turn!, turnId: "newer-turn", sessionId: "other" };
    h.state.turn = newerTurn;
    h.view.setNotice("Newer notice");
    refuse(new HostRequestError("The old prompt was refused.", "runtime-refused"));

    await expect(oldSubmission).resolves.toEqual({ accepted: false, message: "The old prompt was refused." });
    expect(h.scopes.getSnapshot(newerScope).draft).toBe("newer draft");
    expect(h.state.turn).toBe(newerTurn);
    expect(h.view.getNotice()?.message).toBe("Newer notice");
    expect(h.view.getOptimisticMessages()).toEqual([]);
    expect(h.promptHooks).not.toHaveBeenCalled();
    expect(sentPrompts(h.client)).toHaveLength(1);
    expect(h.followUps).toEqual([]);
  });

  it("shows a useful refusal without an internal exception class name in the toast", async () => {
    const reason = "Wait for compaction to finish and retry.";
    const h = harness({ client: { sendPrompt: async () => { throw new HostRequestError(reason, "runtime-refused"); } } });
    await expect(h.submission.submit({ text: "text-only follow-up" })).resolves.toEqual({ accepted: false, message: reason });
    expect(h.view.getNotice()?.message).toBe(reason);
  });
});

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

  it("reads host confirmation at each preflight and steer call site", async () => {
    const { submission, client, threads, hostSession } = harness({ hostSessionApplied: false });
    threads.setThreadRunning("session", true);

    await submission.submit({ text: "cold steer", delivery: "steer" });

    expect(client.calls.find((call) => call.method === "preparePrompt")?.args[1]).toBeUndefined();
    expect(client.calls.find((call) => call.method === "steer")?.args[2]).toBeUndefined();

    hostSession.markApplied();
    await submission.submit({ text: "warm steer", delivery: "steer" });

    expect(client.calls.filter((call) => call.method === "preparePrompt")[1]?.args[1]).toBe("session");
    expect(client.calls.filter((call) => call.method === "steer")[1]?.args[2]).toBe("session");
  });

  it("re-reads host confirmation after an awaited preflight", async () => {
    let hostSession: HostSessionState | undefined;
    const preparePrompt = vi.fn(async () => {
      hostSession?.markApplied();
      return undefined;
    });
    const harnessed = harness({ hostSessionApplied: false, client: { preparePrompt } });
    hostSession = harnessed.hostSession;

    await harnessed.submission.submit({ text: "confirm during preflight" });

    expect(preparePrompt).toHaveBeenCalledWith("confirm during preflight", undefined, undefined, undefined);
    expect(sentPrompts(harnessed.client)[0]?.args[2]).toBe("session");
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
    // The new thread has no model or runtime of its own yet; the one on screen belongs to the thread that was open.
    const [event] = promptHooks.mock.calls[0] as unknown as [{ snapshot?: { sessionId?: string; model?: unknown; backendKind?: unknown; messages: unknown[] } }];
    expect(event.snapshot).toMatchObject({ sessionId: "created", messages: [] });
    expect(event.snapshot?.model).toBeUndefined();
    expect(event.snapshot?.backendKind).toBeUndefined();
  });

  it("uses the model shown on a fresh draft when no explicit draft model was chosen", async () => {
    const deepseek = { provider: "opencode-go", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" };
    const { submission, client } = harness({
      pending: DRAFT,
      snapshot: { ...SESSION_SNAPSHOT, backendKind: "pi", model: deepseek, models: [deepseek] },
      client: {
        newSession: async () => ({ version: 1, submission: { accepted: true }, sessionId: "created", updates: [] }),
      },
    });

    await submission.submit({ text: "first message" });

    expect(client.calls.find((call) => call.method === "newSession")?.args[5]).toEqual({
      model: { provider: "opencode-go", id: "deepseek-flash" },
    });
  });

  it("starts a thread on another runtime with the model, level and mode the draft chose for it, and never with a Pi choice", async () => {
    const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex@work", label: "Codex · Work", modes: ["plan"] }];
    const created = async () => ({ version: 1 as const, submission: { accepted: true as const }, sessionId: "created", updates: [] });
    const chosen = harness({
      pending: { ...DRAFT, model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, thinkingLevel: "low", selectionRuntime: "codex@work", mode: "plan" },
      snapshot: { ...SESSION_SNAPSHOT, backendKind: "pi", runtimeBackends: backends } as HostSnapshot,
      newThreadRuntime: "codex@work",
      client: { newSession: created },
    });
    await chosen.submission.submit({ text: "one word" });
    expect(chosen.client.calls.find((call) => call.method === "newSession")?.args[5]).toEqual({ model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "low", mode: "plan" });

    // A model picked for Pi stays with Pi: the Codex thread starts on its own default.
    const piChoice = harness({
      pending: { ...DRAFT, model: { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" }, thinkingLevel: "high" },
      snapshot: { ...SESSION_SNAPSHOT, backendKind: "pi", runtimeBackends: backends } as HostSnapshot,
      newThreadRuntime: "codex@work",
      client: { newSession: created },
    });
    await piChoice.submission.submit({ text: "one word" });
    expect(piChoice.client.calls.find((call) => call.method === "newSession")?.args[5]).toBeUndefined();

    // A mode the runtime does not offer stays with the draft.
    const noPlan = harness({
      pending: { ...DRAFT, mode: "plan" },
      snapshot: { ...SESSION_SNAPSHOT, backendKind: "pi", model: undefined, runtimeBackends: backends } as HostSnapshot,
      client: { newSession: created },
    });
    await noPlan.submission.submit({ text: "one word" });
    expect(noPlan.client.calls.find((call) => call.method === "newSession")?.args[5]).toBeUndefined();
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

  it("lets an extension take a new thread's first prompt, and keeps the draft for the next one", async () => {
    const claimNewThread = vi.fn(async (event: { alternate: boolean; runtime: string; model?: unknown; attachments: number }) => event.alternate) as unknown as ExtensionRegistry["claimNewThread"];
    const snapshot = { ...SESSION_SNAPSHOT, model: { provider: "openai", id: "gpt-5.6-luna", name: "Luna" } } as HostSnapshot;
    const { submission, client, state, view } = harness({ pending: DRAFT, claimNewThread, snapshot });

    await expect(submission.submit({ text: "in the background", delivery: "alternate" })).resolves.toEqual({ accepted: true });
    expect(claimNewThread).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "in the background",
      projectPath: "/project",
      alternate: true,
      runtime: "pi",
      model: expect.objectContaining({ provider: "openai", id: "gpt-5.6-luna" }),
      attachments: 0,
    }), expect.anything());
    expect(client.calls.some((call) => call.method === "newSession" || call.method === "preparePrompt")).toBe(false);
    expect(state.pending?.draftId).toBe(DRAFT.draftId);
    expect(view.getOptimisticMessages()).toEqual([]);

    // Unclaimed, the modifier is a plain send.
    const plain = harness({ pending: DRAFT, snapshot, client: { newSession: async () => ({ version: 1, submission: { accepted: true }, sessionId: "created", updates: [] }) } });
    await plain.submission.submit({ text: "on screen" });
    expect(plain.client.calls.some((call) => call.method === "newSession")).toBe(true);
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
    const { ports, client, hostSession } = harness({ hostSessionApplied: false });
    const cold = new SubmissionController(ports);

    await cold.submit({ text: "before the host answers" });
    expect(sentPrompts(client)[0].args[2]).toBeUndefined();
    expect(client.calls.find((call) => call.method === "preparePrompt")?.args[1]).toBeUndefined();

    hostSession.markApplied();
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

  it("executes shell commands starting with ! and !!", async () => {
    const { submission, actions } = harness();

    // 1. !cmd runs with context included (includeInContext = true)
    const resultContext = await submission.submit({ text: "!git status" });
    expect(resultContext).toEqual({ accepted: true });
    expect(actions.runShellAction).toHaveBeenCalledWith("git status", true);

    // 2. !!cmd runs excluded from context (includeInContext = false)
    const resultSilent = await submission.submit({ text: "!!echo silent" });
    expect(resultSilent).toEqual({ accepted: true });
    expect(actions.runShellAction).toHaveBeenCalledWith("echo silent", false);
  });
  it("keeps a claimed launch failure out of ordinary new-thread creation", async () => {
    const claimNewThread = vi.fn(async () => { throw new Error("Started 1 of 2 threads"); });
    const { submission, client } = harness({ pending: DRAFT, claimNewThread });
    await expect(submission.submit({ text: "fix it", delivery: "alternate" })).resolves.toEqual({ accepted: false, message: "Started 1 of 2 threads" });
    expect(client.calls.some((call) => call.method === "newSession" || call.method === "sendPrompt" || call.method === "preparePrompt")).toBe(false);
  });

});
