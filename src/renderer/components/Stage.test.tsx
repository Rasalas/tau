// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileContent, UiWorkspaceChanges } from "../../shared/contracts";
import { activateTab, closeTab, EMPTY_STAGE, openFileTab, pinTab, setFileView, type StageState } from "../stage";
import { ChangesContext, FilesContext, type ChangesContextValue } from "../workbench-context";
import { ChangesPanel, FilesPanel } from "../extensions/workspace-panels";
import { Stage } from "./Stage";
import type { ChatTab } from "./StageTabs";

afterEach(cleanup);

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

  it("lets the chat take the strip when the centre is too narrow for both", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} chatTab={{ active: false, streaming: true, onSelect }} />);
    await screen.findByText("const a = 1;");

    const chat = screen.getByRole("tab", { name: /Chat/u });
    expect(chat.className).not.toContain("active");
    expect(screen.getByLabelText("Agent is working")).toBeTruthy();
    fireEvent.click(chat);
    expect(onSelect).toHaveBeenCalled();

    rerender(<Harness initial={openFileTab(EMPTY_STAGE, `${CWD}/src/a.ts`)} chatTab={{ active: true, streaming: false, onSelect }} />);
    expect(screen.getByRole("tab", { name: /Chat/u }).className).toContain("active");
    expect(screen.getByRole("tab", { name: /a\.ts/u }).className).not.toContain("active");
    expect(screen.queryByText("const a = 1;")).toBeNull();
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

function changesValue(overrides: Partial<ChangesContextValue> = {}): ChangesContextValue {
  return {
    changes: CHANGED,
    snapshot: { cwd: CWD },
    committing: false,
    pushPrimary: false,
    canPush: false,
    commitFocusToken: 0,
    refreshChanges: async () => undefined,
    openReview: () => undefined,
    openDiff: () => undefined,
    stageFile: async () => undefined,
    unstageFile: async () => undefined,
    stageAll: async () => undefined,
    revertFile: async () => undefined,
    commit: async () => undefined,
    ...overrides,
  };
}

describe("ChangesPanel", () => {
  it("opens a changed file as a diff and commits the edited message", () => {
    const openDiff = vi.fn();
    const stageAll = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    render(
      <ChangesContext.Provider value={changesValue({ openDiff, stageAll, commit, canPush: true })}>
        <ChangesPanel active extensionName="Review Kit" />
      </ChangesContext.Provider>,
    );

    fireEvent.click(screen.getByTitle("src/a.ts"));
    expect(openDiff).toHaveBeenCalledWith("src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    expect(stageAll).toHaveBeenCalled();

    const message = screen.getByPlaceholderText("Commit message");
    expect(message).toHaveProperty("value", "Update a");
    fireEvent.change(message, { target: { value: "feat: a" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all & push" }));
    expect(commit).toHaveBeenCalledWith("feat: a", true);
    fireEvent.click(screen.getByRole("button", { name: "Commit all" }));
    expect(commit).toHaveBeenCalledWith("feat: a", false);
  });

  it("marks the file shown in the stage and leads with push when asked", () => {
    render(
      <ChangesContext.Provider value={changesValue({ activePath: `${CWD}/src/a.ts`, canPush: true, pushPrimary: true })}>
        <ChangesPanel active extensionName="Review Kit" />
      </ChangesContext.Provider>,
    );

    expect(screen.getByTitle("src/a.ts").parentElement?.className).toContain("active");
    expect(screen.getByRole("button", { name: "Commit all & push" }).className).toContain("primary");
  });
});

describe("FilesPanel", () => {
  it("opens a file on click and pins it on double-click", () => {
    const openFile = vi.fn();
    render(
      <ChangesContext.Provider value={changesValue({ changes: NO_CHANGES })}>
        <FilesContext.Provider value={{
          fileTree: [{ name: "a.ts", path: `${CWD}/a.ts`, kind: "file" }],
          snapshot: { cwd: CWD },
          activePath: `${CWD}/a.ts`,
          refreshFiles: async () => undefined,
          loadFiles: async () => [],
          openFile,
        }}>
          <FilesPanel active extensionName="Workspace" />
        </FilesContext.Provider>
      </ChangesContext.Provider>,
    );

    const row = screen.getByTitle(`${CWD}/a.ts`);
    expect(row.className).toContain("active");
    fireEvent.click(row);
    fireEvent.doubleClick(row);

    expect(openFile).toHaveBeenNthCalledWith(1, `${CWD}/a.ts`);
    expect(openFile).toHaveBeenNthCalledWith(2, `${CWD}/a.ts`, { pin: true });
  });
});
