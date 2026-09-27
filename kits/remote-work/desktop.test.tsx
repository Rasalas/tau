// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import remoteWork, { REMOTE_WORK_SETTINGS_PAGE } from "./desktop.js";
import { REMOTE_WORK_EXTENSION_ID as ID, THREAD_LINK_EVENT, TRANSFER_EVENT, type IgnoredFilesView, type RemoteThreadLink, type RepoTransfer } from "./protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const VIEW: IgnoredFilesView = {
  root: "/work/app",
  key: "github.com-acme-app-0123456789",
  candidates: [
    { path: ".env", kind: "file", reason: "env", files: 1, bytes: 14 },
    { path: ".scratch/", kind: "folder", reason: "issues", files: 3, bytes: 2048 },
  ],
  selected: [".env"],
  skipped: [{ path: "node_modules/", why: "build" }],
};

const step = (id: RepoTransfer["steps"][number]["id"], state: RepoTransfer["steps"][number]["state"], detail?: string) => ({ id, label: id, state, ...(detail ? { detail } : {}) });

const TRANSFER: RepoTransfer = {
  id: "abcdef0123456789",
  machine: "box2-id",
  machineName: "box2",
  root: "/work/app",
  repo: { key: VIEW.key, name: "app", source: "origin" },
  base: "b".repeat(40),
  head: "a".repeat(40),
  name: "Tidy",
  ignored: [".env"],
  createdAt: Date.now(),
  state: "ready",
  steps: [step("state", "done"), step("setup", "skipped")],
  remote: { path: "/home/box2/.tau/remote-work/worktrees/app/abcdef0123456789", branch: "tau/remote-abcdef0123456789" },
};

function setup(answer: (command: string, input?: unknown) => unknown, cwd: string | null = "/work/app", platform?: Parameters<typeof createKitHarness>[2]) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke, undefined, platform);
  registry.activate(remoteWork);
  const page = registry.getSettingsPages().find((entry) => entry.id === REMOTE_WORK_SETTINGS_PAGE)!;
  const props: SettingsPageProps = { onNotify: vi.fn(), ...(cwd ? { cwd } : {}) };
  render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
  const push = (transfer: RepoTransfer) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: ID, name: TRANSFER_EVENT, payload: transfer }));
  const pushLink = (link: RemoteThreadLink) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: ID, name: THREAD_LINK_EVENT, payload: link }));
  return { invoke, props, push, pushLink, page };
}

describe("Settings → Remote work", () => {
  it("offers the project's ignored files with what was ticked, and remembers a change through the host", async () => {
    const { invoke } = setup((command, input) => {
      if (command === "ignored-files") return VIEW;
      if (command === "set-ignored-files") return { ...VIEW, selected: (input as { paths: string[] }).paths };
      if (command === "transfers") return [];
      return undefined;
    });
    await flush();
    expect(screen.getByRole("switch", { name: "Send .env along" }).getAttribute("aria-checked")).toBe("true");
    const scratch = screen.getByRole("switch", { name: "Send .scratch/ along" });
    expect(scratch.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Notes or issues · 3 files · 2 KB/u)).toBeTruthy();
    expect(screen.getByText("node_modules/ (dependencies or build output)")).toBeTruthy();
    await act(async () => { fireEvent.click(scratch); });
    expect(invoke).toHaveBeenCalledWith(ID, "set-ignored-files", { cwd: "/work/app", paths: [".env", ".scratch/"] });
    expect(screen.getByRole("switch", { name: "Send .scratch/ along" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lists the project's transfers live, brings one back and merges it", async () => {
    const back: RepoTransfer = { ...TRANSFER, result: { state: "branch", branch: "tau/box2/tidy", tip: "c".repeat(40), commits: 2, files: 3, fetchedAt: Date.now() } };
    const { invoke, props, push } = setup((command) => {
      if (command === "ignored-files") return { ...VIEW, candidates: [], selected: [] };
      if (command === "transfers") return [];
      if (command === "fetch-result") return back;
      if (command === "apply") return { ...back, applied: { state: "conflict", at: Date.now(), files: ["src/app.js"], detail: "tau/box2/tidy conflicts with this checkout in 1 file; nothing was applied." } };
      return undefined;
    });
    await flush();
    expect(screen.getByText("No transfers yet")).toBeTruthy();
    push({ ...TRANSFER, state: "sending", steps: [step("state", "done"), step("upload", "running", "4 KB of 8 KB")] });
    expect(screen.getByText("Sending to box2…")).toBeTruthy();
    expect(screen.getByLabelText("upload: running, 4 KB of 8 KB")).toBeTruthy();
    // Another project's transfer is not this page's.
    push({ ...TRANSFER, id: "ffffffffffffffff", root: "/work/other", state: "ready" });
    push(TRANSFER);
    expect(screen.getByText(/Worktree on box2:/u)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Bring back" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "fetch-result", { transfer: TRANSFER.id });
    push(back);
    expect(screen.getByText("tau/box2/tidy: 2 commits, 3 files")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Merge" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "apply", { transfer: TRANSFER.id });
    expect(props.onNotify).toHaveBeenLastCalledWith("tau/box2/tidy conflicts with this checkout in 1 file; nothing was applied.");
    expect(screen.getAllByText(/box2 · Tidy/u)).toHaveLength(1);
  });

  it("shows the project's threads on other machines with their status and cost, and stops one", async () => {
    const link: RemoteThreadLink = {
      id: "link1", machine: "box2-id", machineName: "box2", cwd: "/work/app", root: "/work/app", title: "Say one word",
      transfer: TRANSFER.id, thread: "t1", status: "running", createdAt: Date.now(), updatedAt: Date.now(),
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 105, costUsd: 0.02, turns: 1 },
    };
    const { invoke, pushLink } = setup((command) => {
      if (command === "ignored-files") return { ...VIEW, candidates: [], selected: [] };
      if (command === "transfers") return [TRANSFER];
      if (command === "threads") return [link, { ...link, id: "elsewhere", root: "/work/other" }];
      if (command === "thread-abort") return { ...link, status: "idle", there: { thread: "t1", state: "idle", turns: 1, outcome: "aborted", updatedAt: 1, epoch: "e", revision: 2 } };
      return undefined;
    });
    await flush();
    expect(screen.getByText("Threads on other machines")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByLabelText("Cost there").textContent).toBe("$0.02");
    // Its transfer is steered from the thread's row, not listed twice.
    expect(screen.getByText("No transfers yet")).toBeTruthy();
    expect(screen.getAllByText(/box2 · Say one word/u)).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "thread-abort", { link: "link1" });

    pushLink({ ...link, status: "offline" });
    expect(screen.getByText("Offline · may still be running")).toBeTruthy();
    expect(screen.getByText("box2 is unreachable; the thread may still run there.")).toBeTruthy();
    pushLink({ ...link, status: "failed", error: "429 You exceeded your current quota." });
    expect(screen.getByText("429 You exceeded your current quota.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("opens a thread there, in a window that can show another machine", async () => {
    const link: RemoteThreadLink = {
      id: "link1", machine: "box2-id", machineName: "box2", cwd: "/work/app", root: "/work/app", title: "Colours",
      thread: "t1", status: "running", createdAt: Date.now(), updatedAt: Date.now(),
    };
    const open = vi.fn(async () => undefined);
    const answer = (command: string) => {
      if (command === "ignored-files") return { ...VIEW, candidates: [], selected: [] };
      if (command === "threads") return [link];
      return command === "transfers" ? [] : undefined;
    };
    setup(answer, "/work/app", { environments: { open } as unknown as PlatformEnvironments });
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open on box2" })); });
    expect(open).toHaveBeenCalledWith("box2-id", { threadId: "t1" });
    cleanup();
    // A browser or a phone cannot move to another machine.
    setup(answer);
    await flush();
    expect(screen.queryByRole("button", { name: "Open on box2" })).toBeNull();
  });

  it("lets go of a transfer only after asking, naming the machine", async () => {
    const { invoke } = setup((command) => {
      if (command === "ignored-files") return { ...VIEW, candidates: [], selected: [] };
      if (command === "transfers") return [TRANSFER];
      if (command === "discard") return { ...TRANSFER, state: "discarded" };
      return undefined;
    });
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Let go…" })); });
    expect(invoke).not.toHaveBeenCalledWith(ID, "discard", expect.anything());
    const dialog = screen.getByRole("dialog", { name: "Let go of the work on box2?" });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Let go" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "discard", { transfer: TRANSFER.id });
  });

  it("says when the ignored files could not be read, and reads them again", async () => {
    let calls = 0;
    setup((command) => {
      if (command === "ignored-files") { calls += 1; if (calls === 1) throw new Error("git ls-files failed"); return VIEW; }
      if (command === "transfers") return [];
      return undefined;
    });
    await flush();
    expect(screen.getByText("Tau could not read the ignored files")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    await flush();
    expect(screen.getByRole("switch", { name: "Send .env along" })).toBeTruthy();
  });

  it("gives every row the search names an element on the page", async () => {
    const link: RemoteThreadLink = {
      id: "link1", machine: "box2-id", machineName: "box2", cwd: "/work/app", root: "/work/app", title: "Colours",
      transfer: TRANSFER.id, thread: "t1", status: "idle", createdAt: Date.now(), updatedAt: Date.now(),
    };
    const { page } = setup((command) => (command === "ignored-files" ? VIEW : command === "transfers" ? [TRANSFER] : command === "threads" ? [link] : undefined));
    await flush();
    const rows = page.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(document.getElementById(row.id), row.label).toBeTruthy();
  });

  it("says what to do without an open project", () => {
    setup(() => undefined, null);
    expect(screen.getByText("No project open")).toBeTruthy();
  });
});
