// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import servers from "./desktop.js";
import type { DraftListing, FolderInspection, ProjectMade } from "./project-plan.js";
import type { ScanSummary } from "./sync/protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const MB = 1024 * 1024;

const LISTING: DraftListing = { path: "/srv/site", parent: "/srv", directories: [{ name: "wp-content", path: "/srv/site/wp-content" }], files: 2 };
const SUMMARY: ScanSummary = {
  targetId: "draft", root: "/srv/site", method: "shell", files: 120, bytes: 90 * MB, ignoredFolders: [], ignoredFiles: 0, skipped: 0, gitRules: false,
  folders: [
    { path: "wp-content", files: 118, bytes: 89 * MB },
    { path: "wp-content/plugins", files: 100, bytes: 9 * MB },
    { path: "wp-content/uploads", files: 18, bytes: 80 * MB },
  ],
};
const MADE: ProjectMade = { workspaceId: "ws1_shop", path: "/work/site", commit: "c".repeat(40), branch: "main", files: 102, ignoredIn: "gitignore", liveConfigs: 0 };

function setup(answer: (command: string, input?: unknown) => unknown) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(servers);
  const source = registry.getProjectSources().find((entry) => entry.id === "servers.from-server")!;
  const actions = { notify: vi.fn(), openWorkspace: vi.fn(async () => true) } as unknown as WorkbenchActions;
  const onDone = vi.fn();
  const Component = source.Component!;
  const view = render(<TestProviders preferences={preferences}><Component actions={actions} onBack={vi.fn()} onDone={onDone} /></TestProviders>);
  return { invoke, actions, onDone, view };
}

describe("From a server…", () => {
  it("connects to an ssh host, sizes the folder with uploads left out, and opens the project it made", async () => {
    const { invoke, actions, onDone, view } = setup((command) => ({
      "ssh-hosts": { configPath: "/test/ssh_config", hosts: ["fake"], problems: [] },
      "draft-browse": LISTING,
      "draft-scan": SUMMARY,
      "create-project": MADE,
    } as Record<string, unknown>)[command]);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "draft-browse", { server: { alias: "fake" } });
    expect(screen.getByRole("list", { name: "Folders in /srv/site" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "draft-scan", { server: { alias: "fake" }, remotePath: "/srv/site" });
    const uploads = screen.getByText("uploads/").closest("label")!.querySelector("input")!;
    expect(uploads.checked).toBe(false);
    expect(screen.getByText(/102 files · 10 MB come down\. Left on the server .*wp-content\/uploads\//u)).toBeTruthy();
    expect((screen.getByLabelText("New folder") as HTMLInputElement).value).toBe("site");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "create-project", { server: { alias: "fake" }, remotePath: "/srv/site", parent: "~", name: "site", exclude: ["wp-content/uploads"] });
    expect(onDone).toHaveBeenCalled();
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws1_shop");
    view.unmount();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "draft-close", undefined);
  });

  it("gives a folder with sftp.json its Git after sizing each server", async () => {
    const inspection: FolderInspection = {
      path: "/work/site", hasGit: false, empty: false, issues: [],
      targets: [{ id: "sftp-live-1", configKey: "live", source: "sftp.json", label: "live", context: "", profiles: [], protocol: "sftp", host: "fake", port: 22, remotePath: "/srv/site", password: "None", issues: [], usable: true }],
    };
    const { invoke, actions } = setup((command) => ({
      "ssh-hosts": { configPath: "/test/ssh_config", hosts: [], problems: [] },
      "inspect-folder": inspection,
      "link-scan": SUMMARY,
      "link-folder": MADE,
    } as Record<string, unknown>)[command]);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Folder with sftp.json" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/work/site" } });
    fireEvent.click(screen.getByRole("button", { name: "Read sftp.json" }));
    await flush();
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "link-scan", { path: "/work/site", targetId: "sftp-live-1" });
    fireEvent.click(screen.getByRole("button", { name: "Create Git repository" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("tau.servers", "link-folder", { path: "/work/site", exclude: { "sftp-live-1": ["wp-content/uploads"] }, download: false });
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws1_shop");
  });

  it("says what the host refused", async () => {
    setup((command) => {
      if (command === "ssh-hosts") return { configPath: "/test/ssh_config", hosts: ["fake"], problems: [] };
      throw new Error("Connection refused: loopback only (203.0.113.9).");
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("loopback only");
  });
});
