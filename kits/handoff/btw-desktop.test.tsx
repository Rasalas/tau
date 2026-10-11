// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageTabHandle, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createHandoffExtension } from "./desktop.js";
import { BTW_EVENT, BTW_STAGE_TAB, HANDOFF_EXTENSION_ID, type BtwChat } from "./protocol.js";
import { HandoffStore } from "./store.js";

afterEach(cleanup);

const chat = (overrides: Partial<BtwChat> = {}): BtwChat => ({
  id: "c1", threadId: "t1", question: "What is slow?", answer: "", status: "working", backend: "pi", entryId: "e9", createdAt: 1, updatedAt: 1, ...overrides,
});

function actionsFor(overrides: Record<string, unknown> = {}): WorkbenchActions {
  return {
    activeThread: () => ({ sessionId: "t1", workspaceId: "ws1", cwd: "/project", backendKind: "pi", draftPending: false }),
    notify: vi.fn(),
    openStageTab: vi.fn(() => "tab-1"),
    newSession: vi.fn(),
    composerDraft: () => "",
    setComposerDraft: vi.fn(),
    focusComposer: vi.fn(),
    copyText: vi.fn(async () => undefined),
    askFork: vi.fn(async () => true),
    ...overrides,
  } as unknown as WorkbenchActions;
}

function setup(answers: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (_extension: string, command: string, _input?: unknown) => {
    if (command in answers) return typeof answers[command] === "function" ? (answers[command] as () => unknown)() : answers[command];
    if (command === "state") return { links: [] };
    if (command === "btw-ask") return chat();
    if (command === "create-transfer") return { transferId: "x1", native: false, sourceTitle: "Parser work" };
    return undefined;
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(createHandoffExtension(new HandoffStore()));
  const slash = registry.getSlashCommands().find((entry) => entry.name === "btw")!;
  const command = registry.getCommands().find((entry) => entry.id === "handoff.btw")!;
  const kind = registry.getStageTabKind(BTW_STAGE_TAB)!;
  const handle = { id: "tab-1", setTitle: vi.fn(), setDirty: vi.fn(), onClose: vi.fn(() => () => undefined) } as unknown as StageTabHandle;
  const draw = (actions: WorkbenchActions, params: Record<string, unknown> = { chatId: "c1" }) => render(<>{kind.render(params, handle, actions)}</>);
  const push = (payload: unknown) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: HANDOFF_EXTENSION_ID, name: BTW_EVENT, payload }));
  return { invoke, registry, slash, command, kind, handle, draw, push };
}

describe("/btw", () => {
  it("is in the slash menu and the thread menu, and its tab kind is registered", () => {
    const { slash, command, kind } = setup();
    expect(slash.argumentHint).toBe("<question>");
    expect(command).toMatchObject({ label: "Ask a side question…", surfaces: ["thread-title"] });
    expect(kind.title({ chatId: "c1", title: "What is slow?" })).toBe("What is slow?");
  });

  it("asks the thread on screen and opens the question's own tab, keyed by its id", async () => {
    const { invoke, slash } = setup();
    const actions = actionsFor();
    expect(await slash.run("  What is slow?  ", actions)).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "btw-ask", { threadId: "t1", question: "What is slow?" });
    expect(actions.openStageTab).toHaveBeenCalledWith(BTW_STAGE_TAB, { chatId: "c1", title: "What is slow?" }, { key: "c1" });
  });

  it("says what is missing instead of asking", async () => {
    const { invoke, slash } = setup();
    expect(await slash.run("   ", actionsFor())).toBe("Add a question after /btw.");
    const draft = actionsFor({ activeThread: () => ({ draftPending: true }) });
    expect(await slash.run("Why?", draft)).toMatch(/Send a message first/u);
    expect(invoke.mock.calls.some(([, name]) => name === "btw-ask")).toBe(false);
    const refused = setup({ "btw-ask": () => { throw new Error("Wait for an earlier side question to be answered first."); } });
    expect(await refused.slash.run("Why?", actionsFor())).toBe("Wait for an earlier side question to be answered first.");
  });

  it("starts the command in the composer, or asks what is already typed there", async () => {
    const { invoke, command } = setup();
    const empty = actionsFor();
    await command.run(empty);
    expect(empty.setComposerDraft).toHaveBeenCalledWith("/btw ");
    expect(empty.focusComposer).toHaveBeenCalled();

    const typed = actionsFor({ composerDraft: () => "  Is the cache safe?  " });
    await command.run(typed);
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "btw-ask", { threadId: "t1", question: "Is the cache safe?" });
    expect(typed.setComposerDraft).toHaveBeenCalledWith("");
  });
});

describe("a side question's tab", () => {
  it("loads the question after a reload, follows its answer as it streams, and enables the fork once it is done", async () => {
    const { draw, push, invoke } = setup({ "btw-get": chat() });
    const actions = actionsFor();
    draw(actions);
    expect((await screen.findByRole("region", { name: "Side question" })).textContent).toContain("What is slow?");
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "btw-get", { chatId: "c1" });
    expect(screen.getByText("Working…")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Continue as side task/u }) as HTMLButtonElement).disabled).toBe(true);

    push(chat({ answer: "It is the" }));
    expect(screen.getByRole("region").textContent).toContain("It is the");
    expect(screen.queryByText("Working…")).toBeNull();
    push(chat({ answer: "It is the bundler.", status: "done", model: "openai-codex/gpt-5.6-sol" }));
    expect(screen.getByRole("region").textContent).toContain("It is the bundler.");
    expect(screen.getByRole("region").textContent).toContain("gpt-5.6-sol");
    expect((screen.getByRole("button", { name: /Continue as side task/u }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Copy/u }));
    expect(actions.copyText).toHaveBeenCalledWith("It is the bundler.");
  });

  it("forks the thread at the question's point with the question and its answer as the task", async () => {
    const { draw, push } = setup({ "btw-get": chat({ answer: "The bundler.", status: "done" }) });
    const actions = actionsFor();
    draw(actions);
    await screen.findByRole("region");
    push(chat({ answer: "The bundler.", status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue as side task/u }));
    await vi.waitFor(() => expect(actions.askFork).toHaveBeenCalledTimes(1));
    const request = (actions.askFork as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { entryId: string; prompt: string };
    expect(request.entryId).toBe("e9");
    expect(request.prompt.startsWith("What is slow?\n\n<btw_context>\n")).toBe(true);
    expect(request.prompt).toContain("The bundler.");
  });

  it("continues on a new thread with a summary where the runtime cannot fork", async () => {
    const { draw, push, invoke } = setup();
    const actions = actionsFor();
    draw(actions);
    push(chat({ backend: "codex", entryId: undefined as never, answer: "The bundler.", status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue as side task/u }));
    await vi.waitFor(() => expect(actions.focusComposer).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "create-transfer", { threadId: "t1", target: "codex" });
    expect(actions.newSession).toHaveBeenCalled();
    expect(actions.askFork).not.toHaveBeenCalled();
    expect((actions.focusComposer as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("What is slow?");
  });

  it("will not fork from a thread the question was not asked in", async () => {
    const { draw, push } = setup();
    const actions = actionsFor({ activeThread: () => ({ sessionId: "other", draftPending: false }) });
    draw(actions);
    push(chat({ answer: "A.", status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue as side task/u }));
    await vi.waitFor(() => expect(actions.notify).toHaveBeenCalledWith("Open the thread this question was asked in first."));
    expect(actions.askFork).not.toHaveBeenCalled();
  });

  it("shows why an answer failed and asks again on the same question", async () => {
    const { draw, push, invoke } = setup();
    const actions = actionsFor();
    draw(actions);
    push(chat({ status: "failed", error: "Rate limited." }));
    expect(screen.getByRole("alert").textContent).toBe("Rate limited.");
    fireEvent.click(screen.getByRole("button", { name: /Retry/u }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "btw-ask", { threadId: "t1", question: "What is slow?", chatId: "c1" }));
  });

  it("ends the question when its tab closes, and says so when another window did", async () => {
    const { draw, push, invoke, handle } = setup();
    draw(actionsFor());
    push(chat({ answer: "A.", status: "done" }));
    const onClose = (handle.onClose as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as () => void;
    act(() => onClose());
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "btw-forget", { chatId: "c1" });
    expect(screen.getByRole("status").textContent).toContain("closed");
    push(chat({ answer: "A.", status: "done" }));
    push({ id: "c1", gone: true });
    expect(screen.getByRole("status").textContent).toContain("closed");
  });
});
