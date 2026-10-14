// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "./extension-system";
import type { ThreadStore } from "../workbench/thread-store";
import { PromptLinkReceiver } from "./PromptLinkReceiver";
import { openPromptLink } from "./prompt-link-event";
import { HostClientProvider } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("./PromptLinkHandler", () => {
  loaded();
  return { PromptLinkHandler: ({ href }: { href: string }) => <output>{href}</output> };
});

afterEach(cleanup);
it("keeps the workflow unloaded without a link, then imports it for a chat click", async () => {
  const client = createFakeHostClient({ windowAction: async () => [] });
  render(<HostClientProvider client={client}>
    <PromptLinkReceiver actions={{} as WorkbenchActions} threads={{} as ThreadStore} />
  </HostClientProvider>);
  await waitFor(() => expect(client.calls.some((call) => call.method === "windowAction")).toBe(true));
  act(() => client.emit({ type: "window-shell", event: { kind: "links-available" } }));
  await act(async () => { await Promise.resolve(); });
  expect(loaded).not.toHaveBeenCalled();
  act(() => openPromptLink("tau://new?prompt=Hello"));
  expect(await screen.findByText("tau://new?prompt=Hello")).toBeTruthy();
  expect(loaded).toHaveBeenCalledOnce();
});
