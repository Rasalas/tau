// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { LocalFolderSource } from "./navigation.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

describe("LocalFolderSource", () => {
  it("fuzzy-filters and navigates folders without opening a native dialog", async () => {
    const listDirectories = vi.fn(async (path?: string) => path === "/repos/tau"
      ? { path: "/repos/tau", parent: "/repos", directories: [] }
      : { path: "/repos", parent: "/", directories: [
        { name: "satchel", path: "/repos/satchel" },
        { name: "tau", path: "/repos/tau" },
      ] });
    const stub = workspaceHostStub({ listDirectories });
    setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
    const store = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
    const Source = withWorkspaceStore(store, LocalFolderSource);
    render(<Source actions={{ openWorkspace: vi.fn(async () => true) } as never} onBack={() => {}} onDone={() => {}} />);

    await screen.findByText("satchel");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter folders" }), { target: { value: "tu" } });
    expect(screen.queryByText("satchel")).toBeNull();
    fireEvent.click(screen.getByText("tau"));
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos/tau"));
  });
});
