// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { MessageIndexFeed } from "./index-feed.js";
import { createSearchSettings } from "./settings.js";
import type { MessageIndexStatus } from "./protocol.js";
const status: MessageIndexStatus = { enabled: true, state: "ready", done: 412, total: 412, threads: 412, bytes: 38_000_000, revision: 1 };
const feeds: MessageIndexFeed[] = [];
afterEach(() => { cleanup(); for (const feed of feeds.splice(0)) feed.dispose(); });
function setup(readOnly = false) {
  const invoke = vi.fn(async (command: string, input?: unknown) => command === "index-configure"
    ? { ...status, enabled: (input as { enabled: boolean }).enabled, state: "disabled", revision: 2 }
    : { ...status, state: "indexing", done: 0, revision: 2 });
  const feed = new MessageIndexFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient); feeds.push(feed); feed.accept(status);
  const Rows = createSearchSettings(feed);
  render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => readOnly })}><Rows /></HostClientProvider>);
  return { feed, invoke };
}
it("shows counts and size and switches indexing off without a confirmation", async () => {
  const { invoke } = setup();
  expect(screen.getByText("Up to date · 412 threads · 38 MB")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Index message text" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("index-configure", { enabled: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("uses Retry after a build error and reflects progress pushed by another device", async () => {
  const { feed, invoke } = setup();
  act(() => feed.accept({ ...status, state: "error", error: "Disk full", revision: 2 }));
  expect(screen.getByText("Couldn't build the index: Disk full")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("index-rebuild", {}));
  act(() => feed.accept({ ...status, state: "indexing", done: 120, revision: 3 }));
  expect(screen.getByText("Indexing · 120 of 412 threads")).toBeTruthy();
});
it("keeps the status visible but disables all writes for a Read-only device", () => {
  const { invoke } = setup(true);
  expect((screen.getByRole("switch", { name: "Index message text" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Rebuild index" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "Index message text" }));
  expect(invoke).not.toHaveBeenCalled();
});
