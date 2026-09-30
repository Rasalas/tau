// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerDictation } from "./ComposerDictation";
import type { DictationPort } from "../dictation";
const port = (): DictationPort => ({ languages: vi.fn(async () => ({ available: true, languages: [{ id: "en-US", name: "English", installed: true }] })), download: vi.fn(async () => undefined), start: vi.fn(async () => undefined), finish: vi.fn(async () => "Local words"), cancel: vi.fn(async () => undefined) });
describe("local composer dictation", () => {
  it("captures the draft cursor before recording, offers transcript review and inserts only on request", async () => {
    const native = port(); const capture = vi.fn(); const insert = vi.fn();
    render(<ComposerDictation port={native} capture={capture} insert={insert} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    expect(capture).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    const review = await screen.findByRole("textbox", { name: "Dictation transcript" });
    expect(insert).not.toHaveBeenCalled();
    fireEvent.change(review, { target: { value: "Reviewed words" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert into draft" }));
    expect(insert).toHaveBeenCalledWith("Reviewed words");
  });
  it("drops a late transcription after cancellation", async () => {
    const native = port(); const insert = vi.fn(); let finish!: (text: string) => void;
    native.finish = () => new Promise((resolve) => { finish = resolve; });
    render(<ComposerDictation port={native} capture={vi.fn()} insert={insert} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    await act(async () => { finish("Too late"); });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Dictation transcript" })).toBeNull());
    expect(insert).not.toHaveBeenCalled();
  });
});


it("ignores a language response from a replaced native port", async () => {
  const first = port(); const second = port();
  let resolveFirst!: (value: Awaited<ReturnType<DictationPort["languages"]>>) => void;
  first.languages = () => new Promise((resolve) => { resolveFirst = resolve; });
  second.languages = async () => ({ available: true, languages: [{ id: "fr-FR", name: "French", installed: true }] });
  const capture = vi.fn(); const insert = vi.fn();
  const rendered = render(<ComposerDictation port={first} capture={capture} insert={insert} />);
  rendered.rerender(<ComposerDictation port={second} capture={capture} insert={insert} />);
  await screen.findByRole("option", { name: "French" });
  await act(async () => { resolveFirst({ available: true, languages: [{ id: "en-US", name: "English", installed: true }] }); });
  expect(screen.getByRole("option", { name: "French" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "English" })).toBeNull();
});
