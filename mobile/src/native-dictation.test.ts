import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationUpdate } from "../../src/renderer/dictation";

const plugin = vi.hoisted(() => ({
  dictationLanguages: vi.fn(), dictationDownload: vi.fn(), dictationStart: vi.fn(),
  dictationFinish: vi.fn(), dictationCancel: vi.fn(async () => undefined), addListener: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => plugin }));
import { nativeDictation } from "./native";

beforeEach(async () => {
  await nativeDictation.cancel();
  vi.clearAllMocks();
});

describe("native dictation bridge", () => {
  it("forwards the catalog, language download and final transcript", async () => {
    const catalog = { available: true, defaultLanguage: "de-DE", languages: [{ id: "de-DE", name: "German", installed: false }] };
    plugin.dictationLanguages.mockResolvedValueOnce(catalog);
    plugin.dictationFinish.mockResolvedValueOnce({ text: "Hello" });
    expect(await nativeDictation.languages()).toEqual(catalog);
    await nativeDictation.download("de-DE");
    expect(plugin.dictationDownload).toHaveBeenCalledWith({ language: "de-DE" });
    expect(await nativeDictation.finish()).toBe("Hello");
  });

  it("rejects late events from a cancelled or previous recording and removes its listener", async () => {
    let emit!: (event: DictationUpdate & { id: string }) => void;
    const remove = vi.fn(async () => undefined);
    plugin.addListener.mockImplementationOnce(async (name, listener) => {
      expect(name).toBe("dictation");
      emit = listener;
      return { remove };
    });
    const received = vi.fn();
    const stop = await nativeDictation.listen!(received);
    await nativeDictation.start("de-DE");
    const firstId = plugin.dictationStart.mock.calls[0]![0].id as string;
    expect(firstId).not.toBe("");
    emit({ id: firstId, text: "First", preview: "phrase", level: .4 });
    expect(received).toHaveBeenCalledOnce();
    await nativeDictation.cancel();
    emit({ id: firstId, text: "First late phrase" });
    await nativeDictation.start("de-DE");
    const secondId = plugin.dictationStart.mock.calls[1]![0].id as string;
    expect(secondId).not.toBe(firstId);
    emit({ id: firstId, text: "First stale phrase" });
    emit({ id: secondId, text: "Second" });
    expect(received.mock.calls.map(([event]) => event.text)).toEqual(["First", "Second"]);
    stop();
    expect(remove).toHaveBeenCalledOnce();
  });
});
