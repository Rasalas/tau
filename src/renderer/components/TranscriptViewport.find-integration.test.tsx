// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { ExtensionRegistry, type TranscriptFinderContribution, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { useWorkbenchActions, type UseWorkbenchActionsOptions } from "../use-workbench-actions";

vi.mock("./VirtualTranscript", () => ({
  VirtualTranscript: ({ messages }: { messages: UiMessage[] }) => <div>{messages.map(message => <div key={message.id} data-message-id={message.id}>{message.text}</div>)}</div>,
}));

import { TranscriptViewport } from "./TranscriptViewport";

const best: UiMessage = { id: "best", role: "assistant", text: "Quartz lies beside the moon", timestamp: 1 };
const tail: UiMessage = { id: "tail", role: "assistant", text: "quartzite in moonlight", timestamp: 2 };
const highlights = new Map<string, { ranges: Range[] }>();
const marked = () => highlights.get("transcript-find-active")?.ranges.map(range => range.toString());

beforeEach(() => {
  highlights.clear();
  class FakeHighlight { readonly ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } }
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(find: TranscriptFinderContribution["find"], loadThrough = vi.fn(async (_id: string) => true)) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.find", name: "Find fixture", activate: context => {
    context.registerTranscriptFinder({ id: "test.finder", find });
  } });
  const transcriptRef = createRef<HTMLDivElement>();
  const setComposerSeed = vi.fn();
  const setDraft = vi.fn();
  let actions!: WorkbenchActions;
  // Only the action under test is invoked. Other workbench services remain inert.
  const options = { transcriptRef, threadCommands: {}, stageTabs: {}, setComposerSeed,
    composerScopeStore: { setDraft }, thinking: {}, pendingNewThread: undefined,
  } as unknown as UseWorkbenchActionsOptions;
  function Fixture({ sessionId, messages, mounted = true }: { sessionId: string; messages: UiMessage[]; mounted?: boolean }) {
    actions = useWorkbenchActions(options);
    return <WorkbenchShellContext.Provider value={{ registry, actions }}>
      {mounted && <TranscriptViewport messages={messages} scrollRef={transcriptRef as RefObject<HTMLDivElement | null>} sessionId={sessionId} isStreaming={false} loadThrough={loadThrough} />}
      <textarea aria-label="Composer" defaultValue="Keep my unsent draft" />
    </WorkbenchShellContext.Provider>;
  }
  const view = render(<Fixture sessionId="foreign" messages={[best]} />);
  const show = (sessionId: string, messages: UiMessage[], mounted = true) => view.rerender(<Fixture sessionId={sessionId} messages={messages} mounted={mounted} />);
  return { view, show, actions: () => actions, setComposerSeed, setDraft, loadThrough };
}

function globalFind(actions: WorkbenchActions) {
  act(() => actions.findInThread?.("QUARTZ moon", { sessionId: "target", mode: "all-words" }));
}

describe("global message Find through the active workbench transcript", () => {
  it.each(["before", "after"] as const)("survives target mount %s the Find request, loads its best turn, and marks separate tokens", async timing => {
    const find = vi.fn(async () => ["best"]);
    let finish!: (found: boolean) => void;
    const load = vi.fn((_id: string) => new Promise<boolean>(resolve => { finish = resolve; }));
    const fixture = setup(find, load);
    const { view, show } = fixture;
    if (timing === "before") show("target", [tail]);
    globalFind(fixture.actions());
    if (timing === "after") {
      expect(view.queryByRole("search")).toBeNull();
      expect(find).not.toHaveBeenCalled();
      // Navigation has confirmed, but the conversation has not mounted yet.
      show("target", [tail], false);
      show("target", [tail]);
    }
    const input = await view.findByPlaceholderText("Find in transcript…") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("QUARTZ moon"));
    await waitFor(() => expect(find).toHaveBeenCalledExactlyOnceWith({ sessionId: "target", query: "QUARTZ moon", mode: "all-words" }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("best"));
    expect(view.container.querySelector(".reveal-flash")).toBeNull();
    await act(async () => { finish(true); });
    show("target", [best, tail]);
    await waitFor(() => expect(view.container.querySelector('[data-message-id="best"]')?.classList.contains("reveal-flash")).toBe(true));
    await waitFor(() => expect(marked()).toEqual(["Quartz", "moon"]));
    expect(view.getByText("1 of 1")).toBeTruthy();
    expect((view.getByLabelText("Composer") as HTMLTextAreaElement).value).toBe("Keep my unsent draft");
    expect(fixture.setComposerSeed).not.toHaveBeenCalled();
    expect(fixture.setDraft).not.toHaveBeenCalled();

    show("foreign", [best]);
    await waitFor(() => expect(view.queryByRole("search")).toBeNull());
    await waitFor(() => expect(highlights.size).toBe(0));
    show("target", [best, tail]);
    expect(view.queryByRole("search")).toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("drops an old finder response across a return trip, and manual Find still asks for a literal phrase", async () => {
    let finish!: (ids: string[]) => void;
    const find = vi.fn<TranscriptFinderContribution["find"]>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue([]);
    const { view, show, actions, loadThrough } = setup(find);
    globalFind(actions());
    show("target", [best]);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    show("foreign", [best]);
    await act(async () => { finish(["best"]); });
    expect(loadThrough).not.toHaveBeenCalled();
    expect(view.container.querySelector(".reveal-flash")).toBeNull();
    show("target", [best]);
    expect(view.queryByRole("search")).toBeNull();
    act(() => actions().findInThread?.());
    const input = await view.findByPlaceholderText("Find in transcript…");
    fireEvent.change(input, { target: { value: "quartz moon" } });
    await waitFor(() => expect(find).toHaveBeenLastCalledWith({ sessionId: "target", query: "quartz moon" }));
    await waitFor(() => expect(view.getByText("0 matches")).toBeTruthy());
    expect(loadThrough).not.toHaveBeenCalled();
    expect(view.container.querySelector(".reveal-flash")).toBeNull();
    await waitFor(() => expect(highlights.size).toBe(0));
  });

  it("does not apply an old history-load result to a foreign thread or replay it on return", async () => {
    let finish!: (found: boolean) => void;
    const load = vi.fn((_id: string) => new Promise<boolean>(resolve => { finish = resolve; }));
    const { view, show, actions } = setup(vi.fn(async () => ["best"]), load);
    show("target", [tail]);
    globalFind(actions());
    await waitFor(() => expect(load).toHaveBeenCalledWith("best"));
    show("foreign", [best]);
    await act(async () => { finish(true); });
    expect(view.container.querySelector(".reveal-flash")).toBeNull();
    show("target", [best, tail]);
    expect(view.queryByRole("search")).toBeNull();
    expect(view.container.querySelector(".reveal-flash")).toBeNull();
  });

  it("editing a global query and reopening Find manually both restore literal semantics", async () => {
    const find = vi.fn<TranscriptFinderContribution["find"]>().mockResolvedValue(["best"]);
    const { view, show, actions } = setup(find);
    show("target", [best]);
    globalFind(actions());
    const input = await view.findByPlaceholderText("Find in transcript…");
    await waitFor(() => expect(marked()).toEqual(["Quartz", "moon"]));
    find.mockResolvedValue([]);
    fireEvent.change(input, { target: { value: "quartz  moon" } });
    await waitFor(() => expect(find).toHaveBeenLastCalledWith({ sessionId: "target", query: "quartz  moon" }));
    await waitFor(() => expect(view.getByText("0 matches")).toBeTruthy());
    globalFind(actions());
    await waitFor(() => expect(find).toHaveBeenLastCalledWith({ sessionId: "target", query: "QUARTZ moon", mode: "all-words" }));
    act(() => actions().findInThread?.());
    await waitFor(() => expect(find).toHaveBeenLastCalledWith({ sessionId: "target", query: "QUARTZ moon" }));
    await waitFor(() => expect(view.getByText("0 matches")).toBeTruthy());
  });
});
