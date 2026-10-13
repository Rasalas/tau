// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, electronClientEnvironment, type ClientProfile } from "../../src/renderer/test-support/kit-harness.js";
import type { WorkbenchActions } from "tau";
import type { WorkspaceStoreApi } from "./protocol.js";
import { createRequestSection, type LinkedParts } from "./request-section.js";
import type { RequestClient, RowRequests } from "./requests.js";

afterEach(cleanup);

// The publish card, the Local PR tab and the link dialog are the desktop's: a browser tab's Changes panel has no use for a step that opens none of them.
describe("the Changes panel's request step", () => {
  it.each([["desktop", true], ["web", false], ["compact", false]] as const)("is drawn on the %s profile only where its tabs are", async (profile: ClientProfile, drawn: boolean) => {
    const snapshot = { cwd: "/repo", workspace: { branch: "feat" }, changes: { files: [] } };
    const store = { subscribe: () => () => undefined, getSnapshot: () => snapshot, refresh: vi.fn() } as unknown as WorkspaceStoreApi;
    const status = vi.fn(async () => ({ service: "github" }));
    const client = { status } as unknown as RequestClient;
    const rows = { set: vi.fn() } as unknown as RowRequests;
    const none: never[] = [];
    const links = { rows: { subscribe: () => () => undefined, get: () => none, load: vi.fn(async () => undefined) }, client: {}, dialogs: {} } as unknown as LinkedParts;
    const Section = createRequestSection({} as never, store, client, rows, links);
    const actions = { activeThread: () => ({ sessionId: "t", cwd: "/repo" }), notify: vi.fn() } as unknown as WorkbenchActions;

    const view = render(<ClientEnvironmentProvider environment={{ ...electronClientEnvironment(new URLSearchParams()), profile }}>
      <Section actions={actions} message="" committed={() => undefined} />
    </ClientEnvironmentProvider>);

    if (drawn) await waitFor(() => expect(status).toHaveBeenCalled());
    else expect(status).not.toHaveBeenCalled();
    expect(view.container.childElementCount > 0).toBe(drawn);
  });
});
