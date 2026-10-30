// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, SubmissionResult, UiPromptAttachment } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type ComposerInlineContribution, type ComposerInlineProps } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";
import { composerTrigger } from "./ComposerAutocomplete";
import { withInlineContext } from "./useComposerSubmission";
import { classifyThreadDrop } from "../../shared/thread-drop";
import { createMemoryStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { readComposerDraftState } from "../../workbench/draft-store";
import { armPasteAsText } from "../paste-as-text";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
  activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
};

/** A minimal chip holder: one list per draft, the way a context kit keeps them. */
function chipHolder() {
  const chips = new Map<string, string[]>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const add = (scope: string, label: string) => { chips.set(scope, [...chips.get(scope) ?? [], label]); changed(); };
  const settled = vi.fn((scope: string, accepted: boolean) => { if (accepted) { chips.delete(scope); changed(); } });
  const Strip = ({ scope, draftState }: ComposerInlineProps) => (
    <div aria-label="Context">
      {(chips.get(scope) ?? []).map((label) => <span key={label}>{label}</span>)}
      <button type="button" onClick={() => draftState.write({ saved: chips.get(scope) })}>save</button>
    </div>
  );
  const contribution: ComposerInlineContribution = {
    id: "test.chips",
    Component: Strip,
    triggers: [{
      char: "#",
      label: "Pull requests",
      search: async (query) => [{ id: "12", label: `#12 ${query || "all"}` }, { id: "13", label: "#13" }],
      select: (item, _query, context) => add(context.scope, `PR ${item.id}`),
    }],
    pasteText: (text, context) => {
      if (text.length < 10) return false;
      add(context.scope, `paste ${text.length}`);
      return true;
    },
    takeFiles: (files, context) => {
      for (const file of files) if (!file.type.startsWith("image/")) add(context.scope, file.name);
      return files.filter((file) => file.type.startsWith("image/"));
    },
    hasContent: (scope) => (chips.get(scope)?.length ?? 0) > 0,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    prepareSend: (context) => ({
      context: (chips.get(context.scope) ?? []).join(", "),
      attachments: context.fileAttachments ? [{ kind: "file", name: "a.pdf", mimeType: "application/pdf", path: "/state/a.pdf", size: 3 }] : [],
    }),
    settleSend: settled,
  };
  return { add, settled, contribution, chips };
}

type Submit = (text?: string, attachments?: UiPromptAttachment[]) => Promise<SubmissionResult>;

function renderWith(contribution: ComposerInlineContribution, onSubmit = vi.fn<Submit>(async () => ({ accepted: true })), shot: HostSnapshot = snapshot) {
  const storage = createMemoryStorage();
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.context", name: "Test Context", activate(context) { context.registerComposerInline({ ...contribution, profiles: ["desktop"] }); } });
  render(
    <TestProviders>
      <ClientStorageProvider storage={storage}>
      <WorkbenchShellContext.Provider value={{ registry, snapshot: shot }}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={shot}
          draftStorageKey="session:session"
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
  return { onSubmit, registry, storage, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

afterEach(cleanup);

describe("composer inline contributions", () => {
  it("offers a typed drop only on drop, claims it without native insertion, and focuses the draft", () => {
    const holder = chipHolder();
    const mimeType = "application/x-test-context";
    const take = vi.fn((value: string, context: { scope: string }) => { holder.add(context.scope, value); return true; });
    holder.contribution.drop = { mimeType, take };
    const { textarea } = renderWith(holder.contribution);
    const frame = textarea.closest(".composer-frame")!;
    const dataTransfer = { types: [mimeType, "text/plain"], files: [], getData: vi.fn(() => "dropped context"), dropEffect: "none" };
    expect(fireEvent.dragOver(frame, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(dataTransfer.getData).not.toHaveBeenCalled();
    const bubbled = vi.fn();
    document.addEventListener("drop", bubbled);
    try {
      expect(fireEvent.drop(frame, { dataTransfer })).toBe(false);
      expect(bubbled).not.toHaveBeenCalled();
    } finally { document.removeEventListener("drop", bubbled); }
    expect(dataTransfer.getData).toHaveBeenCalledWith(mimeType);
    expect(take).toHaveBeenCalledWith("dropped context", expect.objectContaining({ scope: "session:session" }));
    expect(holder.chips.get("session:session")).toEqual(["dropped context"]);
    expect(document.activeElement).toBe(textarea);
  });

  it("leaves unknown or refused text drops to the browser", () => {
    const holder = chipHolder();
    const take = vi.fn(() => false);
    holder.contribution.drop = { mimeType: "application/x-test-context", take };
    const { textarea } = renderWith(holder.contribution);
    const frame = textarea.closest(".composer-frame")!;
    const dataTransfer = { types: ["text/plain"], files: [], getData: vi.fn(() => "unknown") };
    expect(fireEvent.dragOver(frame, { dataTransfer })).toBe(true);
    expect(fireEvent.drop(frame, { dataTransfer })).toBe(true);
    expect(take).not.toHaveBeenCalled();
    expect(dataTransfer.getData).not.toHaveBeenCalled();
    dataTransfer.types = ["application/x-test-context"];
    expect(fireEvent.drop(frame, { dataTransfer })).toBe(true);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it.each(["refused", "throws"])("keeps the file-drop path when a typed contribution %s", async (outcome) => {
    const holder = chipHolder();
    holder.contribution.drop = { mimeType: "application/x-test-context", take: () => {
      if (outcome === "throws") throw new Error("Cannot take this context");
      return false;
    } };
    const { textarea } = renderWith(holder.contribution);
    fireEvent.drop(textarea.closest(".composer-frame")!, { dataTransfer: {
      types: ["application/x-test-context", "Files"], getData: () => "bad context",
      files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
    } });
    await waitFor(() => expect(holder.chips.get("session:session")).toEqual(["notes.txt"]));
  });

  it("draws the strip inside the input frame and sends with nothing but its context", async () => {
    const holder = chipHolder();
    const { onSubmit } = renderWith(holder.contribution);
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(screen.getByLabelText("Context").closest(".composer-frame")).toBeTruthy();
    expect(send.disabled).toBe(true);
    act(() => holder.add("session:session", "src/a.ts"));
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]).toEqual(["src/a.ts", []]);
    await waitFor(() => expect(holder.settled).toHaveBeenCalledWith("session:session", true));
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });

  it("puts the context before the text, sends the files a runtime takes, and hands a refusal back", async () => {
    const holder = chipHolder();
    const onSubmit = vi.fn<Submit>(async () => ({ accepted: false, message: "no" }));
    const { textarea } = renderWith(holder.contribution, onSubmit, { ...snapshot, runtimeCapabilities: { skillInvocationDialect: "pi", fileAttachments: true } });
    act(() => holder.add("session:session", "PR 12"));
    fireEvent.change(textarea, { target: { value: "review this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]).toEqual(["PR 12\n\nreview this", [expect.objectContaining({ kind: "file", path: "/state/a.pdf" })]]);
    await waitFor(() => expect(holder.settled).toHaveBeenCalledWith("session:session", false));
    expect(screen.getByText("PR 12")).toBeTruthy();
    await waitFor(() => expect(textarea.value).toBe("review this"));
  });

  it("leaves the context out of a slash command", async () => {
    const holder = chipHolder();
    const { onSubmit, textarea } = renderWith(holder.contribution);
    act(() => holder.add("session:session", "src/a.ts"));
    fireEvent.change(textarea, { target: { value: "/compact" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("/compact");
    expect(holder.settled).not.toHaveBeenCalled();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("lets the contribution take a paste and non-image files, and leaves images to core", async () => {
    const holder = chipHolder();
    const { textarea } = renderWith(holder.contribution);
    const frame = textarea.closest(".composer-frame")!;
    fireEvent.paste(frame, { clipboardData: { files: [], getData: () => "x".repeat(40) } });
    expect(screen.getByText("paste 40")).toBeTruthy();
    fireEvent.paste(frame, { clipboardData: { files: [], getData: () => "short" } });
    expect(screen.queryByText("paste 5")).toBeNull();
    // Paste as Text: the same paste stays the field's own text, once; the fold cancels the next one.
    armPasteAsText();
    expect(fireEvent.paste(frame, { clipboardData: { files: [], getData: () => "y".repeat(41) } })).toBe(true);
    expect(fireEvent.paste(frame, { clipboardData: { files: [], getData: () => "y".repeat(41) } })).toBe(false);

    const attach = await screen.findByRole("button", { name: "Attach files" }) as HTMLButtonElement;
    expect(attach.disabled).toBe(false);
    const input = screen.getByLabelText("Choose attachment files") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBeNull();
    fireEvent.change(input, { target: { files: [new File(["%PDF"], "spec.pdf", { type: "application/pdf" }), new File(["x"], "shot.png", { type: "image/png" })] } });
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    // The image is core's; this model takes none, so core says so.
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("opens the contribution's trigger menu and hands the chosen row over without the typed trigger", async () => {
    const holder = chipHolder();
    const { textarea } = renderWith(holder.contribution);
    fireEvent.change(textarea, { target: { value: "see #fix", selectionStart: 8 } });
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Pull requests" })).toBeTruthy());
    // The rows are searched asynchronously and can arrive a render after the list.
    await screen.findByRole("option", { name: /#12 fix/u });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("see ");
    expect(screen.getByText("PR 13")).toBeTruthy();
  });

  it("persists what the contribution keeps beside the draft", () => {
    const holder = chipHolder();
    const { storage } = renderWith(holder.contribution);
    act(() => holder.add("session:session", "src/a.ts"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(readComposerDraftState(storage, "session:session", "test.context")).toEqual({ saved: ["src/a.ts"] });
  });
});

describe("the pieces the seam is built from", () => {
  it("reads an extension's trigger at the start of a word, ahead of core's own @", () => {
    expect(composerTrigger("see #12", 7, ["#"])).toEqual({ kind: "extension", char: "#", query: "12", start: 4, end: 7 });
    expect(composerTrigger("a#12", 4, ["#"])).toBeUndefined();
    expect(composerTrigger("@src", 4, ["@"])).toMatchObject({ kind: "extension", char: "@", query: "src" });
    expect(composerTrigger("@src", 4)).toMatchObject({ kind: "@", query: "src" });
    expect(composerTrigger("x ^a", 4, ["^"])).toMatchObject({ kind: "extension", char: "^", query: "a" });
  });

  it.each([
    ["/tmp/build.sh", "/tmp/build.sh".length],
    ["/etc/hosts", "/et".length],
    ["  /etc/hosts", "  /etc".length],
  ])("keeps the path in %j out of the slash menu", (text, caret) => {
    expect(composerTrigger(text, caret)).toBeUndefined();
  });

  it("still opens the slash menu for a command and its argument", () => {
    expect(composerTrigger("/mo", 3)).toMatchObject({ kind: "/", query: "mo" });
    expect(composerTrigger("/mo rest", 3)).toMatchObject({ kind: "/", query: "mo" });
    expect(composerTrigger("/model openai/gpt", 17)).toMatchObject({ kind: "arg", command: "model", query: "openai/gpt" });
  });

  it.each(["$5", "$9.99", "$.99", "$1,000", "$10k", "$2e6", "$10k.", "$5?", "$9.99)"])("keeps the amount %j out of the skill menu", (text) => {
    expect(composerTrigger(text, text.length)).toBeUndefined();
    const inline = `budget ${text}`;
    // Even a similarly named skill must not turn an amount into an invocation.
    expect(composerTrigger(inline, inline.length, [], [text.slice(1)])).toBeUndefined();
  });

  it("checks the whole amount while editing, and keeps skills that start with numbers", () => {
    expect(composerTrigger("$9.99", 2)).toBeUndefined();
    expect(composerTrigger("budget $9.99", 9, [], ["9.99"])).toBeUndefined();
    for (const text of ["$", "$1password", "$2fa"]) {
      expect(composerTrigger(text, text.length)).toMatchObject({ kind: "$", query: text.slice(1) });
    }
    expect(composerTrigger("$1password", 2)).toMatchObject({ kind: "$", query: "1" });
    expect(composerTrigger("use $1password", 6, [], ["1password"])).toMatchObject({ kind: "$", query: "1" });
  });

  it("places context before plain text and after a skill's instruction", () => {
    expect(withInlineContext("do it", "")).toEqual({ text: "do it", skillDraft: undefined });
    expect(withInlineContext("do it", "<file/>")).toEqual({ text: "<file/>\n\ndo it" });
    expect(withInlineContext("  ", "<file/>")).toEqual({ text: "<file/>" });
    const skill = { source: "skill" as const, name: "fix", command: "/skill:fix", visibleText: "do it" };
    expect(withInlineContext("$fix do it", "<file/>", skill)).toEqual({
      text: "$fix do it\n\n<file/>",
      skillDraft: { ...skill, visibleText: "do it\n\n<file/>" },
    });
  });

  it("refuses a trigger core owns", () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.activate({
      id: "bad", name: "Bad",
      activate(context) { context.registerComposerInline({ id: "bad", triggers: [{ char: "/", label: "x", search: () => [], select: () => undefined }] }); },
    })).toThrow(/one character other than/u);
  });

  it("lets any file through the thread drop when an extension takes files", () => {
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "application/pdf", size: 10 }], false)).toBe("unavailable");
    expect(classifyThreadDrop(true, [{ kind: "file", mimeType: "application/pdf", size: 10 }], false, 0, 0, true)).toBe("files");
  });
});
