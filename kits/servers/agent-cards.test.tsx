// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, UiToolRun, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { createProposalCard, serverToolPresentation } from "./agent-cards.js";
import type { UploadProposal } from "./agent-protocol.js";
import type { DeploymentRecord, DeployResult } from "./deploy-protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const MARK = "[site · sftp://tester@127.0.0.1:2222/srv/site]";
const PROPOSAL: UploadProposal = {
  kind: "server-upload-proposal",
  workspace: "/work/site",
  threadId: "thread-7",
  target: { id: "sftp-site-1", label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site" },
  note: "The home page greets visitors.",
  files: [
    { path: "index.php", op: "modify", outcome: "upload" },
    { path: "about.php", op: "delete", outcome: "delete" },
    { path: "shop.php", op: "modify", outcome: "conflict", reason: "Changed on the server since Tau last read it." },
  ],
  kept: [],
  warnings: [],
  leftOut: [{ path: "wp-config.php", reason: "holds live credentials (WordPress database settings)" }],
  message: "Nothing was uploaded.",
};

const run = (overrides: Partial<UiToolRun> = {}): UiToolRun => ({
  id: "call-1", name: "server_propose_upload", args: {}, status: "done", output: `${MARK}\n${JSON.stringify(PROPOSAL)}`, startedAt: 1_000, endedAt: 2_000, ...overrides,
});

function harness(options: { readOnly?: boolean; compact?: boolean; journal?: DeploymentRecord[]; tool?: UiToolRun } = {}) {
  const result: DeployResult = {
    targetId: "sftp-site-1", files: [], failed: [],
    deployment: { seq: 4, kind: "upload", at: new Date(3_000).toISOString(), origin: { actor: "user", via: "card", threadId: "thread-7" }, checkout: { path: "/work/site" }, context: "", files: [{ path: "index.php", op: "modify" }, { path: "about.php", op: "delete" }], failed: [], skipped: [], status: "uploaded", commit: "c", mirrorCommit: "m" },
  };
  const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
    if (command === "deployments") return { targetId: "sftp-site-1", deployments: options.journal ?? [] };
    if (command === "deploy") return result;
    return undefined;
  });
  const host: HostExtensionClient = { invoke, onEvent: () => () => undefined, watch: vi.fn(() => () => undefined) };
  const actions = { notify: vi.fn(), openStageTab: vi.fn(() => "tab"), openPanel: vi.fn() } as unknown as WorkbenchActions;
  const Card = createProposalCard(host, { compact: options.compact === true });
  render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => options.readOnly === true })}><TestProviders><Card tools={[options.tool ?? run()]} actions={actions} /></TestProviders></HostClientProvider>);
  return { invoke, actions };
}

describe("the agent's server tools in the transcript", () => {
  it("names the server each call reached", () => {
    const exec = serverToolPresentation({ id: "1", name: "mcp__tau__server_exec", args: { command: "ls", cwd: "tmp" }, status: "done", output: `${MARK} ~/tmp\n$ ls\nexit 0`, startedAt: 0 });
    expect(exec).toMatchObject({ glyph: "$", tone: "shell", title: "server · site", detail: "~/tmp ls", source: "server site" });
    const running = serverToolPresentation({ id: "2", name: "server_read", args: { path: "index.php", target: "live" }, status: "running", startedAt: 0 });
    expect(running).toMatchObject({ tone: "read", title: "server · live", detail: "index.php" });
    expect(serverToolPresentation({ id: "3", name: "server_put_tmp", args: { path: "probe.php" }, status: "running", startedAt: 0 })).toMatchObject({ tone: "write", title: "server", source: "server", detail: "~/tmp/probe.php" });
  });

  it("opens the shared upload review with the proposed files and never uploads directly", async () => {
    const { invoke, actions } = harness();
    await screen.findByText("Upload proposed for site");
    fireEvent.click(screen.getByRole("button", { name: "Review upload…" }));
    expect(actions.openStageTab).toHaveBeenCalledWith("servers.target", { workspace: "/work/site", targetId: "sftp-site-1", paths: ["index.php", "about.php"], threadId: "thread-7" });
    expect(invoke.mock.calls.some(([command]) => command === "deploy" || command === "deploy-preview")).toBe(false);
  });

  it("uses the same review on a phone and disables writes on read-only devices", async () => {
    const phone = harness({ compact: true });
    fireEvent.click(await screen.findByRole("button", { name: "Review upload…" }));
    expect(phone.actions.openPanel).toHaveBeenCalledWith("servers");
    expect(phone.invoke.mock.calls.some(([command]) => command === "deploy")).toBe(false);
    cleanup();
    harness({ readOnly: true });
    expect((await screen.findByRole("button", { name: "Review upload…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("knows after a reload that its click went up, from the journal", async () => {
    const record = { seq: 2, kind: "upload", at: new Date(5_000).toISOString(), origin: { actor: "user", via: "card", threadId: "thread-7" }, files: [{ path: "index.php", op: "modify" }] } as DeploymentRecord;
    harness({ journal: [record] });
    await flush();
    expect(screen.getByText("Uploaded as deployment 2: 1 changed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upload:/u })).toBeNull();
  });

  it("says so when the proposal failed, and opens the server view", async () => {
    harness({ tool: run({ status: "error", output: "This project names no server: it has no .vscode/sftp.json." }) });
    expect(screen.getByText("No upload proposed")).toBeTruthy();
    cleanup();
    const { actions } = harness();
    fireEvent.click(screen.getByRole("button", { name: "Server view" }));
    expect(actions.openStageTab).toHaveBeenCalledWith("servers.target", { workspace: "/work/site", targetId: "sftp-site-1", paths: ["index.php", "about.php"], threadId: "thread-7" });
  });
});
