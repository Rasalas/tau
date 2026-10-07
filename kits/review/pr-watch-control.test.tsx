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
function setup(canManage: boolean) {
  let state: WatchState = { watches: [], canManage };
  const invoke = vi.fn(async (command: string) => {
    if (command === "watch-list") return state;
    state = { ...state, watches: command === "watch-start" ? [watch] : [{ ...watch, status: "ended" }] };
    return undefined;
  });
  const feed = new PullRequestWatchFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => !canManage })}><TestProviders><PullRequestWatchControl feed={feed} threadId="a" request={request} /></TestProviders></HostClientProvider>);
  return invoke;
}
it("starts in one click and puts the one stop action in the state popover", async () => {
  const invoke = setup(true);
  const start = await screen.findByRole("button", { name: "Watch for changes for PR #42" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-start", { threadId: "a", url: request.url }));
  const watching = await screen.findByRole("button", { name: "Watching · 3 for PR #42" });
  await waitFor(() => expect((watching as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(watching);
  fireEvent.click(await screen.findByRole("button", { name: "Stop watching" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("watch-stop", { threadId: "a", url: request.url }));
});
it("paired inspection does not offer a working start button", async () => {
  const invoke = setup(false);
  const button = await screen.findByRole("button", { name: "Watch for changes for PR #42" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(invoke).not.toHaveBeenCalledWith("watch-start", expect.anything());
});
