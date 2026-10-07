// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPage } from "../../shared/host-protocol";
import type { UiSession } from "../../shared/contracts";
import type { UiFileContent, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activateTab, closeTab, EMPTY_STAGE, openExtensionTab, openFileTab, openThreadTab, otherTabIds, pinTab, setFileView, tabIdsToTheRight, unpinTab, type StageState } from "../../workbench/stage";
import { ThreadStore } from "../../workbench/thread-store";
import { HostClientProvider } from "../host-client-context";
import type { HostClient } from "../../workbench/host-client";
import { ThreadStoreContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { StageTabController } from "../stage-tab-controller";
import { PlatformProvider } from "../platform-context";
import type { Platform } from "../../workbench/platform";
import type { PlatformEnvironments } from "../../workbench/environments";
import type { UiEnvironmentThreadView, UiEnvironments } from "../../shared/environments";
import { Stage } from "./Stage";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The virtualizer remeasures rows in a requestAnimationFrame it never
  // cancels. Drain those while the jsdom window still exists.
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
});

const CWD = "/repo";

/**
 * The file's line once it is drawn. The highlighter is a lazy import: when it has
 * loaded, the line is split into token spans, which a plain text query misses.
 */
function findFileText(text = "const a = 1;") {
  const whole = (element: Element | null) => element?.textContent?.trim() === text;
  return screen.findByText((_, element) => whole(element) && ![...element!.children].some(whole));
}
const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const CHANGED: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1, removed: 0, proposedMessage: "Update a",
};

const NO_ACTIONS = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;

function Harness({ initial, changes = NO_CHANGES, tools, maximize, onClose, threads = new ThreadStore(), loadThread, onTakeOverThread, registry, actions = NO_ACTIONS }: {
  initial: StageState;
  changes?: UiWorkspaceChanges;
  tools?: React.ReactNode;
  maximize?: { maximized: boolean; onToggle(): void };
  onClose?: (id: string) => void;
  threads?: ThreadStore;
  loadThread?: (sessionId: string) => Promise<TranscriptPage>;
  onTakeOverThread?: (sessionId: string) => void;
  actions?: WorkbenchActions;
  registry?: ExtensionRegistry;
}) {
  const [stage, setStage] = useState(initial);
  const [stageTabs] = useState(() => new StageTabController({
    registry: registry ?? new ExtensionRegistry(),
    stage: () => stageRef.current,
    setStage: (change) => setStage(change as (current: StageState) => StageState),
    confirmDiscard: () => true,
  }));
  const stageRef = useRef(stage);
  stageRef.current = stage;
  return <TestProviders><ThreadStoreContext.Provider value={threads}><Stage
    stage={stage}
    {...(registry ? { registry } : {})}
    stageTabs={stageTabs}
    actions={actions}
    cwd={CWD}
    changes={changes}
    tools={tools}
    {...(maximize ? { maximize } : {})}
    loadFile={async (path): Promise<UiFileContent> => ({ path, name: "a.ts", size: 12, kind: "text", text: "const a = 1;\n", language: "typescript" })}
    loadDiff={async (path) => ({ path, added: 1, removed: 0, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "added", newLine: 1, text: "const a = 1;" }] }] })}
    onActivate={(id) => setStage((current) => activateTab(current, id))}
    onClose={(id) => { onClose?.(id); setStage((current) => closeTab(current, id)); }}
    onPin={(id) => setStage((current) => pinTab(current, id))}
    onUnpin={(id) => setStage((current) => unpinTab(current, id))}
    onCloseOthers={(id) => setStage((current) => otherTabIds(current, id).reduce(closeTab, current))}
    onCloseToRight={(id) => setStage((current) => tabIdsToTheRight(current, id).reduce(closeTab, current))}
    onChangeView={(id, view) => setStage((current) => setFileView(current, id, view))}
    onOpenInEditor={() => undefined}
    loadThread={loadThread ?? (async () => ({ sessionId: CHILD, messages: [], hasMore: false }))}
    onTakeOverThread={onTakeOverThread ?? (() => undefined)}
  /></ThreadStoreContext.Provider></TestProviders>;
}

const CHILD = "child-thread";

function agentSession(overrides: Partial<UiSession> = {}): UiSession {
  return {
    id: CHILD, path: `/sessions/${CHILD}.jsonl`, title: "Alpha reply", modifiedAt: 3,
    projectPath: CWD, projectName: "repo", messageCount: 2, ...overrides,
  };
}

function reply(text: string): TranscriptPage {
  return { sessionId: CHILD, hasMore: false, messages: [
    { id: "m1", role: "user", text: "Reply with a sentence", timestamp: 1 },
    { id: "m2", role: "assistant", text, timestamp: 2 },
  ] };
}

function storeWith(session?: UiSession, running = false): ThreadStore {
  const store = new ThreadStore();
  store.applyThreadIndex({ projects: [], sessions: session ? [session] : [] });
  if (running) store.setThreadRunning(CHILD, true);
  return store;
}

describe("Stage", () => {
  it("marks the line a file was opened at, and the last line for one past the end", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`, { line: 7 })} />);
    expect(await findFileText()).toBeTruthy();
    expect(document.querySelector(".source-line-mark")?.getAttribute("data-line")).toBe("1");
    cleanup();
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} />);
    expect(await findFileText()).toBeTruthy();
    expect(document.querySelector(".source-line-mark")).toBeNull();
  });

  it("puts a command an extension offers on the file-tab surface into the file's header", async () => {
    const registry = new ExtensionRegistry();
    const opened: string[] = [];
    registry.activate({
      id: "acme.files",
      name: "Files",
      activate: (plugin) => {
        plugin.registerCommand({
          id: "acme.edit",
          label: "Edit",
          group: "Project",
          surfaces: ["file-tab"],
          run: (actions) => {
            const tab = actions.activeStageTab?.();
            if (tab?.kind === "file") opened.push(tab.path);
          },
        });
        plugin.registerCommand({ id: "acme.other", label: "Elsewhere", group: "Project", run: () => undefined });
      },
    });
    const stage = openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`);
    const actions = { ...NO_ACTIONS, activeStageTab: () => stage.tabs[0], notify: vi.fn() } as unknown as WorkbenchActions;
    render(<Harness initial={stage} registry={registry} actions={actions} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(opened).toEqual([`${CWD}/src/a.ts`]);
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
  });

  it("shows the active file with its relative path and line numbers", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} />);

    expect(screen.getByRole("tab", { name: /a\.ts/u })).toHaveProperty("className", expect.stringContaining("preview"));
    expect(await findFileText()).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText(/12 B · 1 line/u)).toBeTruthy();
  });

  it("offers a diff view only for changed files and swaps to it", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} changes={CHANGED} />);
    await findFileText();

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(await screen.findByText("@@ -1 +1 @@")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /a\.ts \(diff\)/u })).toBeTruthy();
  });

  it("falls back to source once a diff tab's file has no changes left", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`, { view: "diff" })} />);

    expect(await findFileText()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull();
  });

  it("draws the design's strip: the changed mark, the tools, then the maximize after a separator", async () => {
    const onToggle = vi.fn();
    render(<Harness
      initial={openFileTab(openFileTab(EMPTY_STAGE, `${CWD}/src/b.ts`, { pin: true }), `${CWD}/src/a.ts`)}
      changes={CHANGED}
      tools={<button type="button">Files tool</button>}
      maximize={{ maximized: false, onToggle }}
    />);
    await findFileText();
    const changed = screen.getByRole("tab", { name: /a\.ts/u });
    expect(changed.querySelector(".stage-tab-changed")?.textContent).toBe("M");
    expect(screen.getByRole("tab", { name: /b\.ts/u }).querySelector(".stage-tab-changed")).toBeNull();
    const actions = document.querySelector(".stage-strip-actions")!;
    expect([...actions.children].map((child) => child.getAttribute("aria-label") ?? child.className ?? child.textContent))
      .toEqual(["", "stage-strip-separator", "Maximize stage"]);
    expect(actions.firstElementChild?.textContent).toBe("Files tool");
    fireEvent.click(screen.getByRole("button", { name: "Maximize stage" }));
    expect(onToggle).toHaveBeenCalled();
  });

  it("closes the focused tab on Escape without letting the key bubble", async () => {
    const onClose = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} onClose={onClose} />);
    await findFileText();

    fireEvent.keyDown(screen.getByRole("tab", { name: /a\.ts/u }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledWith(`file:${CWD}/src/a.ts`);
    expect(windowEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab")).toBeNull();
    window.removeEventListener("keydown", windowEscape);
  });
});

describe("a thread tab", () => {
  it("keeps a working indicator at the transcript tail before any tool runs, and clears it on completion", async () => {
    const store = storeWith(agentSession(), true);
    let answer = "Starting";
    render(<Harness initial={openThreadTab(EMPTY_STAGE, CHILD)} threads={store} loadThread={async () => reply(answer)} />);
    await screen.findByText("Starting");
    expect(await screen.findByText("Thinking", { exact: true })).toBeTruthy();
    answer = "Finished";
    act(() => store.setThreadRunning(CHILD, false));
    await screen.findByText("Finished");
    expect(screen.queryByText("Thinking", { exact: true })).toBeNull();
  });

  it("names the tab from the index and renders the thread's transcript read-only", async () => {
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={storeWith(agentSession())}
      loadThread={async () => reply("The child answered.")}
    />);

    expect(screen.getByRole("tab", { name: /Alpha reply/u })).toBeTruthy();
    expect(await screen.findByText("The child answered.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reloads while the index says the thread is streaming and stops when it settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loads: string[] = [];
    const store = storeWith(agentSession(), true);
    let answer = "First half";
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={store}
      loadThread={async (sessionId) => { loads.push(sessionId); return reply(answer); }}
    />);
    await screen.findByText("First half");

    answer = "Second half";
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(await screen.findByText("Second half")).toBeTruthy();

    act(() => store.setThreadRunning(CHILD, false));
    const settled = loads.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(loads).toHaveLength(settled);
    vi.useRealTimers();
  });

  it("reloads once the index reports the thread changed", async () => {
    const store = storeWith(agentSession());
    let answer = "Before";
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={store}
      loadThread={async () => reply(answer)}
    />);
    await screen.findByText("Before");

    answer = "After";
    act(() => store.applyThreadShell(CHILD, agentSession({ modifiedAt: 9, messageCount: 4 })));
    expect(await screen.findByText("After")).toBeTruthy();
  });

  it("shows an empty state and no take-over when the session is gone", async () => {
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={storeWith()}
      loadThread={async () => { throw new Error("That thread is not open any more."); }}
    />);

    expect(await screen.findByText(/not in the index any more/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take over" })).toHaveProperty("disabled", true);
  });

  it("reports what the host answered when the transcript cannot be read", async () => {
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={storeWith(agentSession())}
      loadThread={async () => { throw new Error("That thread is not open any more."); }}
    />);

    expect(await screen.findByText("That thread is not open any more.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take over" })).toHaveProperty("disabled", false);
  });

  it("loads again once the taken-over thread is the one on screen", async () => {
    const store = storeWith(agentSession());
    let held = false;
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={store}
      loadThread={async () => {
        if (!held) throw new Error("That thread is not open any more.");
        return reply("Now it reads.");
      }}
    />);
    await screen.findByText(/That thread is not open any more/u);

    held = true;
    act(() => store.setActiveThread(CHILD));
    expect(await screen.findByText("Now it reads.")).toBeTruthy();
  });

  it("hands the thread to the composer only when Take over is pressed", async () => {
    const onTakeOverThread = vi.fn();
    render(<Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD)}
      threads={storeWith(agentSession())}
      loadThread={async () => reply("Done")}
      onTakeOverThread={onTakeOverThread}
    />);
    await screen.findByText("Done");

    expect(onTakeOverThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(onTakeOverThread).toHaveBeenCalledWith(CHILD));
  });
});


describe("a tab a kit drew", () => {
  function terminals(): ExtensionRegistry {
    const registry = new ExtensionRegistry();
    registry.activate({
      id: "acme.terminals",
      name: "Terminals",
      activate: (plugin) => {
        plugin.registerStageTab({
          kind: "terminal",
          title: (params) => `shell ${String(params.id)}`,
          render: (params, handle, actions) => <>
            <button onClick={() => handle.setTitle("renamed")}>shell {String(params.id)} output</button>
            <button onClick={() => actions.openPanel("terminal")}>show panel</button>
          </>,
        });
      },
    });
    return registry;
  }

  const tab = (id: string) => openExtensionTab(EMPTY_STAGE, { tabKind: "terminal", key: id, params: { id }, title: `shell ${id}` });

  it("draws the kind's content and lets it rename its own tab", () => {
    render(<Harness initial={tab("t1")} registry={terminals()} />);

    expect(screen.getByRole("tab", { name: /shell t1/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /shell t1 output/u }));
    expect(screen.getByRole("tab", { name: /renamed/u })).toBeTruthy();
  });

  it("gives the content the workbench's actions, as a panel gets them", () => {
    const openPanel = vi.fn();
    render(<Harness initial={tab("t1")} registry={terminals()} actions={{ openPanel } as unknown as WorkbenchActions} />);
    fireEvent.click(screen.getByRole("button", { name: "show panel" }));
    expect(openPanel).toHaveBeenCalledWith("terminal");
  });

  it("says so when the kit that drew it is not active", () => {
    render(<Harness initial={tab("t1")} />);
    expect(screen.getByText(/extension that draws this tab is not active/u)).toBeTruthy();
  });

  it("closes the other tabs from the tab's own context menu", async () => {
    const registry = terminals();
    let stage = openFileTab(tab("t1"), `${CWD}/src/a.ts`, { pin: true });
    stage = openFileTab(stage, `${CWD}/src/b.ts`, { pin: true });
    render(<Harness initial={stage} registry={registry} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    fireEvent.contextMenu(screen.getByRole("tab", { name: /shell t1/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close others" }));

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getByRole("tab", { name: /shell t1/u })).toBeTruthy();
  });

  it("splits the stage from a tab's menu, draws both panes, and joins them again (design 2f)", async () => {
    render(<Harness initial={openFileTab(tab("t1"), `${CWD}/src/a.ts`, { pin: true })} registry={terminals()} />);
    await findFileText();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /shell t1/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));

    expect(await screen.findByRole("button", { name: /shell t1 output/u })).toBeTruthy();
    // The pane in front is drawn anew beside the split one, so its file is read again.
    expect(await findFileText()).toBeTruthy();
    expect(screen.getAllByRole("tab").filter((entry) => entry.classList.contains("active"))).toHaveLength(2);

    fireEvent.contextMenu(screen.getByRole("tab", { name: /shell t1/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsplit" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /shell t1 output/u })).toBeNull());
    expect(await findFileText()).toBeTruthy();
  });

  it("splits when a tab dragged off the strip is let go over the stage, not over the strip", async () => {
    render(<Harness initial={openFileTab(tab("t1"), `${CWD}/src/a.ts`, { pin: true })} registry={terminals()} />);
    const body = await findFileText();
    const id = "ext:terminal:t1";
    const carried = { types: ["application/x-tau-stage-tab"], getData: () => id, setData: vi.fn() };

    fireEvent.dragStart(screen.getByRole("tab", { name: /shell t1/u }), { dataTransfer: carried });
    expect(carried.setData).toHaveBeenCalledWith("application/x-tau-stage-tab", id);
    fireEvent.dragOver(screen.getByRole("tab", { name: /a\.ts/u }), { dataTransfer: carried });
    expect(screen.queryByText("Drop to split")).toBeNull();
    fireEvent.dragOver(body, { dataTransfer: carried });
    expect(await screen.findByText("Drop to split")).toBeTruthy();
    fireEvent.drop(body, { dataTransfer: carried });

    expect(await screen.findByRole("button", { name: /shell t1 output/u })).toBeTruthy();
    expect(await findFileText()).toBeTruthy();
    expect(screen.queryByText("Drop to split")).toBeNull();
  });

  it("unpins a tab from the context menu, which makes it the preview again", async () => {
    render(<Harness initial={tab("t1")} registry={terminals()} />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: /shell t1/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /shell t1/u }).className).toContain("preview"));
  });
});

describe("a thread of another machine", () => {
  const SESSION = "t9";
  const list: UiEnvironments = { shown: "host-mini", secureStorage: true, environments: [
    { id: "host-mini", name: "mini", local: true, status: "connected", threads: [], threadCount: 0, projects: [] },
    { id: "host-rex", name: "rex", local: false, status: "connected", threads: [], threadCount: 0, projects: [] },
  ] };
  const base: UiEnvironmentThreadView = {
    machine: "host-rex", sessionId: SESSION, machineName: "rex", status: "connected", indexed: true, revision: 0,
    thread: { title: "Works on rex", path: "/rex/t9.jsonl", projectName: "w", modifiedAt: 1, messageCount: 2, running: true, usage: { costUsd: 0.25 } as never },
  };

  function lookIn() {
    const listeners = new Set<(view: UiEnvironmentThreadView) => void>();
    const reads: number[] = [];
    let answer = "First words.";
    const environments = {
      getSnapshot: () => list,
      subscribe: () => () => undefined,
      open: vi.fn(async () => undefined),
      watchThread: vi.fn((_machine: string, _session: string, listener: (view: UiEnvironmentThreadView) => void) => {
        listeners.add(listener);
        queueMicrotask(() => listener(base));
        return () => { listeners.delete(listener); };
      }),
      transcriptPage: vi.fn(async () => {
        reads.push(Date.now());
        return { sessionId: SESSION, messages: reply(answer).messages, hasMore: false };
      }),
    } as unknown as PlatformEnvironments;
    const platform = { environments } as unknown as Platform;
    const push = (view: UiEnvironmentThreadView) => act(() => { for (const listener of listeners) listener(view); });
    return { environments, platform, push, listeners, reads, answer: (text: string) => { answer = text; } };
  }

  it("reads the transcript there, follows each change, and lets go when the tab closes", async () => {
    const { platform, push, listeners, environments, answer } = lookIn();
    const { unmount } = render(<PlatformProvider platform={platform}><Harness initial={openThreadTab(EMPTY_STAGE, SESSION, { pin: true, machine: "host-rex" })} /></PlatformProvider>);
    expect(await screen.findByText("First words.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Works on rex/u })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Thread Works on rex on rex" })).toBeTruthy();
    expect(screen.getByText(/working · \$0\.25/u)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    answer("Second words.");
    await push({ ...base, revision: 1 });
    expect(await screen.findByText("Second words.")).toBeTruthy();
    expect(environments.transcriptPage).toHaveBeenCalledWith("host-rex", SESSION);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("opens the thread on its machine instead of taking it over, and says why it cannot", async () => {
    const { platform, push, environments } = lookIn();
    render(<PlatformProvider platform={platform}><Harness initial={openThreadTab(EMPTY_STAGE, SESSION, { pin: true, machine: "host-rex" })} /></PlatformProvider>);
    await screen.findByText("First words.");
    expect(screen.queryByRole("button", { name: /Take over/u })).toBeNull();
    await push({ ...base, revision: 2, asking: { id: "q", title: "Which colour?" } });
    expect(screen.getByText("Asks: Which colour?")).toBeTruthy();
    expect(screen.getByText("Answer it on rex")).toBeTruthy();
    expect(screen.getByText(/waiting for an answer/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open on rex" }));
    await waitFor(() => expect(environments.open).toHaveBeenCalledWith("host-rex", { thread: { path: "/rex/t9.jsonl" } }));
    await push({ ...base, status: "offline", lastSeenAt: 5, revision: 3 });
    expect(screen.getByText(/rex is offline/u)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open on rex" }) as HTMLButtonElement).disabled).toBe(true);
    // What it showed last stays.
    expect(screen.getByText("First words.")).toBeTruthy();
  });

  it("opens a connected agents thread here from an existing look-in tab even if the window's old key is refused", async () => {
    const { platform, environments, push } = lookIn();
    const switchSession = vi.fn(async () => true);
    const actions = new Proxy(NO_ACTIONS, { get: (target, name) => name === "switchSession" ? switchSession : Reflect.get(target, name) });
    const invokeHostExtension = vi.fn(async () => ({ machines: [{ id: "host-rex", status: "connected" }] }));
    const client = { invokeHostExtension } as unknown as HostClient;
    render(<HostClientProvider client={client}><PlatformProvider platform={platform}><Harness
      initial={openThreadTab(EMPTY_STAGE, SESSION, { pin: true, machine: "host-rex" })}
      actions={actions}
    /></PlatformProvider></HostClientProvider>);
    await screen.findByText("First words.");
    await push({ ...base, status: "refused", revision: 1 });
    await waitFor(() => expect((screen.getByRole("button", { name: "Open on rex" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open on rex" }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("tau-thread:machine:host-rex~t9"));
    expect(invokeHostExtension).toHaveBeenCalledWith("tau.environments", "agents");
    expect(environments.open).not.toHaveBeenCalled();
  });

  it("lends kits a look-in region that names the machine and thread, and whether it is reached", async () => {
    const { platform, push } = lookIn();
    const registry = new ExtensionRegistry();
    registry.activate({
      id: "acme.peek",
      name: "Peek",
      activate: (plugin) => {
        plugin.registerRegion({
          id: "acme.peek",
          placement: "look-in",
          Component: ({ lookIn: shown }) => <p>{shown ? `${shown.machineName} ${shown.machine} ${shown.sessionId} ${shown.connected ? "reached" : "away"}` : "no look-in"}</p>,
        });
      },
    });
    render(<PlatformProvider platform={platform}><Harness registry={registry} initial={openThreadTab(EMPTY_STAGE, SESSION, { pin: true, machine: "host-rex" })} /></PlatformProvider>);
    expect(await screen.findByText(`rex host-rex ${SESSION} reached`)).toBeTruthy();
    await push({ ...base, status: "offline", revision: 1 });
    expect(screen.getByText(`rex host-rex ${SESSION} away`)).toBeTruthy();
  });

  it("shows this machine's own thread as any tab, and says so on a client that reaches no other machine", async () => {
    const { platform } = lookIn();
    const first = render(<PlatformProvider platform={platform}><Harness
      initial={openThreadTab(EMPTY_STAGE, CHILD, { pin: true, machine: "mini" })}
      threads={storeWith(agentSession())}
      loadThread={async () => reply("Local answer.")}
    /></PlatformProvider>);
    expect(await screen.findByText("Local answer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Take over/u })).toBeTruthy();
    first.unmount();
    render(<PlatformProvider platform={{} as Platform}><Harness initial={openThreadTab(EMPTY_STAGE, SESSION, { pin: true, machine: "host-rex" })} /></PlatformProvider>);
    expect(screen.getByText(/This client reaches no other machine/u)).toBeTruthy();
  });
});

it("keeps a fallback child read-only without a takeover action", async () => {
  const takeover = vi.fn();
  render(<Harness initial={openThreadTab(EMPTY_STAGE, CHILD)} threads={storeWith(agentSession({ parentThreadId: "parent" }))} loadThread={async () => reply("Child result")} onTakeOverThread={takeover} />);
  await screen.findByText("Child result");
  expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  expect(takeover).not.toHaveBeenCalled();
});

describe("Stage: recently closed", () => {
  /** The workbench's wiring: every close goes through the controller, which keeps the history. */
  function Reopening({ initial }: { initial: StageState }) {
    const [stage, setStage] = useState(initial);
    const stageRef = useRef(stage);
    stageRef.current = stage;
    const [stageTabs] = useState(() => new StageTabController({
      registry: new ExtensionRegistry(),
      stage: () => stageRef.current,
      setStage: (change) => setStage(change as (current: StageState) => StageState),
      confirmDiscard: () => true,
    }));
    return <TestProviders><ThreadStoreContext.Provider value={new ThreadStore()}><Stage
      stage={stage}
      stageTabs={stageTabs}
      actions={NO_ACTIONS}
      cwd={CWD}
      changes={NO_CHANGES}
      loadFile={async (path): Promise<UiFileContent> => ({ path, name: "a.ts", size: 12, kind: "text", text: "const a = 1;\n", language: "typescript" })}
      loadDiff={async (path) => ({ path, added: 0, removed: 0, hunks: [] })}
      onActivate={(id) => setStage((current) => activateTab(current, id))}
      onClose={stageTabs.close}
      onReopen={(id) => { stageTabs.reopen(id); }}
      onPin={(id) => setStage((current) => pinTab(current, id))}
      onUnpin={(id) => setStage((current) => unpinTab(current, id))}
      onCloseOthers={stageTabs.closeOthers}
      onCloseToRight={stageTabs.closeToTheRight}
      onChangeView={(id, view) => setStage((current) => setFileView(current, id, view))}
      onOpenInEditor={() => undefined}
      loadThread={async () => ({ sessionId: CHILD, messages: [], hasMore: false })}
      onTakeOverThread={() => undefined}
    /></ThreadStoreContext.Provider></TestProviders>;
  }

  it("lists a closed tab under Recently closed in All tabs and brings it back from there", async () => {
    render(<Reopening initial={openFileTab(openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`, { pin: true }), `${CWD}/src/b.ts`, { pin: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Close b.ts" }));
    expect(screen.queryByRole("tab", { name: /b\.ts/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    const menu = screen.getByRole("menu", { name: "All tabs" });
    expect(menu.textContent).toContain("Recently closed");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /b\.ts/u }));
    await waitFor(() => expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("b.ts"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers the tab closed last on an empty stage", async () => {
    render(<Reopening initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`, { pin: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    fireEvent.click(await screen.findByRole("button", { name: /Reopen a\.ts/u }));
    expect(await findFileText()).toBeTruthy();
  });
});
