// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { WorkspaceStore } from "./store.js";
import { withWorkspaceStore } from "./store-context.js";
import { MobileDraftCheckout } from "./mobile-draft.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

it("toggles the draft's checkout directly and keeps its chosen base when toggled back", async () => {
  const stub = workspaceHostStub({
    getWorkspaceInfo: async () => ({ root: "/project", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [{ name: "main", isCurrent: true }, { name: "release", isCurrent: false }] }),
    getWorktreeBase: async () => ({ ref: "origin/main", commit: "abc", others: [] }),
  });
  setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
  const preferences = new PreferencesStore();
  const store = new WorkspaceStore(preferences, createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
  store.follow({ cwd: "/project", draftPending: true });
  store.setWorkspaceMode("current");
  const Checkout = withWorkspaceStore(store, MobileDraftCheckout);
  render(<TestProviders preferences={preferences}><Checkout /></TestProviders>);
  fireEvent.click(await screen.findByRole("button", { name: "Current checkout" }));
  expect(store.workspaceMode()).toBe("worktree");
  await screen.findByText("From origin/main");
  fireEvent.click(screen.getByRole("button", { name: "Choose base branch" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Find a branch" }), { target: { value: "release" } });
  fireEvent.click(screen.getByRole("button", { name: "release" }));
  expect(store.getSnapshot().draftBase).toBe("release");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New worktree" }));
  expect(store.workspaceMode()).toBe("current");
  fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
  await waitFor(() => expect(screen.getByText("From release")).toBeTruthy());
});
