// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileContent, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activateTab, closeTab, EMPTY_STAGE, openFileTab, pinTab, setFileView, type StageState } from "../stage";
import { WorkbenchContext, type WorkbenchContextValue } from "../workbench-context";
import { WorkspaceStore } from "../extensions/workspace-store";
import { FilesPanel } from "../extensions/workspace-panels";
import { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";
import { Stage } from "./Stage";
import type { ChatTab } from "./StageTabs";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CWD = "/repo";
const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const CHANGED: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1, removed: 0, proposedMessage: "Update a",
};

function Harness({ initial, changes = NO_CHANGES, chatTab, onClose }: {
  initial: StageState;
  changes?: UiWorkspaceChanges;
  chatTab?: ChatTab;
  onClose?: (id: string) => void;
}) {
  const [stage, setStage] = useState(initial);
  return <Stage
    stage={stage}
    cwd={CWD}
    changes={changes}
    chatTab={chatTab}
    loadFile={async (path): Promise<UiFileContent> => ({ path, name: "a.ts", size: 12, kind: "text", text: "const a = 1;\n", language: "typescript" })}
    loadDiff={async (path) => ({ path, added: 1, removed: 0, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "added", newLine: 1, text: "const a = 1;" }] }] })}
    onActivate={(id) => setStage((current) => activateTab(current, id))}
    onClose={(id) => { onClose?.(id); setStage((current) => closeTab(current, id)); }}
    onPin={(id) => setStage((current) => pinTab(current, id))}
    onChangeView={(id, view) => setStage((current) => setFileView(current, id, view))}
    onOpenInEditor={() => undefined}
  />;
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

function workbench(overrides: Partial<WorkbenchContextValue> = {}): WorkbenchContextValue {
  return {
    tools: [],
    events: [],
    registry: {} as never,
    openFile: () => undefined,
    applySnapshot: () => undefined,
    handleHostEvent: () => undefined,
    ...overrides,
  };
}

function kitState(workspaceStore: WorkspaceStore, patch: Parameters<WorkspaceStore["update"]>[0] = {}) {
  workspaceStore.update({ cwd: CWD, draftPending: false, changes: CHANGED, workspace: undefined, committing: false, pushPrimary: false, commitFocusToken: 0, fileTree: [], ...patch });
}

function withServices(workspaceStore: WorkspaceStore, children: ReactNode) {
  return <RendererServicesProvider services={{ preferences: new PreferencesStore(), workspaceStore }}>{children}</RendererServicesProvider>;
}

describe("FilesPanel", () => {
  it("opens a file on click and pins it on double-click", () => {
    const workspaceStore = new WorkspaceStore(new PreferencesStore());
    const openFile = vi.fn();
    kitState(workspaceStore, { changes: NO_CHANGES, fileTree: [{ name: "a.ts", path: `${CWD}/a.ts`, kind: "file" }] });
    vi.spyOn(workspaceStore, "refreshFiles").mockResolvedValue(undefined);
    render(withServices(workspaceStore,
      <WorkbenchContext.Provider value={workbench({ openFile, activeDocumentPath: `${CWD}/a.ts` })}>
        <FilesPanel active extensionName="Workspace" actions={{} as never} />
      </WorkbenchContext.Provider>,
    ));

    const row = screen.getByTitle(`${CWD}/a.ts`);
    expect(row.className).toContain("active");
    fireEvent.click(row);
    fireEvent.doubleClick(row);

    expect(openFile).toHaveBeenNthCalledWith(1, `${CWD}/a.ts`);
    expect(openFile).toHaveBeenNthCalledWith(2, `${CWD}/a.ts`, { pin: true });
  });
});
