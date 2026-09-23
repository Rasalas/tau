// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiSession, WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext } from "../../src/renderer/test-support/kit-harness.js";
import { createHandoffExtension } from "./desktop.js";
import { HANDOFF_EXTENSION_ID, type LineageState } from "./protocol.js";
import { HandoffStore } from "./store.js";

afterEach(cleanup);

const RUNTIMES = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }];
const HANDOFF = "<handoff_context>\nContinued from “Parser work” (pi · openai-codex/gpt-5.6-luna). What happened there, as background for the message below:\n\n## Goal\nFast parser.\n</handoff_context>";
const MERGE_BACK = "<merge_back_context>\nBrought back from the fork “Fork” (codex), 2 messages since it started:\n\n## What was done\nTests.\n</merge_back_context>";
const LINEAGE: LineageState = { links: [{ threadId: "fork", parentThreadId: "parent", strategy: "portable", sourceBackend: "pi", targetBackend: "codex", createdAt: 1 }] };

const session = (id: string, title: string, path: string): UiSession => ({ id, title, path, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2 });

function snapshot(sessionId: string, backendKind = "pi"): HostSnapshot {
  return { sessionId, backendKind, runtimeBackends: RUNTIMES, messages: [], models: [] } as unknown as HostSnapshot;
}

function actionsFor(sessionId = "parent", overrides: Partial<Record<keyof WorkbenchActions, unknown>> = {}): WorkbenchActions {
  return {
    activeThread: () => ({ sessionId, workspaceId: "ws1", cwd: "/project", backendKind: sessionId === "fork" ? "codex" : "pi", draftPending: false }),
    notify: vi.fn(),
    newSession: vi.fn(),
    duplicateThread: vi.fn(async () => true),
    switchSession: vi.fn(async () => true),
    composerDraft: () => "",
    setComposerDraft: vi.fn(),
    focusComposer: vi.fn(),
    toast: vi.fn(() => ({ id: "toast", update: vi.fn(), dismiss: vi.fn() })),
    ...overrides,
  } as unknown as WorkbenchActions;
}

function setup(answers: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (_extension: string, command: string, _input?: unknown) => {
    if (command in answers) return answers[command];
    if (command === "state") return { links: [] };
    if (command === "create-transfer") return { transferId: "t1", native: false, sourceTitle: "Parser work" };
    if (command === "resolve-transfer") return { context: HANDOFF };
    if (command === "bind-transfer") return LINEAGE;
    if (command === "prepare-merge-back") return { parentThreadId: "parent", context: MERGE_BACK, through: "f2" };
    if (command === "commit-merge-back") return { links: [{ ...LINEAGE.links[0], mergedAt: 2 }] };
    return undefined;
  });
  const store = new HandoffStore();
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(createHandoffExtension(store));
  const threads = new ThreadStore();
  threads.applyThreadIndex({ projects: [], sessions: [session("parent", "Parser work", "/sessions/parent.jsonl"), session("fork", "Fork", "tau-thread:codex:fork")] });
  const region = registry.getRegions("thread-title").find((entry) => entry.id === "handoff.lineage")!;
  const inline = registry.getComposerInlines().find((entry) => entry.id === "handoff.draft")!;
  const command = (id: string) => registry.getCommands().find((entry) => entry.id === id)!;
  const drawTitle = (sessionId: string, actions: WorkbenchActions) => (
    <ThreadStoreContext.Provider value={threads}>
      <region.Component snapshot={snapshot(sessionId, sessionId === "fork" ? "codex" : "pi")} actions={actions} />
    </ThreadStoreContext.Provider>
  );
  const commands = () => invoke.mock.calls.map(([, name]) => name);
  return { invoke, store, registry, preferences, region, inline, command, drawTitle, commands };
}

function draftSlot(initial?: unknown) {
  const slot = { value: initial };
  return { slot, draftState: { read: () => slot.value, write: (value: unknown) => { slot.value = value; } } };
}

describe("Continue in…", () => {
  it("opens a runtime menu before the title and starts a draft on the chosen runtime", async () => {
    const { invoke, preferences, command, drawTitle } = setup();
    const actions = actionsFor();
    const view = render(drawTitle("parent", actions));
    expect(view.container.textContent).toBe("");

    act(() => { void command("handoff.continue-in").run(actions); });
    expect(screen.getByRole("menuitem", { name: /Pi.*This thread/su }).textContent).toContain("the history comes along");
    fireEvent.click(screen.getByRole("menuitem", { name: /Codex/u }));

    await vi.waitFor(() => expect(actions.newSession).toHaveBeenCalledWith({ workspace: "ws1" }));
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "create-transfer", { threadId: "parent", target: "codex" });
    expect(preferences.getSnapshot().newThreadRuntime).toBe("codex");
    expect(actions.duplicateThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("forks natively when the thread stays on a runtime that forks itself", async () => {
    const { command, drawTitle } = setup({ "create-transfer": { transferId: "t1", native: true, sourceTitle: "Parser work" } });
    const actions = actionsFor();
    render(drawTitle("parent", actions));
    act(() => { void command("handoff.continue-in").run(actions); });
    fireEvent.click(screen.getByRole("menuitem", { name: /Pi/u }));
    await vi.waitFor(() => expect(actions.duplicateThread).toHaveBeenCalled());
    expect(actions.newSession).not.toHaveBeenCalled();
  });

  it("offers each runtime in the palette while a thread is on screen", async () => {
    const { registry, drawTitle } = setup();
    const actions = actionsFor();
    render(drawTitle("parent", actions));
    const source = registry.getPaletteSources().find((entry) => entry.id === "handoff.continue")!;
    const rows = await source.search("continue cod", { actions, index: { projects: [], threads: [] }, signal: new AbortController().signal });
    expect(rows.map((row) => [row.label, row.detail])).toEqual([["Continue in Codex", "with a handoff summary"]]);
    const draft = actionsFor("", { activeThread: () => ({ draftPending: true }) });
    expect(await source.search("continue", { actions: draft, index: { projects: [], threads: [] }, signal: new AbortController().signal })).toEqual([]);
  });
});

describe("the fork's draft", () => {
  it("carries the handoff as a chip and writes the summary only when the first prompt is sent", async () => {
    const { invoke, inline, command, drawTitle, registry, store, commands } = setup();
    const actions = actionsFor();
    render(drawTitle("parent", actions));
    act(() => { void command("handoff.continue-in").run(actions); });
    fireEvent.click(screen.getByRole("menuitem", { name: /Codex/u }));
    await vi.waitFor(() => expect(actions.newSession).toHaveBeenCalled());

    const scope = "new:/project:d1";
    const { slot, draftState } = draftSlot();
    const Chip = inline.Component!;
    render(<Chip scope={scope} draftState={draftState} fileAttachments={false} imageInput={false} />);
    expect(screen.getByRole("group", { name: "Handoff" }).textContent).toContain("Continues Parser work");
    expect(slot.value).toEqual({ transferId: "t1", sourceTitle: "Parser work" });
    expect(inline.hasContent?.(scope)).toBe(true);
    expect(commands()).not.toContain("resolve-transfer");

    let sent: unknown;
    await act(async () => { sent = await inline.prepareSend!({ scope, text: "Now add tests.", fileAttachments: false, imageInput: false }); });
    expect(sent).toEqual({ context: HANDOFF });
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "resolve-transfer", { transferId: "t1" });
    act(() => inline.settleSend!(scope, true));
    expect(screen.queryByRole("group", { name: "Handoff" })).toBeNull();
    expect(slot.value).toBeUndefined();

    await registry.notifyPromptSubmitted({ prompt: `${HANDOFF}\n\nNow add tests.`, snapshot: snapshot("fork", "codex") }, actions);
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "bind-transfer", { transferId: "t1", threadId: "fork" });
    expect(store.getSnapshot().lineage).toEqual(LINEAGE);
  });

  it("brings the chip back from the draft's own slot after a reload, and drops it on request", async () => {
    const { invoke, inline } = setup();
    const { slot, draftState } = draftSlot({ transferId: "t9", sourceTitle: "Old work" });
    const Chip = inline.Component!;
    render(<Chip scope="new:/project:d2" draftState={draftState} fileAttachments={false} imageInput={false} />);
    expect(screen.getByRole("group", { name: "Handoff" }).textContent).toContain("Continues Old work");
    fireEvent.click(screen.getByRole("button", { name: "Start without the handoff" }));
    expect(screen.queryByRole("group", { name: "Handoff" })).toBeNull();
    expect(slot.value).toBeUndefined();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "cancel-transfer", { transferId: "t9" }));
  });

  it("keeps the draft when the summary cannot be written", async () => {
    const { inline, invoke } = setup();
    invoke.mockImplementation(async (_extension: string, command: string) => {
      if (command === "resolve-transfer") throw new Error("That handoff is gone.");
      return undefined;
    });
    const { draftState } = draftSlot({ transferId: "t1", sourceTitle: "Parser work" });
    const Chip = inline.Component!;
    render(<Chip scope="new:/project:d3" draftState={draftState} fileAttachments={false} imageInput={false} />);
    await act(async () => {
      await expect(inline.prepareSend!({ scope: "new:/project:d3", text: "x", fileAttachments: false, imageInput: false })).rejects.toThrow("That handoff is gone.");
    });
    expect(screen.getByRole("group", { name: "Handoff" }).textContent).toContain("That handoff is gone.");
  });

  it("ignores the composer of a thread that exists", () => {
    const { inline, store } = setup();
    store.arm({ transferId: "t1", sourceTitle: "Parser work" });
    const { slot, draftState } = draftSlot();
    const Chip = inline.Component!;
    render(<Chip scope="session:parent" draftState={draftState} fileAttachments={false} imageInput={false} />);
    expect(screen.queryByRole("group", { name: "Handoff" })).toBeNull();
    expect(slot.value).toBeUndefined();
  });
});

describe("lineage and bringing it back", () => {
  it("shows the parent before a fork's title and the forks before the parent's", () => {
    const { store, drawTitle } = setup();
    act(() => store.setLineage(LINEAGE));
    const actions = actionsFor("fork");
    const view = render(drawTitle("fork", actions));
    fireEvent.click(screen.getByRole("button", { name: /Parser work/u }));
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/parent.jsonl");
    expect(screen.getByRole("button", { name: "Bring back to parent" })).toBeTruthy();

    const parentActions = actionsFor("parent");
    view.rerender(drawTitle("parent", parentActions));
    fireEvent.click(screen.getByRole("button", { name: "1 fork" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Fork.*Codex/su }));
    expect(parentActions.switchSession).toHaveBeenCalledWith("tau-thread:codex:fork");
  });

  it("puts what the fork did into the parent's composer for review, and records it once it is sent", async () => {
    const { store, drawTitle, registry, invoke } = setup();
    act(() => store.setLineage(LINEAGE));
    const forkActions = actionsFor("fork");
    const view = render(drawTitle("fork", forkActions));
    fireEvent.click(screen.getByRole("button", { name: "Bring back to parent" }));
    await vi.waitFor(() => expect(forkActions.switchSession).toHaveBeenCalledWith("/sessions/parent.jsonl"));
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "prepare-merge-back", { threadId: "fork" });

    const parentActions = actionsFor("parent", { composerDraft: () => "And then?" });
    view.rerender(drawTitle("parent", parentActions));
    await vi.waitFor(() => expect(parentActions.setComposerDraft).toHaveBeenCalledWith(`${MERGE_BACK}\n\nAnd then?`));
    expect(parentActions.focusComposer).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "commit-merge-back", expect.anything());

    await registry.notifyPromptSubmitted({ prompt: `${MERGE_BACK}\n\nAnd then?`, snapshot: snapshot("parent") }, parentActions);
    expect(invoke).toHaveBeenCalledWith(HANDOFF_EXTENSION_ID, "commit-merge-back", { parentThreadId: "parent" });
  });

  it("says why when the thread on screen has nothing to bring back", async () => {
    const { command, invoke } = setup();
    invoke.mockImplementation(async (_extension: string, name: string) => {
      if (name === "prepare-merge-back") throw new Error("This thread was not continued or spawned from another thread.");
      return undefined;
    });
    const actions = actionsFor("parent");
    await command("handoff.bring-back").run(actions);
    expect(actions.notify).toHaveBeenCalledWith("This thread was not continued or spawned from another thread.");
    expect(actions.switchSession).not.toHaveBeenCalled();
  });
});

describe("context cards", () => {
  it("draws a handoff in a user message as a folded card that opens to the summary", () => {
    const { registry } = setup();
    const block = registry.getMessageBlocks().find((entry) => entry.tag === "handoff_context")!;
    expect(block.roles).toEqual(["user"]);
    const body = HANDOFF.split("\n").slice(1, -1).join("\n");
    render(<block.Component body={body} complete message={{ id: "u1", role: "user", text: HANDOFF, timestamp: 1 }} streaming={false} />);
    const head = screen.getByRole("button", { name: /Context handoff/u });
    expect(head.textContent).toContain("Continued from “Parser work”");
    expect(screen.queryByText("Fast parser.")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("Fast parser.")).toBeTruthy();
  });
});
