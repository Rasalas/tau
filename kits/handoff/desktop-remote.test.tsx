// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiSession, WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext } from "../../src/renderer/test-support/kit-harness.js";
import { REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, type RemoteThreadLink } from "../remote-work/protocol.js";
import { createHandoffExtension } from "./desktop.js";
import { HANDOFF_EXTENSION_ID, LINEAGE_EVENT, type ContinueTarget, type LineageState } from "./protocol.js";
import { HandoffStore } from "./store.js";

afterEach(cleanup);

const RUNTIMES = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }];
const REX: ContinueTarget = { id: "rex-id", name: "rex", runtimes: [{ kind: "pi", label: "Pi", ready: true }, { kind: "codex", label: "Codex", ready: false, note: "not signed in" }] };
const BACK = "<merge_back_context>\nBrought back from “Parser work” (pi) on rex, 2 messages since it went there:\n\nIts work came back as the branch `tau/rex/parser` here (1 commit, 2 files).\n\n## What was done\nBench.\n</merge_back_context>";
const REMOTE: LineageState = { links: [], remotes: [{ threadId: "parent", link: "l1", machine: "rex-id", machineName: "rex", strategy: "native", createdAt: 1 }] };
const LINK: RemoteThreadLink = { id: "l1", machine: "rex-id", machineName: "rex", cwd: "/project", root: "/project", status: "idle", thread: "rex-thread", createdAt: 1, updatedAt: 1 };

const session = (id: string, title: string, path: string): UiSession => ({ id, title, path, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2 });

function snapshot(sessionId: string, backendKind = "pi"): HostSnapshot {
  return { sessionId, backendKind, runtimeBackends: RUNTIMES, messages: [], models: [] } as unknown as HostSnapshot;
}

function actionsFor(options: { backendKind?: string; draft?: string } = {}): WorkbenchActions {
  let draft = options.draft ?? "";
  const toast = { id: "toast", update: vi.fn(), dismiss: vi.fn() };
  return {
    activeThread: () => ({ sessionId: "parent", workspaceId: "ws1", cwd: "/project", backendKind: options.backendKind ?? "pi", draftPending: false }),
    notify: vi.fn(),
    newSession: vi.fn(),
    duplicateThread: vi.fn(async () => true),
    switchSession: vi.fn(async () => true),
    composerDraft: () => draft,
    setComposerDraft: vi.fn((text: string) => { draft = text; }),
    focusComposer: vi.fn(),
    toast: vi.fn(() => toast),
  } as unknown as WorkbenchActions;
}

function setup(answers: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (extension: string, command: string, _input?: unknown) => {
    if (extension === REMOTE_WORK_EXTENSION_ID && command === "thread") return LINK;
    if (command in answers) return answers[command];
    if (command === "state") return { links: [], remotes: [] };
    if (command === "continue-targets") return [REX];
    if (command === "continue-on") return { link: "l1", machine: "rex-id", machineName: "rex", native: true };
    if (command === "bring-back-remote") return { parentThreadId: "parent", context: BACK, through: "a2" };
    if (command === "settle-remote") return { ...LINK, status: "settled", settled: { how: "applied", at: 2, detail: "Merged tau/rex/parser." } };
    return undefined;
  });
  const environments = {
    getSnapshot: () => ({ environments: [{ id: "rex-id", name: "rex", threads: [{ id: "rex-thread", path: "/rex/sessions/x.jsonl", title: "Parser work" }] }] }),
    subscribe: () => () => undefined,
    open: vi.fn(async () => undefined),
    watchThread: () => () => undefined,
  };
  const store = new HandoffStore();
  const { registry } = createKitHarness(invoke, undefined, { environments } as never);
  registry.activate(createHandoffExtension(store));
  const threads = new ThreadStore();
  threads.applyThreadIndex({ projects: [], sessions: [session("parent", "Parser work", "/sessions/parent.jsonl")] });
  const title = registry.getRegions("thread-title").find((entry) => entry.id === "handoff.lineage")!;
  const banner = registry.getRegions("composer-above").find((entry) => entry.id === "handoff.remote")!;
  const draw = (actions: WorkbenchActions, backendKind = "pi") => (
    <ThreadStoreContext.Provider value={threads}>
      <title.Component snapshot={snapshot("parent", backendKind)} actions={actions} />
      <banner.Component snapshot={snapshot("parent", backendKind)} actions={actions} />
    </ThreadStoreContext.Provider>
  );
  const push = (extensionId: string, name: string, payload: unknown) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId, name, payload }));
  const command = (id: string) => registry.getCommands().find((entry) => entry.id === id)!;
  const calls = (name: string) => invoke.mock.calls.filter(([, called]) => called === name).map(([, , input]) => input);
  return { invoke, store, registry, draw, push, command, calls, environments };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("Continue on another machine", () => {
  it("lists the machine under the runtimes and sends the thread with the draft there, staying on this thread", async () => {
    const { draw, command, calls } = setup();
    const actions = actionsFor({ draft: "Now add a benchmark." });
    render(draw(actions));
    await settle();
    act(() => { void command("handoff.continue-in").run(actions); });
    expect(screen.getByRole("menuitem", { name: /rex/u }).textContent).toContain("Goes on there with its history and your draft; you stay here.");

    fireEvent.click(screen.getByRole("menuitem", { name: /rex/u }));
    await settle();
    expect(calls("continue-on")).toEqual([{ threadId: "parent", machine: "rex-id", prompt: "Now add a benchmark." }]);
    expect(actions.setComposerDraft).toHaveBeenCalledWith("");
    // Out of sight: no switch, only a toast that can open it there.
    expect(actions.switchSession).not.toHaveBeenCalled();
    const toast = (actions.toast as ReturnType<typeof vi.fn>).mock.results[0]!.value as { update: ReturnType<typeof vi.fn> };
    expect(toast.update).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Continues on rex", actions: [expect.objectContaining({ label: "Open on rex" })] }));
  });

  it("offers the machine but disables it when the thread's runtime is not ready there, with the reason", async () => {
    const { draw, command, calls } = setup();
    const actions = actionsFor({ backendKind: "codex", draft: "Go on." });
    render(draw(actions, "codex"));
    await settle();
    act(() => { void command("handoff.continue-in").run(actions); });
    const item = screen.getByRole("menuitem", { name: /rex/u });
    expect(item.getAttribute("aria-disabled") ?? String((item as HTMLButtonElement).disabled)).toBe("true");
    expect(item.textContent).toContain("Codex is not signed in on rex.");
    expect(calls("continue-on")).toEqual([]);
  });

  it("shows where the thread continues, brings its branch and summary into the composer, and merges on a click", async () => {
    const { draw, push, calls, environments } = setup({ state: REMOTE });
    const actions = actionsFor();
    const view = render(draw(actions));
    await settle();
    expect(view.container.textContent).toContain("Continues on rex · Idle");

    fireEvent.click(screen.getByRole("button", { name: "Open on rex" }));
    await settle();
    expect(environments.open).toHaveBeenCalledWith("rex-id", { thread: { path: "/rex/sessions/x.jsonl" } });
    // Or read it here, without moving the window.
    const openThread = vi.fn();
    (actions as unknown as { openThread: typeof openThread }).openThread = openThread;
    fireEvent.click(screen.getByRole("button", { name: "Look in" }));
    expect(openThread).toHaveBeenCalledWith("rex-thread", { pin: true, machine: "rex-id" });

    fireEvent.click(screen.getByRole("button", { name: "Bring back" }));
    await settle();
    expect(calls("bring-back-remote")).toEqual([{ threadId: "parent" }]);
    expect(actions.setComposerDraft).toHaveBeenCalledWith(`${BACK}\n\n`);

    push(REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, { ...LINK, result: { state: "branch", branch: "tau/rex/parser", tip: "c", commits: 1, files: 2, fetchedAt: 2 } });
    expect(view.container.textContent).toContain("tau/rex/parser");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await settle();
    expect(calls("settle-remote")).toEqual([{ threadId: "parent", how: "apply" }]);
    expect(actions.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Merged from rex" }));
    expect(view.container.textContent).not.toContain("Continues on rex");
  });

  it("keeps Bring back off while it works there, and asks before letting the work go", async () => {
    const { draw, push, calls } = setup({ state: REMOTE });
    const actions = actionsFor();
    const view = render(draw(actions));
    await settle();
    push(REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, { ...LINK, status: "running" });
    expect(view.container.textContent).toContain("Continues on rex · Working");
    expect((screen.getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled).toBe(true);

    push(HANDOFF_EXTENSION_ID, LINEAGE_EVENT, REMOTE);
    fireEvent.click(screen.getByRole("button", { name: "Let go of the work on rex" }));
    expect(view.container.textContent).toContain("Its turn stops and its worktree there is removed");
    expect(calls("settle-remote")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Let go" }));
    await settle();
    expect(calls("settle-remote")).toEqual([{ threadId: "parent", how: "discard" }]);
  });
});
