// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFolderSource } from "./project-navigation";
import { workspaceHostStub } from "../test-support/workspace-host-stub";

afterEach(cleanup);

describe("LocalFolderSource", () => {
  it("fuzzy-filters and navigates folders without opening a native dialog", async () => {
    const listDirectories = vi.fn(async (path?: string) => path === "/repos/tau"
      ? { path: "/repos/tau", parent: "/repos", directories: [] }
      : { path: "/repos", parent: "/", directories: [
        { name: "satchel", path: "/repos/satchel" },
        { name: "tau", path: "/repos/tau" },
      ] });
    window.tau = { invokeHostExtension: workspaceHostStub({ listDirectories }) } as unknown as typeof window.tau;
    render(<LocalFolderSource actions={{ openWorkspace: vi.fn(async () => true) } as never} onBack={() => {}} onDone={() => {}} />);

    await screen.findByText("satchel");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter folders" }), { target: { value: "tu" } });
    expect(screen.queryByText("satchel")).toBeNull();
    fireEvent.click(screen.getByText("tau"));
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos/tau"));
  });
});
