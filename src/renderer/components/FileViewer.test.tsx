// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageFileTab } from "../../workbench/stage";
import type { CommandContribution, WorkbenchActions } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { READ_ONLY_REASON } from "../use-host-capabilities";
import { FileViewer } from "./FileViewer";

afterEach(cleanup);

describe("FileViewer on a Read-only device", () => {
  it("disables a file-tab command that writes, with the reason, and keeps one that only looks", () => {
    const edit: CommandContribution = { id: "files.edit", label: "Edit file", group: "Project", access: "write", run: vi.fn() };
    const reveal: CommandContribution = { id: "files.reveal", label: "Show in list", group: "Project", access: "read", run: vi.fn() };
    const tab = { id: "file:/repo/a.md", kind: "file", path: "/repo/a.md", view: "source", preview: false } as StageFileTab;
    render(
      <HostClientProvider client={createFakeHostClient({ isReadOnly: () => true })}>
        <FileViewer
          tab={tab}
          relativePath="a.md"
          changed={false}
          commands={[edit, reveal]}
          actions={{ notify: vi.fn() } as unknown as WorkbenchActions}
          loadFile={() => new Promise(() => undefined)}
          loadDiff={() => new Promise(() => undefined)}
          onChangeView={() => undefined}
          onOpenInEditor={() => undefined}
        />
      </HostClientProvider>,
    );
    const editButton = screen.getByText("Edit file") as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
    expect(editButton.getAttribute("data-tooltip")).toBe(READ_ONLY_REASON);
    fireEvent.click(screen.getByText("Show in list"));
    expect(reveal.run).toHaveBeenCalled();
    expect(edit.run).not.toHaveBeenCalled();
  });
});

describe("FileViewer loading", () => {
  const viewer = (loadFile: (path: string) => Promise<never>, onClose = vi.fn()) => render(
    <HostClientProvider client={createFakeHostClient()}>
      <FileViewer
        tab={{ id: "file:/repo/src/a.ts", kind: "file", path: "/repo/src/a.ts", view: "source", preview: false }}
        relativePath="src/a.ts"
        changed={false}
        loadFile={loadFile}
        loadDiff={() => new Promise(() => undefined)}
        onChangeView={() => undefined}
        onOpenInEditor={() => undefined}
        onClose={onClose}
      />
    </HostClientProvider>,
  );

  it("asks for a tab opened by its absolute path by the path inside its project", () => {
    const loadFile = vi.fn(() => new Promise<never>(() => undefined));
    viewer(loadFile);
    expect(loadFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("names a file that is gone instead of showing the raw error, and closes its tab", async () => {
    const onClose = vi.fn();
    viewer(async () => { throw new Error("ENOENT: no such file or directory, stat '/repo/src/a.ts'"); }, onClose);
    await screen.findByText("File not found");
    expect(screen.queryByText(/ENOENT/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says the project is gone when the host no longer knows it", async () => {
    viewer(async () => { throw new Error("Workspace is not a known Tau project."); });
    await screen.findByText("File not found");
    expect(screen.getByText(/Its project is not open in Tau any more/u)).toBeTruthy();
  });

  it("keeps another failure's own words", async () => {
    viewer(async () => { throw new Error("Not a file."); });
    await screen.findByText("Could not open this file");
    expect(screen.getByText(/Not a file\./u)).toBeTruthy();
  });
});
