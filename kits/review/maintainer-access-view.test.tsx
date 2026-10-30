// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PreferencesStore, WorkbenchActions } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestDetail } from "./protocol.js";
import { PullRequestHeaderActions } from "./pull-request-header-actions.js";
import { usePullRequest } from "./pull-request-view.js";

const detail: PullRequestDetail = { ref: { service: "github", host: "github.com", repo: "acme/repo", number: 1, url: "https://github.com/acme/repo/pull/1" }, title: "Fork PR", body: "", state: "open", draft: false, baseRef: "main", headRepository: "octo/repo", maintainerCanModify: true, viewerCanUpdate: true, viewerCanAllowMaintainerEdits: true, checks: [], comments: [], commits: [], reviewers: [], labels: [], additions: 0, deletions: 0, changedFiles: 0 };
afterEach(() => { cleanup(); delete document.body.dataset.profile; });

it("ignores a detail read started before a successful save, then accepts a later server read", async () => {
  let finish!: (next: PullRequestDetail) => void;
  const oldRead = new Promise<PullRequestDetail>((resolve) => { finish = resolve; });
  const client = { view: vi.fn().mockResolvedValueOnce(detail).mockReturnValueOnce(oldRead).mockResolvedValue({ ...detail, maintainerCanModify: true }), checks: vi.fn(async () => []), threads: vi.fn(async () => []) } as unknown as PullRequestClient;
  const { result } = renderHook(() => usePullRequest(client, detail.ref.url));
  await waitFor(() => expect(result.current.data.detail).toBe(detail));
  let read!: Promise<void>;
  act(() => { read = result.current.loadDetail(true); });
  act(() => result.current.setData({ detail: { ...detail, maintainerCanModify: false } }));
  await act(async () => { finish(detail); await read; });
  expect(result.current.data.detail?.maintainerCanModify).toBe(false);
  await act(async () => result.current.loadDetail(true));
  expect(result.current.data.detail?.maintainerCanModify).toBe(true);
});

it("shows the compact action sheet's switch and keeps it open while saving", async () => {
  document.body.dataset.profile = "compact";
  let finish!: (next: PullRequestDetail) => void;
  const client = { update: vi.fn(() => new Promise<PullRequestDetail>((resolve) => { finish = resolve; })) } as unknown as PullRequestClient;
  const onDetail = vi.fn();
  const preferences = { optionValue: (_kit: string, _id: string, fallback: unknown) => fallback } as unknown as PreferencesStore;
  render(<PullRequestHeaderActions detail={detail} checks={[]} client={client} actions={{ notify: vi.fn() } as unknown as WorkbenchActions} preferences={preferences} threadId={undefined} onDetail={onDetail} onPickThread={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "More pull request actions" }));
  const toggle = await screen.findByRole("switch", { name: /Allow edits from maintainers/ });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("Saving…")).toBeTruthy();
  await act(async () => finish({ ...detail, maintainerCanModify: false }));
  expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ maintainerCanModify: false }));
});
