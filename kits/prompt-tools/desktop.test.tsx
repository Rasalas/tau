// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerInlineContext, HostSnapshot, UiMessage, UiPromptImageAttachment, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import promptTools from "./desktop.js";
import { CHIPS_SERVICE, FOLLOW_UP_OPTION, PROMPT_TOOLS_ID, type Chip, type ChipInput, type ComposerContextChips, type StashEntry } from "./protocol.js";

afterEach(cleanup);

/** A composer on screen: its text, its images and the chips a chip service holds. */
function composer(initial: { text?: string; images?: UiPromptImageAttachment[] } = {}) {
  const state = { text: initial.text ?? "", images: initial.images ?? [] as readonly UiPromptImageAttachment[], chips: [] as Chip[], notices: [] as string[] };
  let next = 0;
  const chips: ComposerContextChips = {
    addChip: (chip: ChipInput) => { const id = `c${next++}`; state.chips.push({ ...chip, id, label: chip.label ?? chip.kind }); return id; },
    removeChip: (id) => { state.chips = state.chips.filter((chip) => chip.id !== id); },
    chips: () => state.chips,
    subscribe: () => () => undefined,
  };
  const actions = {
    activeThread: () => ({ cwd: "/repo", sessionId: "t1", draftPending: false }),
    composerDraft: () => state.text,
    setComposerDraft: (text: string) => { state.text = text; },
    composerImages: () => state.images,
    setComposerImages: (images: readonly UiPromptImageAttachment[]) => { state.images = images; },
    focusComposer: vi.fn(),
    notify: (message: string) => { state.notices.push(message); },
  } as unknown as WorkbenchActions;
  return { state, chips, actions };
}

/** A host half that keeps the stash in memory. */
function fakeHost(prompts: string[] = []) {
  const stash: StashEntry[] = [];
  let next = 0;
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown): Promise<unknown> => {
    const fields = input as Record<string, unknown>;
    switch (command) {
      case "stash-list": return stash.map((entry) => ({ ...entry, images: entry.images.map(({ data: _data, ...meta }) => meta) }));
      case "stash-add": {
        const entry = { id: `e${next++}`, createdAt: Date.now(), text: fields.text, chips: fields.chips, images: fields.images } as StashEntry;
        stash.unshift(entry);
        return { entry };
      }
      case "stash-take": {
        const index = stash.findIndex((entry) => entry.id === fields.id);
        return index < 0 ? undefined : stash.splice(index, 1)[0];
      }
      case "stash-drop": stash.splice(stash.findIndex((entry) => entry.id === fields.id), 1); return undefined;
      case "project-prompts": return prompts;
      default: throw new Error(`unexpected ${command}`);
    }
  });
  return { invoke, stash };
}

function activate(options: { withChips?: boolean; prompts?: string[]; composer?: ReturnType<typeof composer> } = {}) {
  const host = fakeHost(options.prompts);
  const { registry, preferences } = createKitHarness(host.invoke);
  const screenComposer = options.composer ?? composer();
  if (options.withChips !== false) {
    registry.activate({ id: "test.chips", name: "Chips", activate(context) { context.provideService(CHIPS_SERVICE, screenComposer.chips); } });
  }
  registry.activate(promptTools);
  return { registry, preferences, host, ...screenComposer };
}

const image: UiPromptImageAttachment = { kind: "image", name: "shot.png", mimeType: "image/png", data: "AAAA", size: 3 };

describe("Prompt Tools: the stash", () => {
  it("puts the whole draft away with ⌘S and empties the composer", async () => {
    const { registry, host, state, actions, chips } = activate({ composer: composer({ text: "half a thought", images: [image] }) });
    chips.addChip({ kind: "text-excerpt", label: "Terminal", payload: { source: "Terminal", text: "$ ls" } });
    expect(registry.getKeybindings().find((binding) => binding.commandId === "prompt-tools.stash")?.keys).toBe("mod+s");
    await registry.executeCommand("prompt-tools.stash", actions);
    expect(host.stash).toHaveLength(1);
    expect(host.stash[0]).toMatchObject({
      text: "half a thought",
      chips: [{ kind: "text-excerpt", label: "Terminal", payload: { source: "Terminal", text: "$ ls" } }],
      images: [image],
    });
    expect(state).toMatchObject({ text: "", images: [], chips: [] });
    await registry.executeCommand("prompt-tools.stash", actions);
    expect(state.notices).toEqual(["There is nothing to stash."]);
  });

  it("waits for an attachment that is still being stored", async () => {
    const { registry, host, actions, chips } = activate({ composer: composer({ text: "see file" }) });
    chips.addChip({ kind: "attachment", payload: { name: "big.bin", mimeType: "", size: 9 } });
    await expect(registry.executeCommand("prompt-tools.stash", actions)).rejects.toThrow(/still being stored/u);
    expect(host.stash).toEqual([]);
  });

  it("counts the entries in the composer toolbar, brings one back and stashes what was there", async () => {
    const { registry, host, state, actions } = activate({ composer: composer({ text: "first draft", images: [image] }) });
    await registry.executeCommand("prompt-tools.stash", actions);
    state.text = "second draft";
    const Control = registry.getComposerControls().find((control) => control.id === "prompt-tools.stash")!.Component;
    render(<Control actions={actions} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stashed prompts: 1" }));
    fireEvent.click(screen.getByRole("button", { name: /^first draft/u }));
    await waitFor(() => expect(state.text).toBe("first draft"));
    expect(state.images).toEqual([image]);
    expect(host.stash.map((entry) => entry.text)).toEqual(["second draft"]);
    expect(actions.focusComposer).toHaveBeenCalled();
    await screen.findByRole("button", { name: "Stashed prompts: 1" });
  });

  it("deletes an entry from the list, and opens the list from the palette", async () => {
    const { registry, host, state, actions } = activate({ composer: composer({ text: "throw away" }) });
    await registry.executeCommand("prompt-tools.stash", actions);
    const Control = registry.getComposerControls().find((control) => control.id === "prompt-tools.stash")!.Component;
    render(<Control actions={actions} />);
    await screen.findByRole("button", { name: "Stashed prompts: 1" });
    await act(() => registry.executeCommand("prompt-tools.stash-list", actions));
    fireEvent.click(screen.getByRole("button", { name: "Delete stashed prompt: throw away" }));
    await screen.findByRole("button", { name: "Stash this draft" });
    expect(host.stash).toEqual([]);
    expect(state.text).toBe("");
  });

  it("brings chips back as text when Composer Context is off", async () => {
    const { registry, host, state, actions } = activate({ withChips: false, composer: composer() });
    host.stash.push({ id: "old", createdAt: 1, text: "look", chips: [{ kind: "text-excerpt", label: "Terminal", payload: { source: "Terminal", text: "$ ls" } }], images: [] });
    const Control = registry.getComposerControls().find((control) => control.id === "prompt-tools.stash")!.Component;
    render(<Control actions={actions} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stashed prompts: 1" }));
    fireEvent.click(screen.getByRole("button", { name: /^look/u }));
    await waitFor(() => expect(state.text).toBe("From Terminal:\n> $ ls\n\nlook"));
  });
});

describe("Prompt Tools: history", () => {
  const snapshot = {
    cwd: "/repo",
    sessionId: "t1",
    messages: [
      { id: "u1", role: "user", text: "first question", timestamp: 1 },
      { id: "a1", role: "assistant", text: "answer", timestamp: 2 },
      { id: "u2", role: "user", text: "second question", timestamp: 3 },
    ],
  } as unknown as HostSnapshot;

  it("recalls the thread's prompts, then the project's, and Escape empties the composer", async () => {
    const { registry, host } = activate({ prompts: ["from another thread", "first question"] });
    const inline = registry.getComposerInlines().find((entry) => entry.id === "prompt-tools.history")!;
    let text = "";
    const context: ComposerInlineContext & { setText(text: string): void } = { scope: "session:t1", snapshot, fileAttachments: false, imageInput: false, setText: (next) => { text = next; } };
    const press = (key: string) => inline.keyDown!({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, text, selectionStart: 0, selectionEnd: 0 }, context);

    expect(press("a")).toBe(false);
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith(PROMPT_TOOLS_ID, "project-prompts", { cwd: "/repo", excludeSessionId: "t1" }));
    await Promise.resolve();
    expect(press("ArrowUp")).toBe(true);
    expect(text).toBe("second question");
    press("ArrowUp");
    press("ArrowUp");
    expect(text).toBe("from another thread");
    expect(press("ArrowUp")).toBe(true);
    expect(text).toBe("from another thread");
    press("ArrowDown");
    expect(text).toBe("first question");
    expect(press("Escape")).toBe(true);
    expect(text).toBe("");
    expect(press("Escape")).toBe(false);
  });

  it("leaves arrows alone in a composer the user typed into", () => {
    const { registry } = activate();
    const inline = registry.getComposerInlines().find((entry) => entry.id === "prompt-tools.history")!;
    const setText = vi.fn();
    expect(inline.keyDown!({ key: "ArrowUp", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, text: "typed", selectionStart: 0, selectionEnd: 0 }, { scope: "s", snapshot, fileAttachments: false, imageInput: false, setText })).toBe(false);
    expect(setText).not.toHaveBeenCalled();
  });
});

describe("Prompt Tools: citing a reply", () => {
  const reply: UiMessage = { id: "a1", role: "assistant", text: "Use the second approach.\n\nIt is faster.", timestamp: 1 };

  it("cites the selection as a chip and focuses the composer", async () => {
    const { registry, state, actions } = activate();
    const cite = registry.getMessageActions().find((action) => action.id === "prompt-tools.cite")!;
    expect(cite.roles ?? ["assistant"]).toEqual(["assistant"]);
    await cite.run(reply, { selection: "It is faster." }, actions);
    expect(state.chips).toEqual([{ id: "c0", kind: "text-excerpt", label: "“It is faster.”", payload: { source: "your earlier reply", text: "It is faster." } }]);
    expect(actions.focusComposer).toHaveBeenCalled();
  });

  it("quotes the whole reply into the text when there are no chips", async () => {
    const { registry, state, actions } = activate({ withChips: false, composer: composer({ text: "Why?" }) });
    await registry.getMessageActions()[0]!.run(reply, {}, actions);
    expect(state.text).toBe("Why?\n\n> Use the second approach.\n>\n> It is faster.\n\n");
  });
});

describe("Prompt Tools: queue or steer", () => {
  it("queues by default, steers once the option says so, and the palette switches it", async () => {
    const { registry, preferences, actions, state } = activate();
    expect(registry.streamingDelivery()).toBe("followUp");
    preferences.setValue(PROMPT_TOOLS_ID, FOLLOW_UP_OPTION, "steer");
    expect(registry.streamingDelivery()).toBe("steer");
    await registry.executeCommand("prompt-tools.toggle-follow-up", actions);
    expect(registry.streamingDelivery()).toBe("followUp");
    expect(state.notices).toEqual(["While a turn runs, the send key queues a follow-up."]);
    expect(registry.getExtensionSummaries().find((summary) => summary.id === PROMPT_TOOLS_ID)?.options.map((option) => option.id)).toEqual([FOLLOW_UP_OPTION]);
  });
});
