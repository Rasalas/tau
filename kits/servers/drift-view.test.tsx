// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerGateContext, HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import servers from "./desktop.js";
import type { DriftImport, DriftState } from "./drift-protocol.js";
import { DriftFeed, DriftPanel } from "./drift-view.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const CWD = "/work/site";
const BRANCH: DriftImport = {
  branch: "server-drift/2026-09-25", commit: "a".repeat(40), parent: "b".repeat(40), at: "2026-09-25T08:00:00.000Z", status: "open",
  files: [{ path: "about.php", change: "deleted", certain: true }, { path: "index.php", change: "modified", certain: true }],
};
const target = (extra: Partial<DriftState["targets"][number]> = {}) => ({ targetId: "sftp-site-1", label: "site", context: "", imports: [], ...extra });
const DRIFTING: DriftState = {
  workspace: CWD, branch: "main",
  targets: [target({ check: { at: "2026-09-25T08:00:00.000Z", baseline: "mirror", later: false, files: BRANCH.files } })],
};
const IMPORTED: DriftState = { workspace: CWD, branch: "main", targets: [target({ check: { at: "2026-09-25T08:01:00.000Z", baseline: "mirror", later: false, files: [] }, imports: [BRANCH] })] };
const MERGED: DriftState = { ...IMPORTED, targets: [target({ ...IMPORTED.targets[0], imports: [{ ...BRANCH, status: "merged" }] })] };

function host(states: Record<string, DriftState>, first: DriftState) {
  let current = first;
  return vi.fn(async (_id: string, command: string) => {
    if (command === "drift") return current;
    if (command === "import-drift") { current = states[command]!; return { state: current, imported: BRANCH }; }
    if (command in states) { current = states[command]!; return current; }
    return undefined;
  });
}

const gateContext = (messages: unknown[] = []): ComposerGateContext => ({ action: "prompt", snapshot: { cwd: CWD, messages } as unknown as HostSnapshot });

describe("server drift gate", () => {
  it("asks before a thread's first prompt, imports as a branch, then merges on the click", async () => {
    const invoke = host({ "import-drift": IMPORTED, "merge-drift": MERGED }, DRIFTING);
    const { registry, preferences } = createKitHarness(invoke);
    registry.activate(servers);
    const gate = registry.getComposerGates().find((entry) => entry.id === "servers.drift")!;
    // The first ask loads the state and lets the prompt through.
    expect(gate.check(gateContext())).toBe(false);
    await flush();
    expect(gate.check(gateContext())).toBe(true);
    expect(gate.check(gateContext([{ id: "m1" }]))).toBe(false);
    expect(gate.check({ ...gateContext(), action: "model" })).toBe(false);

    const proceed = vi.fn();
    const cancel = vi.fn();
    render(<TestProviders preferences={preferences}><gate.Component context={gateContext()} proceed={proceed} cancel={cancel} /></TestProviders>);
    expect(screen.getByText("The server has changes the repository lacks")).toBeTruthy();
    expect(screen.getByText("about.php")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Import as branch" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "import-drift", { cwd: CWD, targetId: "sftp-site-1" });
    // Imported, not merged: the gate asks about the merge, and nothing went ahead yet.
    expect(proceed).not.toHaveBeenCalled();
    expect(screen.getByText("server-drift/2026-09-25 is not merged")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Merge into main" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "merge-drift", { cwd: CWD, targetId: "sftp-site-1", branch: BRANCH.branch });
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(gate.check(gateContext())).toBe(false);
  });

  it("lets the prompt go with \"Not now\" and stops asking about that drift", async () => {
    const later: DriftState = { ...DRIFTING, targets: [target({ check: { ...DRIFTING.targets[0]!.check!, later: true } })] };
    const invoke = host({ "drift-later": later }, DRIFTING);
    const { registry, preferences } = createKitHarness(invoke);
    registry.activate(servers);
    const gate = registry.getComposerGates().find((entry) => entry.id === "servers.drift")!;
    gate.check(gateContext());
    await flush();
    const proceed = vi.fn();
    render(<TestProviders preferences={preferences}><gate.Component context={gateContext()} proceed={proceed} cancel={vi.fn()} /></TestProviders>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Not now" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "drift-later", { cwd: CWD, targetId: "sftp-site-1" });
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(gate.check(gateContext())).toBe(false);
  });
});

describe("drift panel", () => {
  it("shows the server's changes and a branch waiting for its merge, with a diff per file", async () => {
    const both: DriftState = { ...DRIFTING, targets: [target({ ...DRIFTING.targets[0], imports: [{ ...BRANCH, branch: "server-drift/2026-09-24", status: "later" }] })] };
    const invoke = vi.fn(async (_id: string, command: string) => {
      if (command === "drift") return both;
      if (command === "drift-diff") return { path: "index.php", added: 1, removed: 1, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "removed", oldLine: 1, text: "old" }, { kind: "added", newLine: 1, text: "new" }] }] };
      return both;
    });
    const { registry, preferences } = createKitHarness(invoke);
    registry.activate(servers);
    const context = { host: { invoke: (command: string, input?: unknown) => invoke(SERVERS_EXTENSION_ID, command, input), onEvent: () => () => undefined }, events: { on: () => () => undefined } };
    const feed = new DriftFeed(context as never);
    render(<TestProviders preferences={preferences}><DriftPanel context={context as never} feed={feed} cwd={CWD} /></TestProviders>);
    await flush();
    expect(screen.getByText("2 files changed on the server")).toBeTruthy();
    expect(screen.getByText("server-drift/2026-09-24")).toBeTruthy();
    expect(screen.getByText("Merge later")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Merge into main/u })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: /index\.php/u })[0]!); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "drift-diff", { cwd: CWD, targetId: "sftp-site-1", path: "index.php" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Import as commit/u })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "import-drift", { cwd: CWD, targetId: "sftp-site-1" });
  });
});
