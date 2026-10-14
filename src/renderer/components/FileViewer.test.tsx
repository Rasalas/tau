// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageFileTab } from "../../workbench/stage";
import type { CommandContribution, WorkbenchActions } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { READ_ONLY_REASON } from "../use-host-capabilities";
import type { UiFileContent } from "../../shared/workspace-kit-types";
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
  const viewer = (loadFile: (path: string) => Promise<UiFileContent>, onClose = vi.fn(), options: Partial<ComponentProps<typeof FileViewer>> = {}) => render(
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
        {...options}
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
    await screen.findByText(/There is no file at \/repo\/src\/a.ts/u);
    expect(screen.queryByText(/ENOENT/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows every full path checked for a missing worktree link", async () => {
    viewer(async () => { throw new Error("ENOENT: File not found. Checked /repo/tree/src/a.ts and /repo/main/src/a.ts."); });
    await screen.findByText(/Checked \/repo\/tree\/src\/a.ts and \/repo\/main\/src\/a.ts/u);
    expect(screen.queryByText(/any more/u)).toBeNull();
  });

  it("labels a main-checkout preview as read only in the header", async () => {
    viewer(async () => ({ path: "/repo/main/src/a.ts", name: "a.ts", kind: "text", text: "main report", size: 11, mainCheckoutPath: "/repo/main" }), vi.fn(), {
      editor: { name: "Editor", id: "editor" },
      commands: [{ id: "edit", label: "Edit file", group: "Project", access: "write", run: vi.fn() }],
      actions: { notify: vi.fn() } as unknown as WorkbenchActions,
    });
    const label = await screen.findByText(/from the main checkout/u);
    expect(label.closest("header")).toBeTruthy();
    expect(label.textContent).toContain("Read only");
    expect(label.getAttribute("title")).toBe("/repo/main/src/a.ts");
    expect(screen.queryByText("Edit file")).toBeNull();
    expect(screen.queryByText("Open in Editor")).toBeNull();
  });

  it("labels linked media from the main checkout in the tab header", async () => {
    viewer(async () => { throw new Error("Media should use its streaming loader"); }, vi.fn(), {
      relativePath: "clip.mp4",
      loadMedia: async () => ({ url: "blob:clip", mimeType: "video/mp4", mainCheckoutPath: "/repo/main", resolvedPath: "/repo/main/clip.mp4" }),
    });
    const label = await screen.findByText(/from the main checkout/u);
    expect(label.closest("header")).toBeTruthy();
    expect(label.getAttribute("title")).toBe("/repo/main/clip.mp4");
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

describe("FileViewer view switches", () => {
  const changedViewer = (view: "diff" | "source", onChangeView = vi.fn()) => render(
    <HostClientProvider client={createFakeHostClient()}>
      <FileViewer
        tab={{ id: "file:/repo/a.ts", kind: "file", path: "/repo/a.ts", view, preview: false }}
        relativePath="a.ts"
        changed
        loadFile={() => new Promise(() => undefined)}
        loadDiff={() => new Promise(() => undefined)}
        onChangeView={onChangeView}
        onOpenInEditor={() => undefined}
      />
    </HostClientProvider>,
  );

  it("offers Diff and Source as pressed toggles in a group, not as tabs without panels", () => {
    const onChangeView = vi.fn();
    changedViewer("diff", onChangeView);
    expect(screen.queryByRole("tablist")).toBeNull();
    const group = screen.getByRole("group", { name: "View" });
    expect(within(group).getByRole("button", { name: "Diff", pressed: true })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Source", pressed: false }));
    expect(onChangeView).toHaveBeenCalledWith("source");
  });

  it("names the diff layout group and presses the layout in use", () => {
    changedViewer("diff");
    const layout = screen.getByRole("group", { name: "Diff layout" });
    expect(within(layout).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")]))
      .toEqual([["Unified", "true"], ["Split", "false"]]);
  });
});
