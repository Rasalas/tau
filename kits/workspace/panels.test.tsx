// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiWorkspaceChanges, WorkbenchContextValue } from "tau";
import { PreferencesStore, RendererServicesProvider, WorkbenchContext } from "../../src/renderer/test-support/kit-harness.js";
import { ChangesPanel, FilesPanel, serviceSlot, type SearchFilesService } from "./panels.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CWD = "/repo";
const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const CHANGED: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1, removed: 0, proposedMessage: "Update a",
};

const newStore = () => new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient(async () => undefined));

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

/** The panels find the store the way activation binds it: through the kit's own provider. */
function withServices(workspaceStore: WorkspaceStore, children: ReactNode) {
  const Bound = withWorkspaceStore(workspaceStore, () => <>{children}</>);
  return <RendererServicesProvider services={{ preferences: new PreferencesStore() }}><Bound /></RendererServicesProvider>;
}

describe("ChangesPanel", () => {
  it("opens a changed file as a diff and commits the edited message", () => {
    const workspaceStore = newStore();
    kitState(workspaceStore, { workspace: { root: CWD, isRepo: true, isDirty: true, upstream: "origin/main", worktrees: [], refs: [], worktreeParent: "/" } });
    const openDiff = vi.spyOn(workspaceStore, "openDiff").mockImplementation(() => undefined);
    const stageAll = vi.spyOn(workspaceStore, "stageAll").mockResolvedValue(undefined);
    const commit = vi.spyOn(workspaceStore, "commit").mockResolvedValue(true);
    vi.spyOn(workspaceStore, "refreshChanges").mockResolvedValue(undefined);
    render(withServices(workspaceStore,
      <WorkbenchContext.Provider value={workbench()}>
        <ChangesPanel active extensionName="Review Kit" actions={{} as never} />
      </WorkbenchContext.Provider>,
    ));

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
    const workspaceStore = newStore();
    kitState(workspaceStore, { pushPrimary: true, workspace: { root: CWD, isRepo: true, isDirty: true, upstream: "origin/main", worktrees: [], refs: [], worktreeParent: "/" } });
    vi.spyOn(workspaceStore, "refreshChanges").mockResolvedValue(undefined);
    render(withServices(workspaceStore,
      <WorkbenchContext.Provider value={workbench({ activeDocumentPath: `${CWD}/src/a.ts` })}>
        <ChangesPanel active extensionName="Review Kit" actions={{} as never} />
      </WorkbenchContext.Provider>,
    ));

    expect(screen.getByTitle("src/a.ts").parentElement?.className).toContain("active");
    expect(screen.getByRole("button", { name: "Commit all & push" }).className).toContain("primary");
  });
});

describe("FilesPanel", () => {
  it("opens a file on click and pins it on double-click", () => {
    const workspaceStore = newStore();
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

  it("reads a file in a phone's sheet, where no stage shows it, and goes back to the folders as they were", async () => {
    const workspaceStore = newStore();
    const openFile = vi.fn();
    kitState(workspaceStore, { changes: NO_CHANGES, fileTree: [{ name: "src", path: "src", kind: "directory", children: [{ name: "a.ts", path: "src/a.ts", kind: "file" }] }] });
    vi.spyOn(workspaceStore, "refreshFiles").mockResolvedValue(undefined);
    const readFile = vi.spyOn(workspaceStore.host, "readFile").mockResolvedValue({ path: "src/a.ts", name: "a.ts", size: 24, kind: "text", text: "export const answer = 42;\n" });
    render(withServices(workspaceStore,
      <WorkbenchContext.Provider value={workbench({ openFile })}>
        <FilesPanel active placement="sheet" extensionName="Workspace" actions={{} as never} />
      </WorkbenchContext.Provider>,
    ));

    fireEvent.click(screen.getByTitle("src"));
    fireEvent.click(await screen.findByTitle("src/a.ts"));
    expect(await screen.findByText("export const answer = 42;")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith("src/a.ts");
    expect(openFile).not.toHaveBeenCalled();
    expect(screen.getByRole("note").textContent).toContain("Read only on a phone");
    // A double tap is no way into an editor a phone does not draw.
    expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to the files" }));
    expect(screen.getByRole("heading", { name: "Files" })).toBeTruthy();
    expect(screen.getByTitle("src/a.ts")).toBeTruthy();
  });

  it("offers Search Kit's Go to file once it is there, and reads the pick in a phone's sheet", async () => {
    const workspaceStore = newStore();
    kitState(workspaceStore, { changes: NO_CHANGES, fileTree: [] });
    vi.spyOn(workspaceStore, "refreshFiles").mockResolvedValue(undefined);
    vi.spyOn(workspaceStore.host, "readFile").mockResolvedValue({ path: "b.md", name: "b.md", size: 5, kind: "text", text: "# B\n" });
    const search = serviceSlot<SearchFilesService>();
    const view = (placement: "dock" | "sheet") => withServices(workspaceStore,
      <WorkbenchContext.Provider value={workbench()}>
        <FilesPanel active placement={placement} extensionName="Workspace" actions={{} as never} search={search} />
      </WorkbenchContext.Provider>,
    );
    const { rerender } = render(view("dock"));
    expect(screen.queryByRole("button", { name: "Go to file" })).toBeNull();

    const pickFile = vi.fn<SearchFilesService["pickFile"]>();
    act(() => search.set({ pickFile }));
    fireEvent.click(screen.getByRole("button", { name: "Go to file" }));
    expect(pickFile).toHaveBeenLastCalledWith(undefined);

    rerender(view("sheet"));
    fireEvent.click(screen.getByRole("button", { name: "Go to file" }));
    const onPick = pickFile.mock.lastCall?.[0];
    expect(onPick).toBeTypeOf("function");
    act(() => onPick!("b.md"));
    expect(await screen.findByText("# B")).toBeTruthy();
  });
});
