// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiSession } from "../../shared/contracts";
import type { UiFileContent, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activateTab, closeTab, EMPTY_STAGE, openExtensionTab, openFileTab, openThreadTab, otherTabIds, pinTab, setFileView, tabIdsToTheRight, unpinTab, type StageState } from "../../workbench/stage";
import { ThreadStore } from "../../workbench/thread-store";
import { ThreadStoreContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { StageTabController } from "../stage-tab-controller";
import { Stage } from "./Stage";
import type { ChatTab } from "./StageTabs";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The virtualizer remeasures rows in a requestAnimationFrame it never
  // cancels. Drain those while the jsdom window still exists.
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
});

const CWD = "/repo";
const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const CHANGED: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1, removed: 0, proposedMessage: "Update a",
};

const NO_ACTIONS = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;

function Harness({ initial, changes = NO_CHANGES, chatTab, onClose, threads = new ThreadStore(), loadThread, onTakeOverThread, registry, actions = NO_ACTIONS }: {
  initial: StageState;
  changes?: UiWorkspaceChanges;
  chatTab?: ChatTab;
  onClose?: (id: string) => void;
  threads?: ThreadStore;
  loadThread?: (sessionId: string) => Promise<UiMessage[]>;
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
    chatTab={chatTab}
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
    loadThread={loadThread ?? (async () => [])}
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

function reply(text: string): UiMessage[] {
  return [
    { id: "m1", role: "user", text: "Reply with a sentence", timestamp: 1 },
    { id: "m2", role: "assistant", text, timestamp: 2 },
  ];
}

function storeWith(session?: UiSession, running = false): ThreadStore {
  const store = new ThreadStore();
  store.applyThreadIndex({ projects: [], sessions: session ? [session] : [] });
  if (running) store.setThreadRunning(CHILD, true);
  return store;
}

describe("Stage", () => {
  it("shows the active file with its relative path and line numbers", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} />);

    expect(screen.getByRole("tab", { name: /a\.ts/u })).toHaveProperty("className", expect.stringContaining("preview"));
    expect(await screen.findByText("const a = 1;")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText(/12 B · 1 line/u)).toBeTruthy();
  });

  it("offers a diff view only for changed files and swaps to it", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} changes={CHANGED} />);
    await screen.findByText("const a = 1;");

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(await screen.findByText("@@ -1 +1 @@")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /a\.ts \(diff\)/u })).toBeTruthy();
  });

  it("falls back to source once a diff tab's file has no changes left", async () => {
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`, { view: "diff" })} />);

    expect(await screen.findByText("const a = 1;")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull();
  });

  it("switches from a file to chat and back in the compact tab strip", async () => {
    function CompactHarness() {
      const [chatActive, setChatActive] = useState(false);
      return <Harness
        initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)}
        chatTab={{ active: chatActive, streaming: true, onSelect: setChatActive }}
      />;
    }

    render(<CompactHarness />);
    expect(await screen.findByText("const a = 1;")).toBeTruthy();

    const chat = screen.getByRole("tab", { name: /Chat/u });
    expect(chat.className).not.toContain("active");
    expect(screen.getByLabelText("Agent is working")).toBeTruthy();
    fireEvent.click(chat);
    expect(chat.className).toContain("active");
    expect(screen.queryByText("const a = 1;")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /a\.ts/u }));
    expect(chat.className).not.toContain("active");
    expect(await screen.findByText("const a = 1;")).toBeTruthy();
  });

  it("closes the focused tab on Escape without letting the key bubble", async () => {
    const onClose = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} onClose={onClose} />);
    await screen.findByText("const a = 1;");

    fireEvent.keyDown(screen.getByRole("tab", { name: /a\.ts/u }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledWith(`file:${CWD}/src/a.ts`);
    expect(windowEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab")).toBeNull();
    window.removeEventListener("keydown", windowEscape);
  });
});

describe("a thread tab", () => {
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

  it("unpins a tab from the context menu, which makes it the preview again", async () => {
    render(<Harness initial={tab("t1")} registry={terminals()} />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: /shell t1/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /shell t1/u }).className).toContain("preview"));
  });
});
