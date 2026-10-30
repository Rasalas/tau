// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT } from "../../workbench/thread-store";
import type { PaletteItem, PaletteSearchContext, WorkbenchActions } from "../extension-system";
import { createKitHarness } from "../test-support/kit-harness";
import { useMessageSearch } from "./use-message-search";
afterEach(cleanup);
it("uses the contributed message source from three characters, refreshes pushed partial rows, and aborts stale queries", async () => {
  const { registry } = createKitHarness();
  let notify = () => {};
  let items: PaletteItem[] = [];
  const search = vi.fn((_query: string, _context: PaletteSearchContext) => items);
  registry.activate({ id: "fixture.search", name: "Search", activate(context) {
    context.registerPaletteSource({ id: "search.thread-content", label: "Threads", scope: "threads", search,
      status: () => "Indexing messages · 1 of 2 threads. Some results may be missing.",
      subscribeStatus: listener => { notify = listener; return () => { notify = () => {}; }; },
    });
  } });
  const actions = {} as WorkbenchActions;
  const view = renderHook(({ query }) => useMessageSearch(registry, actions, EMPTY_SNAPSHOT, query), { initialProps: { query: "be" } });
  expect(search).not.toHaveBeenCalled();
  view.rerender({ query: "beacon" });
  await waitFor(() => expect(search).toHaveBeenCalled());
  const firstContext = search.mock.calls[0]![1];
  expect(firstContext.scope).toBe("threads");
  items = [{ id: "one", label: "A message hit", detail: "You: beacon" }];
  act(() => notify());
  await waitFor(() => expect(view.result.current.items[0]?.label).toBe("A message hit"));
  expect(view.result.current.status).toContain("Some results may be missing.");
  view.rerender({ query: "next" });
  expect(firstContext.signal.aborted).toBe(true);
  view.unmount();
});
