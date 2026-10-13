// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function setup(readOnly = false, own: ReviewRequest | null = request, linked: ThreadPullRequestLink[] = [], answered = true) {
  let state = { cwd: "/work", workspaceId: "ws-a", workspace: { branch: "fix/preview" }, changes: { files: [], added: 0, removed: 0 }, committing: false };
  let thread = "t1";
  const listeners = new Set<() => void>();
  const withdraw = vi.fn();
  const offerRequestStep = vi.fn((_step: { noun: string; open(): void }) => withdraw);
  const store = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, offerRequestStep } as unknown as WorkspaceStoreApi;
  const load = vi.fn(async () => own ?? undefined);
  const rows = new RowRequests(load);
  if (answered) rows.set("ws-a", own ?? undefined);
  const links = new ThreadLinkRows({ links: async () => linked, onLinksChanged: () => () => undefined });
  links.set("t1", linked);
  const Summary = createWorkspaceRequestSummary(store, rows, links);
  const actions = { activeThread: () => ({ sessionId: thread }), openStageTab: vi.fn(() => "tab") } as unknown as WorkbenchActions;
  const client = { onConnectionState: () => () => undefined, hasCapability: () => false, isReadOnly: () => readOnly } as unknown as ComponentProps<typeof HostClientProvider>["client"];
  const view = render(<HostClientProvider client={client}><Summary actions={actions} /></HostClientProvider>);
  return { actions, load, rows, view, offerRequestStep, withdraw, switchWorkspace: () => act(() => { thread = "t2"; state = { ...state, workspaceId: "ws-b", workspace: { branch: "other" } }; listeners.forEach((listener) => listener()); }) };
}

it("opens the current request from its title with explicit workspace scope", () => {
  const { actions } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Open PR #12 · Fix previews" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url: request.url, number: 12, service: "github", workspace: "ws-a" }, { key: request.url });
  expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
});

it("discloses additional linked requests and opens the selected URL", () => {
  const url = "https://github.com/acme/app/pull/9";
  const { actions } = setup(false, request, [{ url, service: "github", host: "github.com", repo: "acme/app", number: 9, title: "Earlier work", state: "merged", source: "user", linkedAt: 1 }]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
  expect(screen.getByRole("button", { name: "Merged PR #9 · Earlier work" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Merged PR #9 · Earlier work" }));
  expect(actions.openStageTab).toHaveBeenCalledWith(PULL_REQUEST_TAB, { url, number: 9, service: "github", workspace: "ws-a" }, { key: url });
});

it("offers the local PR form to the Git button instead of drawing a row of its own", () => {
  const { actions, offerRequestStep } = setup(false, null);
  expect(screen.queryByRole("button", { name: /Create PR/ })).toBeNull();
  expect(offerRequestStep).toHaveBeenCalledOnce();
  const step = offerRequestStep.mock.calls[0]![0];
  expect(step.noun).toBe("PR");
  expect(actions.openStageTab).not.toHaveBeenCalled();
  step.open();
  expect(actions.openStageTab).toHaveBeenCalledWith(LOCAL_PULL_REQUEST_TAB, {}, { key: LOCAL_PULL_REQUEST_TAB });
});

it("offers no new PR while one is open, and takes the offer back when one opens", () => {
  const open = setup();
  expect(open.offerRequestStep).not.toHaveBeenCalled();
  cleanup();
  const { rows, offerRequestStep, withdraw } = setup(false, null);
  expect(offerRequestStep).toHaveBeenCalledOnce();
  act(() => rows.set("ws-a", request));
  expect(withdraw).toHaveBeenCalledOnce();
});

it("waits for the first answer about the checkout before offering a PR", async () => {
  const { offerRequestStep, load } = setup(false, null, [], false);
  expect(offerRequestStep).not.toHaveBeenCalled();
  await waitFor(() => expect(load).toHaveBeenCalledWith("ws-a"));
  await waitFor(() => expect(offerRequestStep).toHaveBeenCalledOnce());
});

it("keeps request navigation available on read-only connections and offers no creation", () => {
  const { actions, offerRequestStep } = setup(true, { ...request, state: "merged" });
  expect(offerRequestStep).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Merged PR #12 · Fix previews" }));
  expect(actions.openStageTab).toHaveBeenCalledOnce();
});

it("keeps a merged request visible while allowing a new PR on the checkout", () => {
  const { offerRequestStep } = setup(false, { ...request, state: "merged" });
  expect(screen.getByRole("button", { name: "Merged PR #12 · Fix previews" })).toBeTruthy();
  expect(offerRequestStep).toHaveBeenCalledWith(expect.objectContaining({ noun: "PR" }));
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
