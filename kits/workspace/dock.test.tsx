// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, electronClientEnvironment, ThreadStore, ThreadStoreContext, type ClientProfile } from "../../src/renderer/test-support/kit-harness.js";
import { WorkspaceFollower } from "./dock.js";
import { withWorkspaceStore } from "./store-context.js";
import type { WorkspaceStore } from "./store.js";

afterEach(cleanup);

describe("WorkspaceFollower", () => {
  // Review Kit draws `review.diff` on the desktop alone; the store routes its entries by what the follower says.
  it.each([["desktop", true], ["web", false], ["compact", false]] as const)("tells the store on the %s profile whether the review is drawn", (profile: ClientProfile, drawn: boolean) => {
    const store = { bind: vi.fn(), drawsReview: vi.fn(), followBusyCheckout: vi.fn(), follow: vi.fn(), loadEditors: vi.fn(async () => undefined), loadTerminals: vi.fn(async () => undefined) };
    const Follower = withWorkspaceStore(store as unknown as WorkspaceStore, WorkspaceFollower);
    const actions = { activeThread: () => undefined } as never;
    render(<ClientEnvironmentProvider environment={{ ...electronClientEnvironment(new URLSearchParams()), profile }}>
      <ThreadStoreContext.Provider value={new ThreadStore()}><Follower actions={actions} /></ThreadStoreContext.Provider>
    </ClientEnvironmentProvider>);

    expect(store.drawsReview).toHaveBeenLastCalledWith(drawn);
  });
});
