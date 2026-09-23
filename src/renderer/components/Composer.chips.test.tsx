// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { FileText } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, SubmissionResult, UiPromptAttachment } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type ComposerChipDetailProps, type ComposerInlineChip, type ComposerInlineContribution } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";
import { createMemoryStorage, type ClientStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { writeComposerDraft } from "../../workbench/draft-store";
import { chipToken, findChipTokens, plainChipText } from "./composer-chips";

const SCOPE = "session:session";
const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
  activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
};

/** A kit that holds chips per draft and lets core draw them in the text. */
function chipKit() {
  const chips = new Map<string, ComposerInlineChip[]>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of [...listeners]) listener(); };
  let next = 0;
  const Detail = ({ chipId, close }: ComposerChipDetailProps) => <button type="button" onClick={close}>detail of {chipId}</button>;
  const add = (label: string, extra: Partial<ComposerInlineChip> = {}) => {
    const chip = { id: `c${next++}`, label, icon: FileText, title: `/project/${label}`, Detail, ...extra };
    chips.set(SCOPE, [...chips.get(SCOPE) ?? [], chip]);
    changed();
    return chip.id;
  };
  const remove = vi.fn((scope: string, id: string) => { chips.set(scope, (chips.get(scope) ?? []).filter((chip) => chip.id !== id)); changed(); });
  const prepareSend = vi.fn((context: { scope: string; text: string }) => ({ context: (chips.get(context.scope) ?? []).map((chip) => `<${chip.label}>`).join("") }));
  const contribution: ComposerInlineContribution = {
    id: "test.chips",
    chips: { list: (scope) => chips.get(scope) ?? [], remove },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    hasContent: () => true,
    prepareSend,
    settleSend: (scope, accepted) => { if (accepted) { chips.delete(scope); changed(); } },
  };
  return { add, remove, prepareSend, contribution, chips };
}

type Submit = (text?: string, attachments?: UiPromptAttachment[]) => Promise<SubmissionResult>;

function renderWith(contribution: ComposerInlineContribution, storage: ClientStorage = createMemoryStorage()) {
  const onSubmit = vi.fn<Submit>(async () => ({ accepted: true }));
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.kit", name: "Test Kit", activate(context) { context.registerComposerInline({ ...contribution, profiles: ["desktop"] }); } });
  const view = render(
    <TestProviders>
      <ClientStorageProvider storage={storage}>
        <WorkbenchShellContext.Provider value={{ registry, snapshot }}>
          <Composer
            scopeStore={new ComposerScopeStore()}
            snapshot={snapshot}
            draftStorageKey={SCOPE}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef<HTMLTextAreaElement>()}
            onSubmit={onSubmit}
            onAbort={() => {}}
            onCancelQueued={() => {}}
            onSteerQueued={() => {}}
            onSetModel={() => {}}
            onSetThinking={() => {}}
            onCompactContext={() => {}}
          />
        </WorkbenchShellContext.Provider>
      </ClientStorageProvider>
    </TestProviders>,
  );
  return { onSubmit, view, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

afterEach(cleanup);

/** The mirror's lines joined as the textarea holds them. */
function mirrorText(): string {
  return [...document.querySelector(".composer-mirror")!.children].map((line) => line.textContent === "\u200b" ? "" : line.textContent).join("\n");
}

describe("chips in the composer's text", () => {
  it("puts a new chip into the text and draws it in the mirror", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: "look at" } });
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(textarea.value).toBe(`look at ${chipToken("a.ts")} `));
    expect(textarea.className).toContain("mirrored");
    const chip = document.querySelector<HTMLElement>(".composer-mirror [data-chip]");
    expect(chip?.dataset.chip).toBe("a.ts");
    // The mirror draws exactly the characters of the text, so both wrap alike.
    expect(mirrorText()).toBe(textarea.value);
    expect(chip?.querySelector("svg")).toBeTruthy();
  });

  it("draws each hard line as its own block, empty ones included", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: "first\n\nthird" } });
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value)).toHaveLength(1));
    fireEvent.change(textarea, { target: { value: `${textarea.value}\n` } });
    expect(document.querySelector(".composer-mirror")?.children).toHaveLength(4);
    expect(mirrorText()).toBe(textarea.value);
  });

  it("puts a chip at the caret while the field has the keyboard", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: "before after" } });
    textarea.focus();
    textarea.setSelectionRange(7, 7);
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(plainChipText(textarea.value)).toBe("before a.ts after"));
  });

  it("keeps labels unique within the draft", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    act(() => { kit.add("index.ts"); kit.add("index.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value).map((token) => token.label)).toEqual(["index.ts", "index.ts 2"]));
  });

  it("sends chips as their labels, with what the kit adds before the text", async () => {
    const kit = chipKit();
    const { textarea, onSubmit } = renderWith(kit.contribution);
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value)).toHaveLength(1));
    fireEvent.change(textarea, { target: { value: `explain ${textarea.value}please` } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("<a.ts>\n\nexplain a.ts please");
    expect(kit.prepareSend.mock.calls[0]?.[0].text).toBe("explain a.ts please");
    expect(kit.remove).not.toHaveBeenCalled();
  });

  it("takes a chip out whole on Backspace and leaves it out of the prompt", async () => {
    const kit = chipKit();
    const { textarea, onSubmit } = renderWith(kit.contribution);
    act(() => { kit.add("a.ts"); kit.add("b.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value)).toHaveLength(2));
    const [first] = findChipTokens(textarea.value);
    textarea.focus();
    textarea.setSelectionRange(first!.end, first!.end);
    fireEvent.keyDown(textarea, { key: "Backspace" });
    await waitFor(() => expect(findChipTokens(textarea.value).map((token) => token.label)).toEqual(["b.ts"]));
    // The chip stays with its kit until the send, so an undo could bring it back.
    expect(kit.remove).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(kit.remove).toHaveBeenCalledWith(SCOPE, "c0");
    expect(onSubmit.mock.calls[0]?.[0]).toBe("<b.ts>\n\nb.ts ");
  });

  it("repairs an edit that cut into a chip", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value)).toHaveLength(1));
    const [token] = findChipTokens(textarea.value);
    // A word deletion that stopped inside the label.
    fireEvent.change(textarea, { target: { value: textarea.value.slice(0, token!.start + 3) + textarea.value.slice(token!.end) } });
    await waitFor(() => expect(textarea.value).toBe(" "));
  });

  it("drops the token of a chip its kit removed", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    let id = "";
    act(() => { id = kit.add("a.ts"); });
    fireEvent.change(textarea, { target: { value: `${textarea.value}rest` } });
    await waitFor(() => expect(plainChipText(textarea.value)).toBe("a.ts rest"));
    act(() => kit.remove(SCOPE, id));
    await waitFor(() => expect(textarea.value).toBe("rest"));
  });

  it("opens a chip's popover with its details and a way to remove it", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    act(() => { kit.add("a.ts"); });
    await waitFor(() => expect(findChipTokens(textarea.value)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Chip a.ts" }));
    const dialog = await screen.findByRole("dialog", { name: "a.ts" });
    expect(dialog.textContent).toContain("/project/a.ts");
    expect(screen.getByRole("button", { name: "detail of c0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove a.ts" }));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(kit.remove).toHaveBeenCalledWith(SCOPE, "c0");
    expect(screen.queryByRole("dialog", { name: "a.ts" })).toBeNull();
  });

  it("takes its chip back when the text comes back with its token", async () => {
    const kit = chipKit();
    const storage = createMemoryStorage();
    writeComposerDraft(storage, SCOPE, `${chipToken("a.ts")} kept`);
    const { textarea } = renderWith(kit.contribution, storage);
    act(() => { kit.add("a.ts"); });
    // No second token: the chip takes the one the text already had.
    await waitFor(() => expect(textarea.className).toContain("mirrored"));
    expect(findChipTokens(textarea.value).map((token) => token.label)).toEqual(["a.ts"]);
    expect(document.querySelector(".composer-mirror-chip.unresolved")).toBeNull();
  });

  it("gives restored chips of the same name their own tokens back", async () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: `${chipToken("index.ts")} and ${chipToken("index.ts 2")} ` } });
    act(() => { kit.add("index.ts"); kit.add("index.ts"); });
    await waitFor(() => expect(document.querySelectorAll(".composer-mirror-chip:not(.unresolved)")).toHaveLength(2));
    expect(findChipTokens(textarea.value)).toHaveLength(2);
  });

  it("draws a token nothing holds as unresolved and sends it as its label", async () => {
    const kit = chipKit();
    const { textarea, onSubmit } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: `see ${chipToken("gone.ts")}` } });
    expect(document.querySelector(".composer-mirror-chip.unresolved")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("see gone.ts");
  });

  it("marks mentions and leaves the textarea alone without anything to draw", () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: "plain words" } });
    expect(document.querySelector(".composer-mirror")).toBeNull();
    expect(textarea.className).not.toContain("mirrored");
    fireEvent.change(textarea, { target: { value: "open @src/a.ts now" } });
    expect(document.querySelector(".composer-mirror-mention")?.textContent).toBe("@src/a.ts");
  });

  it("shows the textarea's own text while an input method composes", () => {
    const kit = chipKit();
    const { textarea } = renderWith(kit.contribution);
    fireEvent.change(textarea, { target: { value: "open @src/a.ts " } });
    fireEvent.compositionStart(textarea);
    expect(document.querySelector(".composer-mirror")).toBeNull();
    fireEvent.compositionEnd(textarea);
    expect(document.querySelector(".composer-mirror")).toBeTruthy();
  });
});
