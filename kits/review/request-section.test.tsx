// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, electronClientEnvironment, type ClientProfile } from "../../src/renderer/test-support/kit-harness.js";
import type { WorkbenchActions } from "tau";
import type { WorkspaceStoreApi } from "./protocol.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import { trackPullRequestTarget } from "./pull-request-target.js";
import { createRequestSection, RequestSummary, type LinkedParts } from "./request-section.js";
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

describe("the request line", () => {
  const request = { url: "https://gitlab.com/acme/tau/-/merge_requests/9", number: 9, provider: "gitlab", title: "Fix", state: "open" } as never;
  const line = () => { const open = vi.fn(); const openInTau = vi.fn(); const browse = vi.fn(); render(<RequestSummary request={request} onOpen={open} onOpenInTau={openInTau} onBrowse={browse} />); return { open, openInTau, browse }; };

  it("offers Open in Tau beside Open in the browser only when links open in the browser", () => {
    const { preferences } = createKitHarness();
    const stop = trackPullRequestTarget(preferences);
    const first = line();
    expect(screen.queryByRole("button", { name: /in Tau$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /in the browser$/ }));
    expect(first.browse).toHaveBeenCalled();

    act(() => preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pull-request-target", "browser"));
    fireEvent.click(screen.getByRole("button", { name: /in Tau$/ }));
    expect(first.openInTau).toHaveBeenCalled();
    expect(first.open).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /in the browser$/ })).toBeTruthy();
    stop();
  });

  it("names the provider, not a host, as what merges an armed request", () => {
    const armed = { url: "https://gitlab.com/acme/tau/-/merge_requests/9", number: 9, provider: "gitlab", title: "Fix", state: "open", autoMerge: { method: "squash" } } as never;
    render(<RequestSummary request={armed} onOpen={vi.fn()} onOpenInTau={vi.fn()} onBrowse={vi.fn()} />);
    expect(screen.getByText("auto-merge · squash").getAttribute("title")).toBe("GitLab merges it on its own once its requirements are met");
  });
});
