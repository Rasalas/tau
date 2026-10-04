// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { WorkbenchActions } from "tau";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { LOCAL_PULL_REQUEST_TAB } from "./local-request.js";
import { PULL_REQUEST_TAB, type ReviewRequest, type ThreadPullRequestLink, type WorkspaceStoreApi } from "./protocol.js";
import { RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";
import { createWorkspaceRequestSummary } from "./workspace-summary.js";

const request: ReviewRequest = { provider: "github", number: 12, title: "Fix previews", url: "https://github.com/acme/app/pull/12", headRef: "fix/preview", baseRef: "main", state: "open" };

function setup(readOnly = false, own: ReviewRequest | null = request, linked: ThreadPullRequestLink[] = []) {
  let state = { cwd: "/work", workspaceId: "ws-a", workspace: { branch: "fix/preview" }, changes: { files: [], added: 0, removed: 0 }, committing: false };
  let thread = "t1";
  const listeners = new Set<() => void>();
  const store = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as WorkspaceStoreApi;
  const load = vi.fn(async () => own ?? undefined);
  const rows = new RowRequests(load);
  rows.set("ws-a", own ?? undefined);
  const links = new ThreadLinkRows({ links: async () => linked, onLinksChanged: () => () => undefined });
  links.set("t1", linked);
  const Summary = createWorkspaceRequestSummary(store, rows, links);
  const actions = { activeThread: () => ({ sessionId: thread }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const client = { onConnectionState: () => () => undefined, hasCapability: () => false, isReadOnly: () => readOnly } as unknown as ComponentProps<typeof HostClientProvider>["client"];
  const view = render(<HostClientProvider client={client}><Summary actions={actions} /></HostClientProvider>);
  return { actions, load, rows, view, switchWorkspace: () => act(() => { thread = "t2"; state = { ...state, workspaceId: "ws-b", workspace: { branch: "other" } }; listeners.forEach((listener) => listener()); }) };
}

it("opens the current request from its title with explicit workspace scope", () => {
  const { actions } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Open PR #12 · Fix previews" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url: request.url, number: 12, service: "github", workspace: "ws-a" }, { key: request.url });
  expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create PR…" })).toBeNull();
});

it("discloses additional linked requests and opens the selected URL", () => {
  const url = "https://github.com/acme/app/pull/9";
  const { actions } = setup(false, request, [{ url, service: "github", host: "github.com", repo: "acme/app", number: 9, title: "Earlier work", state: "merged", source: "user", linkedAt: 1 }]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
  expect(screen.getByRole("button", { name: "Merged PR #9 · Earlier work" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Merged PR #9 · Earlier work" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url, number: 9, service: "github", workspace: "ws-a" }, { key: url });
});

it("creates by opening the existing local PR review, without publishing", () => {
  const { actions } = setup(false, null);
  fireEvent.click(screen.getByRole("button", { name: "Create PR…" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(LOCAL_PULL_REQUEST_TAB, {}, { key: LOCAL_PULL_REQUEST_TAB });
});

it("keeps request navigation available on read-only connections and hides creation", () => {
  const { actions } = setup(true, { ...request, state: "merged" });
  expect(screen.queryByRole("button", { name: "Create PR…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Merged PR #12 · Fix previews" }));
  expect(actions.openStageTab).toHaveBeenCalledOnce();
});

it("keeps a merged request visible while allowing a new PR editor on the checkout", () => {
  const { actions } = setup(false, { ...request, state: "merged" });
  expect(screen.getByRole("button", { name: "Merged PR #12 · Fix previews" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create PR…" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(LOCAL_PULL_REQUEST_TAB, {}, { key: LOCAL_PULL_REQUEST_TAB });
});

it("clears the previous workspace's request and menu on a workspace switch", async () => {
  const { switchWorkspace, load } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Pull request checks, Checks" }));
  switchWorkspace();
  expect(screen.queryByRole("button", { name: /PR #12 · Fix previews/ })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Pull request checks" })).toBeNull();
  await waitFor(() => expect(load).toHaveBeenCalledWith("ws-b"));
  expect(screen.queryByRole("button", { name: /PR #12 · Fix previews/ })).toBeNull();
});
