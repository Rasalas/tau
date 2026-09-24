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
