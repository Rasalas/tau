// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { ServerFolderPicker } from "./folder-picker.js";
import { SERVER_TARGET_TAB, type TargetStatus } from "./view-protocol.js";

afterEach(cleanup);
const target = { targetId: "site", remotePath: "/", context: "", connectionFingerprint: "fingerprint" } as TargetStatus;

function harness(pending = false) {
  const invoke = vi.fn(async (command: string, raw?: unknown): Promise<unknown> => {
    const input = raw as { path?: string };
    if (command === "server-folder") {
      if (pending) return new Promise(() => undefined);
      return { root: "/", path: input.path ?? "", entries: input.path ? [{ name: "index.php", directory: false }] : [{ name: "website", directory: true }], matches: input.path ? 1 : 0, localItems: 1 };
    }
    if (command === "set-server-folders") return { targetId: "site-mapped" };
    return undefined;
  });
  const host = { invoke } as unknown as HostExtensionClient;
  const actions = {
    stageTabs: () => [{ id: "old-tab", kind: "extension", tabKind: SERVER_TARGET_TAB, params: { workspace: "/project", targetId: "site" } }],
    closeStageTab: vi.fn(), openStageTab: vi.fn(),
  } as unknown as WorkbenchActions;
  const onClose = vi.fn();
  render(<HostClientProvider client={createFakeHostClient()}><TestProviders>
    <ServerFolderPicker host={host} cwd="/project" target={target} actions={actions} onClose={onClose} />
  </TestProviders></HostClientProvider>);
  return { invoke, actions, onClose };
}

it("opens only the chosen directory and replaces the old target tab after mapping", async () => {
  const h = harness();
  const folder = await screen.findByRole("button", { name: "website" });
  expect(h.invoke.mock.calls.filter(([command]) => command === "server-folder")).toHaveLength(1);
  expect(h.invoke).not.toHaveBeenCalledWith("find-server-folder", expect.anything());
  fireEvent.click(folder);
  await screen.findByText("index.php");
  expect(h.invoke).toHaveBeenCalledWith("server-folder", expect.objectContaining({ path: "website" }));
  fireEvent.click(screen.getByRole("button", { name: "Use these folders" }));
  await waitFor(() => expect(h.actions.closeStageTab).toHaveBeenCalledWith("old-tab"));
  expect(h.invoke).toHaveBeenCalledWith("set-server-folders", { cwd: "/project", targetId: "site", context: "", remotePath: "/website" });
  expect(h.onClose).toHaveBeenCalledOnce();
});

it("can leave a pending directory request immediately", async () => {
  const h = harness(true);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("server-folder", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.onClose).toHaveBeenCalledOnce();
  expect(h.invoke).toHaveBeenCalledWith("cancel-server-operation", expect.objectContaining({ targetId: "site", operationId: expect.any(String) }));
});
