// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import type { DeployPreview, DeployResult } from "./deploy-protocol.js";
import { DriftFeed } from "./drift-view.js";
import type { ServerViewParts } from "./server-view.js";
import { ServersStatusStore } from "./status-store.js";
import { UploadPanel } from "./upload-panel.js";
import type { TargetStatus } from "./view-protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const TARGET: TargetStatus = {
  targetId: "sftp-site-1", label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site", protocol: "sftp", context: "", level: "ask",
  state: "pending", checking: false, mirror: { commit: "c".repeat(40), at: new Date().toISOString(), files: 6 },
  pendingTotal: 6, withheld: [], conflicts: [], liveConfigs: [], uncommittedThreads: [],
  pending: [
    { path: "about.php", change: "deleted", selected: true },
    { path: "contact.php", change: "deleted", selected: true },
    { path: "index.php", change: "modified", size: 22, selected: true },
    { path: "lib/new.php", change: "added", size: 6, selected: true },
    { path: "shop.php", change: "modified", size: 9, selected: false, blocked: "The server change on server-drift/2026-09-25 is not merged yet; uploading this file would undo it. Merge the branch first." },
    { path: "wp-config.php", change: "modified", size: 38, selected: false, credentials: ["WordPress database settings"] },
  ],
};

const PREVIEW: DeployPreview = {
  targetId: "sftp-site-1",
  files: [
    { path: "lib/new.php", op: "add", outcome: "upload" },
    { path: "about.php", op: "delete", outcome: "delete", server: { size: 20, mtime: 1, mode: 0o644 } },
    { path: "index.php", op: "modify", outcome: "conflict", reason: "Changed on the server since Tau last read it.", server: { size: 30, mtime: 2, mode: 0o640 } },
  ],
  kept: ["contact.php"],
  warnings: ["index.php last went up from feature; this upload is from main."],
};

function harness(options: { readOnly?: boolean; result?: DeployResult } = {}) {
  const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
    if (command === "status") return { workspace: "/work/site", repository: true, targets: [TARGET] };
    if (command === "deploy-preview") return PREVIEW;
    if (command === "deploy") return options.result ?? { targetId: "sftp-site-1", files: [], failed: [] };
    if (command === "deploy-resolve") return { path: "index.php", action: "merge", conflicts: 2 };
    return undefined;
  });
  const host: HostExtensionClient = { invoke, onEvent: () => () => undefined, watch: vi.fn(() => () => undefined) };
  const store = new ServersStatusStore(host);
  const drift = new DriftFeed({ host, events: { on: () => () => undefined } } as never);
  const parts: ServerViewParts = { store, host, drift, terminal: () => undefined };
  const actions = { notify: vi.fn(), activeThread: () => ({ sessionId: "thread-7", cwd: "/work/site", draftPending: false }) } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  const onOpen = vi.fn();
  render(<HostClientProvider client={client}><TestProviders><UploadPanel parts={parts} actions={actions} cwd="/work/site" target={TARGET} onOpen={onOpen} /></TestProviders></HostClientProvider>);
  return { invoke, actions, onOpen };
}

const box = (path: string) => screen.getByRole("checkbox", { name: new RegExp(`for the upload: ${path.replace(".", "\\.")}$`, "u") }) as HTMLInputElement;

describe("the upload", () => {
  it("chooses deletions by default, leaves one out only on a second click, and names the count on the button", async () => {
    harness();
    expect(box("about.php").checked).toBe(true);
    expect(box("wp-config.php").checked).toBe(false);
    expect(box("shop.php").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Upload: 2 changed, 2 deleted…" })).toBeTruthy();

    fireEvent.click(box("contact.php"));
    // Not yet: the row asks first.
    expect(box("contact.php").checked).toBe(true);
    const ask = screen.getByRole("group", { name: "Leave contact.php on the server?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Leave on the server" }));
    expect(box("contact.php").checked).toBe(false);
    expect(screen.getByText("Stays on the server")).toBeTruthy();
    expect(screen.getByText("1 deletion stays on the server")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload: 2 changed, 1 deleted…" })).toBeTruthy();
    // Choosing it again takes one click.
    fireEvent.click(box("contact.php"));
    expect(box("contact.php").checked).toBe(true);
  });

  it("previews against the server, overwrites a conflict only on the user's word, and uploads what the button says", async () => {
    const h = harness({
      result: {
        targetId: "sftp-site-1",
        files: [{ path: "lib/new.php", op: "add", outcome: "upload" }, { path: "about.php", op: "delete", outcome: "delete" }, { path: "index.php", op: "modify", outcome: "conflict", forced: true }],
        failed: [],
        deployment: {
          seq: 3, kind: "upload", at: new Date().toISOString(), origin: { actor: "user", via: "view", threadId: "thread-7" }, checkout: { path: "/work/site", branch: "main" }, context: "",
          files: [{ path: "about.php", op: "delete", before: "a".repeat(40) }, { path: "index.php", op: "modify", after: "b".repeat(40) }, { path: "lib/new.php", op: "add", after: "c".repeat(40) }],
          failed: [], skipped: [], status: "uploaded", commit: "d".repeat(40), mirrorCommit: "d".repeat(40),
        },
      },
    });
    fireEvent.click(box("contact.php"));
    fireEvent.click(within(screen.getByRole("group", { name: "Leave contact.php on the server?" })).getByRole("button", { name: "Leave on the server" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload: 2 changed, 1 deleted…" })); });
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("deploy-preview", {
      cwd: "/work/site", targetId: "sftp-site-1", force: [],
      files: [{ path: "about.php", op: "delete" }, { path: "index.php", op: "modify" }, { path: "lib/new.php", op: "add" }],
    });
    expect(within(screen.getByRole("region", { name: "Goes up" })).getByText("lib/new.php")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Deleted on the server" })).getByText("about.php")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Stays on the server" })).getByText("contact.php")).toBeTruthy();
    expect(screen.getByText("index.php last went up from feature; this upload is from main.")).toBeTruthy();
    const conflicts = screen.getByRole("region", { name: "Changed on the server" });
    expect(screen.getByRole("button", { name: "Upload: 1 changed, 1 deleted" })).toBeTruthy();

    fireEvent.click(within(conflicts).getByRole("button", { name: "Overwrite anyway…" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Overwrite index.php on the server?" })).getByRole("button", { name: "Overwrite" }));
    expect(within(conflicts).getByText("Will overwrite the server's change")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload: 2 changed, 1 deleted" })); });
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("deploy", {
      cwd: "/work/site", targetId: "sftp-site-1", force: ["index.php"], threadId: "thread-7",
      files: [{ path: "lib/new.php", op: "add" }, { path: "about.php", op: "delete" }, { path: "index.php", op: "modify" }],
    });
    expect(screen.getByRole("status").textContent).toContain("Deployment 3: 2 changed, 1 deleted on the server.");
    expect(within(screen.getByRole("region", { name: "Uploaded" })).getByText("index.php")).toBeTruthy();
    expect(h.invoke).toHaveBeenCalledWith("status", { cwd: "/work/site", fresh: true });
  });

  it("merges a conflict into the local file on a click and says how many conflicts it marked", async () => {
    const h = harness();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload: 2 changed, 2 deleted…" })); });
    await flush();
    await act(async () => { fireEvent.click(within(screen.getByRole("region", { name: "Changed on the server" })).getByRole("button", { name: "Merge" })); });
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("deploy-resolve", { cwd: "/work/site", targetId: "sftp-site-1", path: "index.php", action: "merge" });
    expect(h.actions.notify).toHaveBeenCalledWith("index.php merged with 2 conflicts marked; resolve them, then upload.");
    expect(h.onOpen).toHaveBeenCalledWith("index.php");
    // Back at the list.
    expect(screen.getByRole("button", { name: "Upload: 2 changed, 2 deleted…" })).toBeTruthy();
  });

  it("uploads nothing from a Read-only device", async () => {
    harness({ readOnly: true });
    expect(box("index.php").disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Upload: 2 changed, 2 deleted…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the files that failed and those that did not go", async () => {
    harness({ result: { targetId: "sftp-site-1", files: [{ path: "lib/new.php", op: "add", outcome: "upload" }, { path: "index.php", op: "modify", outcome: "conflict", reason: "Changed on the server during the upload." }], failed: [{ path: "lib/new.php", op: "add", message: "Permission denied: lib/new.php" }] } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload: 2 changed, 2 deleted…" })); });
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upload: 1 changed, 1 deleted" })); });
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Nothing was uploaded.");
    expect(within(screen.getByRole("region", { name: "Failed" })).getByText("Permission denied: lib/new.php")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Changed on the server" })).getByText("Changed on the server during the upload.")).toBeTruthy();
  });
});
