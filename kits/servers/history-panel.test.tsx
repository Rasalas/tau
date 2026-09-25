// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { DriftFeed } from "./drift-view.js";
import { HistoryPanel } from "./history-panel.js";
import type { RollbackPreview, RollbackResult } from "./rollback-protocol.js";
import type { ServerViewParts } from "./server-view.js";
import { ServersStatusStore } from "./status-store.js";
import type { ServerHistory, TargetStatus } from "./view-protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const TARGET: TargetStatus = {
  targetId: "sftp-site-1", label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site", protocol: "sftp", context: "", level: "ask",
  state: "in-sync", checking: false, mirror: { commit: "c".repeat(40), at: new Date().toISOString(), files: 6 },
  pendingTotal: 0, pending: [], withheld: [], conflicts: [], liveConfigs: [], uncommittedThreads: [], deployments: "1:committed 2:uploaded",
};

const at = new Date().toISOString();
const HISTORY: ServerHistory = {
  targetId: "sftp-site-1",
  truncated: true,
  entries: [
    { commit: "2".repeat(40), parent: "1".repeat(40), at, subject: "Deployment 2: 1 changed", kind: "change", added: 0, modified: 1, deleted: 0, files: [{ path: "index.php", change: "modified" }], deployment: { seq: 2, kind: "upload", status: "uploaded", branch: "main", failed: 0 } },
    { commit: "1".repeat(40), parent: "0".repeat(40), at, subject: "Deployment 1: 2 changed", kind: "change", added: 1, modified: 1, deleted: 0, files: [{ path: "index.php", change: "modified" }, { path: "new.php", change: "added" }], deployment: { seq: 1, kind: "upload", status: "committed", branch: "main", failed: 0 } },
  ],
};

const PREVIEW: RollbackPreview = {
  targetId: "sftp-site-1", seq: 1, newer: [2], threeWay: false,
  files: [
    { path: "index.php", op: "modify", outcome: "conflict", newer: 2, reason: "Deployment 2 changed this file afterwards. Roll that back first, or merge three-way." },
    { path: "new.php", op: "delete", outcome: "delete" },
  ],
};

function harness(options: { readOnly?: boolean } = {}) {
  const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
    const request = input as { threeWay?: boolean; seq?: number } | undefined;
    if (command === "server-history") return HISTORY;
    if (command === "rollback-preview") {
      if (request?.seq === 2) return { targetId: "sftp-site-1", seq: 2, newer: [], threeWay: false, files: [{ path: "index.php", op: "modify", outcome: "upload" }] };
      return request?.threeWay ? { ...PREVIEW, threeWay: true, files: [{ ...PREVIEW.files[0]!, outcome: "upload", merged: true, reason: "Merged." }, PREVIEW.files[1]!] } : PREVIEW;
    }
    if (command === "rollback") {
      const result: RollbackResult = { ...PREVIEW, rolledBack: false, failed: [], deployment: { seq: 3, kind: "rollback", rollbackOf: 1, files: [{ path: "new.php", op: "delete" }] } as never };
      return result;
    }
    if (command === "deployment-mark") return { seq: 2, status: "verified" };
    return undefined;
  });
  const host: HostExtensionClient = { invoke, onEvent: () => () => undefined, watch: vi.fn(() => () => undefined) };
  const store = new ServersStatusStore(host);
  const drift = new DriftFeed({ host, events: { on: () => () => undefined } } as never);
  const parts: ServerViewParts = { store, host, drift, terminal: () => undefined };
  const actions = { notify: vi.fn(), activeThread: () => ({ sessionId: "thread-7", cwd: "/work/site", draftPending: false }) } as unknown as WorkbenchActions;
  const client = createFakeHostClient({ isReadOnly: () => options.readOnly === true });
  const onFile = vi.fn();
  render(<HostClientProvider client={client}><TestProviders><HistoryPanel parts={parts} actions={actions} cwd="/work/site" target={TARGET} active={undefined} onFile={onFile} main={<p>diff</p>} /></TestProviders></HostClientProvider>);
  return { invoke, actions, onFile };
}

describe("the history tab", () => {
  it("shows each deployment's status, marks one checked and says when older history was cleaned up", async () => {
    const { invoke } = harness();
    await flush();
    expect(screen.getByText("Deployment 2")).toBeTruthy();
    expect(screen.getByText("committed")).toBeTruthy();
    expect(screen.getByText(/Older history was cleaned up/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark as checked" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("deployment-mark", { cwd: "/work/site", targetId: "sftp-site-1", seq: 2, checked: true });
    expect(invoke.mock.calls.filter(([command]) => command === "server-history")).toHaveLength(2);
  });

  it("previews a rollback, names the newer deployment, merges three-way on request and rolls back on the click", async () => {
    const { invoke } = harness();
    await flush();
    // Open deployment 1 and ask for its rollback.
    fireEvent.click(screen.getByText("Deployment 1"));
    fireEvent.click(screen.getByRole("button", { name: "Roll back…" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("rollback-preview", { cwd: "/work/site", targetId: "sftp-site-1", seq: 1, threeWay: false });
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Deployment 2 changed some of these files afterwards. Roll it back first, or merge three-way.");
    expect(screen.getByRole("button", { name: "Roll back: 1 deleted" })).toBeTruthy();
    // Overwriting takes a second click.
    const conflict = screen.getByRole("region", { name: "Changed on the server since" });
    fireEvent.click(within(conflict).getByRole("button", { name: "Overwrite anyway…" }));
    expect(within(conflict).getByText(/Deployment 2's change there is lost/u)).toBeTruthy();
    fireEvent.click(within(conflict).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Merge three-way" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("rollback-preview", { cwd: "/work/site", targetId: "sftp-site-1", seq: 1, threeWay: true });
    expect(screen.getByRole("region", { name: "Merges three-way" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back: 1 changed, 1 deleted" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("rollback", { cwd: "/work/site", targetId: "sftp-site-1", seq: 1, threeWay: true, force: [], threadId: "thread-7" });
    expect(screen.getByRole("status").textContent).toContain("Rollback 3: 1 deleted on the server.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.getByRole("list", { name: "History" })).toBeTruthy();
  });

  it("goes to the newer deployment's rollback from the note", async () => {
    const { invoke } = harness();
    await flush();
    fireEvent.click(screen.getByText("Deployment 1"));
    fireEvent.click(screen.getByRole("button", { name: "Roll back…" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Roll back 2 first" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("rollback-preview", { cwd: "/work/site", targetId: "sftp-site-1", seq: 2, threeWay: false });
    expect(screen.getByRole("heading", { name: "Roll back deployment 2" })).toBeTruthy();
  });

  it("disables rolling back and marking on a read-only device, with the reason", async () => {
    harness({ readOnly: true });
    await flush();
    const rollBack = screen.getByRole("button", { name: "Roll back…" }) as HTMLButtonElement;
    expect(rollBack.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Mark as checked" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
