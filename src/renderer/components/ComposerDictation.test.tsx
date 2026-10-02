// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { ComposerDictation, NativeComposerDictation } from "./ComposerDictation";
import { TestProviders } from "../test-support/test-providers";
import type { DictationPort, DictationUpdate } from "../dictation";
const port = (): DictationPort => ({ languages: vi.fn(async () => ({ available: true, defaultLanguage: "en-US", languages: [{ id: "yue-CN", name: "Cantonese", installed: true }, { id: "en-US", name: "English", installed: true }] })), download: vi.fn(async () => undefined), start: vi.fn(async () => undefined), finish: vi.fn(async () => "Local words"), cancel: vi.fn(async () => undefined) });

describe("local composer dictation", () => {
  it("uses device language, captures the cursor and inserts without a review step", async () => {
    const native = port(); const capture = vi.fn(); const insert = vi.fn();
    render(<ComposerDictation port={native} capture={capture} insert={insert} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    expect(capture).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith("Local words"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toHaveProperty("disabled", false));
    expect(native.start).toHaveBeenCalledWith("en-US");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("inserts finalized phrases during recording, previews provisional words and never duplicates final text", async () => {
    const native = port(); const insert = vi.fn(); const unsubscribe = vi.fn();
    let update!: (value: DictationUpdate) => void;
    native.listen = async (listener) => { update = listener; return unsubscribe; };
    native.finish = async () => "Hello world!";
    render(<ComposerDictation port={native} capture={vi.fn()} insert={insert} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    act(() => update({ text: "Hello", preview: "world", level: .5 }));
    expect(insert).toHaveBeenCalledWith("Hello");
    expect(screen.getByText("world")).toBeTruthy();
    act(() => update({ text: "Hello world" }));
    expect(insert).toHaveBeenLastCalledWith(" world");
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await waitFor(() => expect(insert).toHaveBeenLastCalledWith("!"));
    expect(insert.mock.calls.map(([text]) => text).join("")).toBe("Hello world!");
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });
  it("inserts at the captured selection and preserves edits made between speech results", async () => {
    const native = port();
    let update!: (value: DictationUpdate) => void;
    native.listen = async (listener) => { update = listener; return vi.fn(); };
    native.finish = async () => "new words.";
    function Editor() {
      const [text, setText] = useState("Hello old");
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return <><textarea ref={inputRef} value={text} onChange={(event) => setText(event.target.value)} />
        <NativeComposerDictation port={native} text={text} inputRef={inputRef} updateDraft={setText} /></>;
    }
    render(<TestProviders><Editor /></TestProviders>);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox");
    input.setSelectionRange(6, 9);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    act(() => update({ text: "new" }));
    await waitFor(() => expect(input.value).toBe("Hello new"));
    fireEvent.change(input, { target: { value: "Hello new edited" } });
    act(() => update({ text: "new words" }));
    await waitFor(() => expect(input.value).toBe("Hello new edited words"));
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    await waitFor(() => expect(input.value).toBe("Hello new edited words."));
  });
  it("drops late text after cancellation and releases the composer", async () => {
    const native = port(); const insert = vi.fn(); const active = vi.fn(); let finish!: (text: string) => void;
    native.finish = () => new Promise((resolve) => { finish = resolve; });
    render(<ComposerDictation port={native} capture={vi.fn()} insert={insert} onActiveChange={active} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await act(async () => { finish("Too late"); });
    await waitFor(() => expect(screen.queryByText("Finishing…")).toBeNull());
    expect(insert).not.toHaveBeenCalled();
    expect(active).toHaveBeenLastCalledWith(false);
  });
  it("ignores language responses from a replaced native port", async () => {
    const first = port(); const second = port();
    let resolveFirst!: (value: Awaited<ReturnType<DictationPort["languages"]>>) => void;
    first.languages = () => new Promise((resolve) => { resolveFirst = resolve; });
    second.languages = async () => ({ available: true, defaultLanguage: "fr-FR", languages: [{ id: "fr-FR", name: "French", installed: true }] });
    const rendered = render(<ComposerDictation port={first} capture={vi.fn()} insert={vi.fn()} />);
    rendered.rerender(<ComposerDictation port={second} capture={vi.fn()} insert={vi.fn()} />);
    await screen.findByRole("button", { name: "Dictate" });
    await act(async () => { resolveFirst({ available: true, defaultLanguage: "en-US", languages: [{ id: "en-US", name: "English", installed: true }] }); });
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(second.start).toHaveBeenCalledWith("fr-FR"));
    expect(first.start).not.toHaveBeenCalled();
  });
  it("downloads the language selected in Settings before recording", async () => {
    const native = port();
    native.languages = async () => ({ available: true, defaultLanguage: "en-US", languages: [{ id: "de-DE", name: "German", installed: false }] });
    render(<ComposerDictation port={native} language="de-DE" capture={vi.fn()} insert={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    expect(native.download).toHaveBeenCalledWith("de-DE");
    expect(native.start).toHaveBeenCalledWith("de-DE");
  });
  it("does not choose an unrelated language when the device language is unsupported", async () => {
    const native = port();
    native.languages = async () => ({ available: true, defaultLanguage: "de-DE", languages: [{ id: "yue-CN", name: "Cantonese", installed: true }] });
    render(<ComposerDictation port={native} capture={vi.fn()} insert={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Dictate" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.title).toContain("Settings");
  });
  it("cancels on Escape and ignores old streaming results", async () => {
    const native = port(); const insert = vi.fn(); const unsubscribe = vi.fn();
    let update!: (value: DictationUpdate) => void;
    native.listen = async (listener) => { update = listener; return unsubscribe; };
    render(<ComposerDictation port={native} capture={vi.fn()} insert={insert} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    act(() => update({ text: "Kept" }));
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => update({ text: "Kept late words" }));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await screen.findByRole("button", { name: "Dictate" });
  });
  it("releases a streaming listener when recording cannot start", async () => {
    const native = port(); const unsubscribe = vi.fn();
    native.listen = async () => unsubscribe;
    native.start = async () => { throw Error("Denied"); };
    render(<ComposerDictation port={native} capture={vi.fn()} insert={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });
  it("releases a listener that arrives after the component unmounts", async () => {
    const native = port(); const unsubscribe = vi.fn();
    let subscribed!: (stop: () => void) => void;
    native.listen = () => new Promise((resolve) => { subscribed = resolve; });
    const view = render(<ComposerDictation port={native} capture={vi.fn()} insert={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    view.unmount();
    await act(async () => subscribed(unsubscribe));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(native.start).not.toHaveBeenCalled();
  });
  it("recovers from microphone denial without inserting or leaving the composer blocked", async () => {
    const native = port(); const insert = vi.fn(); const active = vi.fn();
    native.start = async () => { throw Error("Microphone access was denied."); };
    render(<ComposerDictation port={native} capture={vi.fn()} insert={insert} onActiveChange={active} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Microphone access was denied.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toHaveProperty("disabled", false));
    expect(insert).not.toHaveBeenCalled();
    expect(active).toHaveBeenLastCalledWith(false);
  });
});
