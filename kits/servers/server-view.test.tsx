// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, StageTabHandle, UiFileDiff, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { createCompactPanel } from "./compact-panel.js";
import { DriftFeed } from "./drift-view.js";
import ServerView, { type ServerViewParts } from "./server-view.js";
import { createChangesSection, createRowMark, createTitleChip } from "./status-parts.js";
import { ServersStatusStore } from "./status-store.js";
import { SERVER_TARGET_TAB, SERVERS_STATUS_EVENT, type ServersStatus, type TargetStatus } from "./view-protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const BASE: TargetStatus = {
  targetId: "sftp-site-1", label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site", protocol: "sftp", context: "", level: "ask",
  state: "in-sync", checking: false, mirror: { commit: "c".repeat(40), at: new Date().toISOString(), files: 4 },
  pending: [], pendingTotal: 0, withheld: [], conflicts: [], liveConfigs: [], uncommittedThreads: [], checkedAt: new Date().toISOString(),
  serverGit: { repository: true, branch: "live", changed: 1, files: [{ path: "about.php", code: " M" }], commits: [{ sha: "a".repeat(40), subject: "Site as deployed" }] },
};
const PENDING: TargetStatus = {
  ...BASE, state: "pending", pendingTotal: 4, withheld: ["wp-config-local.php"],
  pending: [
    { path: "about.php", change: "deleted", selected: true },
    { path: "index.php", change: "modified", size: 22, selected: true },
    { path: "lib/new.php", change: "added", size: 6, selected: true },
    { path: "wp-config.php", change: "modified", size: 38, selected: false, credentials: ["WordPress database settings"] },
  ],
  liveConfigs: [{ path: "wp-config.php", label: "WordPress database settings" }],
};
const DIFF: UiFileDiff = { path: "index.php", added: 1, removed: 1, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "removed", oldLine: 1, text: "old line" }, { kind: "added", newLine: 1, text: "new line" }] }] };
const status = (target: TargetStatus, repository = true): ServersStatus => ({ workspace: "/work/site", file: "/work/site/.vscode/sftp.json", repository, targets: [target] });

function harness(target: TargetStatus, options: { readOnly?: boolean; repository?: boolean } = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
    if (command === "status" || command === "check") return status(target, options.repository ?? true);
    if (command === "link-folder") return { workspaceId: "w", path: "/work/site", commit: "b".repeat(40), branch: "main", files: 5, ignoredIn: "exclude", liveConfigs: 1 };
    if (command === "server-diff") return DIFF;
    if (command === "server-history") return { targetId: target.targetId, entries: [] };
    if (command === "ssh-terminal") return { command: "ssh -t fake" };
    if (command === "drift") return { workspace: "/work/site", branch: "main", targets: [{ targetId: target.targetId, label: target.label, context: "", check: { at: new Date().toISOString(), baseline: "mirror", files: [{ path: "css/site.css", change: "modified", certain: true }], later: false }, imports: [] }] };
    return undefined;
  });
  const host: HostExtensionClient = { invoke, onEvent: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, watch: vi.fn(() => () => undefined) };
  const store = new ServersStatusStore(host);
  const run = vi.fn(async () => ({ id: "t1" }));
  const drift = new DriftFeed({ host, events: { on: () => () => undefined } } as never);
  const parts: ServerViewParts = { store, host, drift, terminal: () => ({ run }) };
  const actions = { notify: vi.fn(), openStageTab: vi.fn(() => "tab"), openSettings: vi.fn(), activeThread: () => ({ cwd: "/work/site" }) } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  const wrap = (node: React.ReactNode) => <HostClientProvider client={client}><TestProviders>{node}</TestProviders></HostClientProvider>;
  return { invoke, host, store, parts, actions, run, wrap, emit: (payload: unknown) => act(() => listeners.get(SERVERS_STATUS_EVENT)?.(payload)) };
}

const handle = { id: "tab", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined } as unknown as StageTabHandle;

describe("the server view", () => {
  it("lists what an upload would take, deletions as their own group, and shows a file's diff", async () => {
    const h = harness(PENDING);
    render(h.wrap(<ServerView params={{ workspace: "/work/site", targetId: "sftp-site-1" }} handle={handle} actions={h.actions} parts={h.parts} />));
    await flush();
    expect(screen.getByRole("heading", { name: "site" })).toBeTruthy();
    expect(screen.getByText("Not uploaded", { selector: ".servers-state" })).toBeTruthy();
    expect(screen.getByText(/Server Git: live/u)).toBeTruthy();
    const deleted = screen.getByRole("region", { name: "Will be deleted on the server" });
    expect(within(deleted).getByText("about.php")).toBeTruthy();
    expect((within(deleted).getByRole("checkbox", { name: "Chosen for the upload: about.php" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Not chosen for the upload: wp-config.php" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Upload: 2 changed, 1 deleted…" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Never uploaded" }).textContent).toContain("wp-config-local.php");
    expect(screen.getByText(/Live credentials on the server: wp-config.php/u)).toBeTruthy();
    // The first file's diff shows at once; another opens on a click.
    expect(h.invoke).toHaveBeenCalledWith("server-diff", { cwd: "/work/site", targetId: "sftp-site-1", source: "pending", path: "about.php" });
    fireEvent.click(screen.getByRole("button", { name: "index.php, changed" }));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("server-diff", { cwd: "/work/site", targetId: "sftp-site-1", source: "pending", path: "index.php" });
    expect(handle.setTitle).toHaveBeenCalledWith("Server · site");
  });

  it("says a server is unreachable and checks it again on request", async () => {
    const h = harness({ ...PENDING, state: "unreachable", unreachable: "Could not connect to site: Connection refused" });
    render(h.wrap(<ServerView params={{ workspace: "/work/site", targetId: "sftp-site-1" }} handle={handle} actions={h.actions} parts={h.parts} />));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Connection refused");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(h.invoke).toHaveBeenCalledWith("check", { cwd: "/work/site", targetId: "sftp-site-1" });
  });

  it("offers the first download for a server never read, and opens an SSH terminal", async () => {
    const h = harness({ ...BASE, state: "never-read", mirror: undefined } as unknown as TargetStatus);
    render(h.wrap(<ServerView params={{ workspace: "/work/site", targetId: "sftp-site-1" }} handle={handle} actions={h.actions} parts={h.parts} />));
    await flush();
    expect(screen.getByText("Tau has not read this server yet")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download the server state" })); });
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("download", { cwd: "/work/site", targetId: "sftp-site-1" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open an SSH terminal" })); });
    await flush();
    expect(h.run).toHaveBeenCalledWith({ command: "ssh -t fake", label: "ssh site" }, h.actions);
  });

  it("gives a folder with sftp.json and no Git its Git from the server state, files untouched", async () => {
    const h = harness({ ...BASE, state: "never-read", mirror: undefined } as unknown as TargetStatus, { repository: false });
    render(h.wrap(<ServerView params={{ workspace: "/work/site", targetId: "sftp-site-1" }} handle={handle} actions={h.actions} parts={h.parts} />));
    await flush();
    expect(screen.getByText("This folder has no Git yet")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Make Git from the server state" })); });
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("link-folder", { path: "/work/site", exclude: {}, download: false });
    expect(h.actions.notify).toHaveBeenCalledWith(expect.stringMatching(/^Git made: 5 files of the server state on main \(bbbbbbb\)/u));
    expect(h.invoke).toHaveBeenCalledWith("check", { cwd: "/work/site", targetId: "sftp-site-1" });
  });

  it("follows the status the host publishes", async () => {
    const h = harness(BASE);
    render(h.wrap(<ServerView params={{ workspace: "/work/site", targetId: "sftp-site-1" }} handle={handle} actions={h.actions} parts={h.parts} />));
    await flush();
    expect(screen.getByText("Nothing to upload")).toBeTruthy();
    h.emit({ workspace: "/work/site", status: status({ ...BASE, state: "drift", drift: [{ path: "css/site.css", change: "modified", certain: true }] }) });
    fireEvent.click(screen.getByRole("tab", { name: "Changed on the server 1" }));
    await flush();
    // The tab is the drift service's panel, on the same state as the composer gate.
    expect(h.invoke).toHaveBeenCalledWith("drift", { cwd: "/work/site" });
    expect(screen.getByText("css/site.css")).toBeTruthy();
  });
});

describe("the status around the workbench", () => {
  it("marks the title bar with the worst state and opens that server's tab", async () => {
    const h = harness(PENDING);
    const Chip = createTitleChip(h.store);
    render(h.wrap(<Chip snapshot={{ cwd: "/work/site" } as never} actions={h.actions} />));
    await flush();
    const chip = screen.getByRole("button", { name: "Servers: Not uploaded" });
    expect(chip.textContent).toContain("4");
    fireEvent.click(chip);
    expect(h.actions.openStageTab).toHaveBeenCalledWith(SERVER_TARGET_TAB, { workspace: "/work/site", targetId: "sftp-site-1" });
  });

  it("draws nothing for a project without servers", async () => {
    const h = harness(BASE);
    h.invoke.mockImplementation(async () => ({ workspace: "/work/plain", targets: [] }));
    const Chip = createTitleChip(h.store);
    const { container } = render(h.wrap(<Chip snapshot={{ cwd: "/work/plain" } as never} actions={h.actions} />));
    await flush();
    expect(container.textContent).toBe("");
  });

  it("puts a line in the Changes panel and marks a thread with a deployment not committed", async () => {
    const h = harness({ ...PENDING, uncommittedThreads: ["t-1"] });
    const workspace = { getSnapshot: () => ({ cwd: "/work/site" }), subscribe: () => () => undefined, registerChangesSection: vi.fn(), registerThreadRowAccessory: vi.fn() };
    const Section = createChangesSection(h.store, () => workspace);
    const Mark = createRowMark(h.store);
    render(h.wrap(<>
      <Section actions={h.actions} />
      <Mark session={{ id: "t-1", projectPath: "/work/site" } as never} />
      <Mark session={{ id: "t-2", projectPath: "/work/site" } as never} />
    </>));
    await flush();
    expect(screen.getByText(/4 files not uploaded/u)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Deployed to site, not committed yet" })).toHaveLength(1);
  });
});

describe("the servers on a compact client", () => {
  function sheet(target: TargetStatus, readOnly: boolean) {
    const h = harness(target, { readOnly });
    const Panel = createCompactPanel(h.parts);
    const props = { active: true, placement: "stage", extensionName: "Servers", actions: h.actions } as PanelProps;
    render(h.wrap(<WorkbenchShellContext.Provider value={{ snapshot: { cwd: "/work/site" }, registry: {} } as never}><Panel {...props} /></WorkbenchShellContext.Provider>));
    return h;
  }

  it("shows a Read-only device the status and disables the writes with the reason", async () => {
    const h = sheet({ ...BASE, state: "never-read", mirror: undefined } as unknown as TargetStatus, true);
    await flush();
    expect(screen.getByRole("heading", { name: "site" })).toBeTruthy();
    expect(screen.getByText("Tau has not read this server yet.")).toBeTruthy();
    const download = screen.getByRole("button", { name: "Download" }) as HTMLButtonElement;
    const ssh = screen.getByRole("button", { name: "SSH" }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(ssh.disabled).toBe(true);
    expect(download.getAttribute("data-tooltip")).toMatch(/read only/iu);
    expect((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
    expect(h.invoke).toHaveBeenCalledWith("check", { cwd: "/work/site", targetId: "sftp-site-1" });
  });

  it("lists what is not uploaded and the history, and shows a file's diff on a tap", async () => {
    const h = sheet(PENDING, false);
    await flush();
    expect(screen.getByRole("region", { name: "Will be deleted on the server" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "index.php, changed" }));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("server-diff", { cwd: "/work/site", targetId: "sftp-site-1", source: "pending", path: "index.php" });
    fireEvent.click(screen.getByRole("button", { name: /History/u }));
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("server-history", { cwd: "/work/site", targetId: "sftp-site-1" });
    expect(screen.getByText("No history yet.")).toBeTruthy();
  });
});
