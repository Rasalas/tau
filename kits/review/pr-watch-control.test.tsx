// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { PullRequestWatchFeed } from "./pr-watch-client.js";
import { PullRequestWatchControl } from "./pr-watch-control.js";
import type { StripRequest } from "./pull-request-strip-logic.js";
import { parseRequestUrl } from "./pull-request-json.js";
import type { PullRequestWatch, WatchState } from "./pr-watch-protocol.js";
const request = { service: "github", number: 42, url: "https://github.com/example/project/pull/42", state: "open" } as StripRequest;
const watch: PullRequestWatch = { threadId: "a", ref: parseRequestUrl(request.url)!, status: "watching", wakes: 3, commentStreak: 1, startedAt: Date.now() };
function setup(canManage: boolean, initial: PullRequestWatch[] = [], others: StripRequest[] = []) {
  let state: WatchState = { watches: initial, canManage };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "watch-list") return state;
    const { url } = input as { url: string };
    const changed: PullRequestWatch = { ...watch, ref: parseRequestUrl(url)!, status: command === "watch-start" ? "watching" : "ended" };
    state = { ...state, watches: [...state.watches.filter((value) => value.threadId !== "a" || value.ref.url !== url), changed] };
    return undefined;
  });
  const feed = new PullRequestWatchFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => !canManage })}><TestProviders><PullRequestWatchControl feed={feed} threadId="a" request={request} others={others} /></TestProviders></HostClientProvider>);
  return invoke;
}
it("starts in one click and puts the one stop action in the state popover", async () => {
  const invoke = setup(true);
  const start = await screen.findByRole("button", { name: "Watch for changes for PR #42" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-start", { threadId: "a", url: request.url }));
  const watching = await screen.findByRole("button", { name: "Watching for PR #42" });
  await waitFor(() => expect((watching as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(watching);
  expect(await screen.findByText("3 wakes", { exact: false })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Stop watching PR #42" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-stop", { threadId: "a", url: request.url }));
});
it("paired inspection does not offer a working start button", async () => {
  const invoke = setup(false);
  const button = await screen.findByRole("button", { name: "Watch for changes for PR #42" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(invoke).not.toHaveBeenCalledWith("watch-start", expect.anything());
});
it("counts the thread's watched PRs and lists each with its own stop, and a start for an open one it does not watch", async () => {
  const pr = (number: number, title: string, state: StripRequest["state"] = "open") => ({ service: "github", number, title, url: `https://github.com/example/project/pull/${number}`, state }) as StripRequest;
  const watched = (number: number, extra: Partial<PullRequestWatch> = {}): PullRequestWatch => ({ ...watch, ref: parseRequestUrl(`https://github.com/example/project/pull/${number}`)!, wakes: 0, ...extra });
  const invoke = setup(true, [watch, watched(43, { baseline: { state: "OPEN", head: "h", checks: "done", failed: [{ id: "1", name: "smoke" }], comments: "0", conflict: false } }), watched(50, { threadId: "b" })], [pr(43, "Android pushes"), pr(44, "Pushes like Discord"), pr(45, "Old", "merged")]);
  const segment = await screen.findByRole("button", { name: "Watching 2 for PR #42" });
  await waitFor(() => expect((segment as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(segment);
  expect(await screen.findByText("Watching · checks finished, a check failed (smoke)")).toBeTruthy();
  expect(screen.queryByText("#45")).toBeNull();
  expect(screen.queryByText("#50")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Watch PR #44" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-start", { threadId: "a", url: "https://github.com/example/project/pull/44" }));
  fireEvent.click(await screen.findByRole("button", { name: "Stop watching PR #43" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-stop", { threadId: "a", url: "https://github.com/example/project/pull/43" }));
});
