// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import remoteWork, { REMOTE_WORK_SETTINGS_PAGE } from "./desktop.js";
import { REMOTE_WORK_EXTENSION_ID as ID, TRANSFER_EVENT, type IgnoredFilesView, type RepoTransfer } from "./protocol.js";

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
  machine: "rex-id",
  machineName: "rex",
  root: "/work/app",
  repo: { key: VIEW.key, name: "app", source: "origin" },
  base: "b".repeat(40),
  head: "a".repeat(40),
  name: "Tidy",
  ignored: [".env"],
  createdAt: Date.now(),
  state: "ready",
  steps: [step("state", "done"), step("setup", "skipped")],
  remote: { path: "/home/rex/.tau/remote-work/worktrees/app/abcdef0123456789", branch: "tau/remote-abcdef0123456789" },
};

function setup(answer: (command: string, input?: unknown) => unknown, cwd: string | null = "/work/app") {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(remoteWork);
  const page = registry.getSettingsPages().find((entry) => entry.id === REMOTE_WORK_SETTINGS_PAGE)!;
  const props: SettingsPageProps = { onNotify: vi.fn(), ...(cwd ? { cwd } : {}) };
  render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
  const push = (transfer: RepoTransfer) => act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: ID, name: TRANSFER_EVENT, payload: transfer }));
  return { invoke, props, push };
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
    expect(screen.getByText(/Never sent: node_modules\/ \(dependencies or build output\)/u)).toBeTruthy();
    await act(async () => { fireEvent.click(scratch); });
    expect(invoke).toHaveBeenCalledWith(ID, "set-ignored-files", { cwd: "/work/app", paths: [".env", ".scratch/"] });
    expect(screen.getByRole("switch", { name: "Send .scratch/ along" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lists the project's transfers live, brings one back and merges it", async () => {
    const back: RepoTransfer = { ...TRANSFER, result: { state: "branch", branch: "tau/rex/tidy", tip: "c".repeat(40), commits: 2, files: 3, fetchedAt: Date.now() } };
    const { invoke, props, push } = setup((command) => {
      if (command === "ignored-files") return { ...VIEW, candidates: [], selected: [] };
      if (command === "transfers") return [];
      if (command === "fetch-result") return back;
      if (command === "apply") return { ...back, applied: { state: "conflict", at: Date.now(), files: ["src/app.js"], detail: "tau/rex/tidy conflicts with this checkout in 1 file; nothing was applied." } };
      return undefined;
    });
    await flush();
    expect(screen.getByText("No transfers yet")).toBeTruthy();
    push({ ...TRANSFER, state: "sending", steps: [step("state", "done"), step("upload", "running", "4 KB of 8 KB")] });
    expect(screen.getByText("Sending to rex…")).toBeTruthy();
    expect(screen.getByLabelText("upload: running, 4 KB of 8 KB")).toBeTruthy();
    // Another project's transfer is not this page's.
    push({ ...TRANSFER, id: "ffffffffffffffff", root: "/work/other", state: "ready" });
    push(TRANSFER);
    expect(screen.getByText(/Worktree on rex:/u)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Bring back" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "fetch-result", { transfer: TRANSFER.id });
    push(back);
    expect(screen.getByText("tau/rex/tidy: 2 commits, 3 files")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Merge" })); });
    expect(invoke).toHaveBeenCalledWith(ID, "apply", { transfer: TRANSFER.id });
    expect(props.onNotify).toHaveBeenLastCalledWith("tau/rex/tidy conflicts with this checkout in 1 file; nothing was applied.");
    expect(screen.getAllByText(/rex · Tidy/u)).toHaveLength(1);
  });

  it("says what to do without an open project", () => {
    setup(() => undefined, null);
    expect(screen.getByText("No project open")).toBeTruthy();
  });
});
