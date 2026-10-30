// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTranscriptHighlights, highlightTranscript, occurrences } from "./transcript-highlights";

const registry = new Map<string, { ranges: Range[] }>();

beforeEach(() => {
  registry.clear();
  class FakeHighlight { readonly ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } }
  Object.assign(globalThis, { Highlight: FakeHighlight, CSS: { highlights: registry } });
});
afterEach(() => { document.body.innerHTML = ""; Reflect.deleteProperty(globalThis, "Highlight"); Reflect.deleteProperty(globalThis, "CSS"); });

const texts = (name: string) => registry.get(name)?.ranges.map((range) => range.toString());

describe("marking the query in the transcript", () => {
  it("marks separated literal tokens for global Find, including punctuation and folded Unicode offsets", () => {
    document.body.innerHTML = `<div id="root"><div data-message-id="a">Quartz next to <b>moon</b>, İ and ς. a+b beside [x]</div></div>`;
    const root = document.getElementById("root")!;
    highlightTranscript(root, "QUARTZ moon i σ a+b [x]", "a", "all-words");
    expect(texts("transcript-find-active")).toEqual(["Quartz", "moon", "İ", "ς", "a+b", "i", "[x]"]);
    highlightTranscript(root, "quartz moon", "a");
    expect(registry.size).toBe(0);
  });

  it("does not draw duplicate overlapping token ranges", () => {
    document.body.innerHTML = `<div id="root"><div data-message-id="a">quartz</div></div>`;
    highlightTranscript(document.getElementById("root")!, "quartz quart quartz", "a", "all-words");
    expect(texts("transcript-find-active")).toEqual(["quartz"]);
  });

  it("finds every occurrence regardless of case", () => {
    expect(occurrences("Quartz, quartz and QUARTZ", "quartz")).toEqual([0, 8, 19]);
    expect(occurrences("nothing", "")).toEqual([]);
  });

  it("marks the words in every drawn message and the one the find stands on separately", () => {
    document.body.innerHTML = `<div id="root">
      <div data-message-id="a"><p>First <b>Quartz</b> here</p></div>
      <div data-message-id="b"><p>quartz again, QUARTZ</p><svg><text>quartz</text></svg></div>
    </div>`;
    highlightTranscript(document.getElementById("root")!, " quartz ", "b");
    expect(texts("transcript-find")).toEqual(["Quartz"]);
    expect(texts("transcript-find-active")).toEqual(["quartz", "QUARTZ"]);
  });

  it("clears the marks for an empty query or no match", () => {
    document.body.innerHTML = `<div id="root"><div data-message-id="a">quartz</div></div>`;
    const root = document.getElementById("root")!;
    highlightTranscript(root, "quartz", undefined);
    expect(registry.size).toBe(2);
    highlightTranscript(root, "absent", undefined);
    expect(registry.size).toBe(0);
    highlightTranscript(root, "quartz", undefined);
    clearTranscriptHighlights();
    expect(registry.size).toBe(0);
  });

  it("does nothing where the browser has no highlight API", () => {
    Reflect.deleteProperty(globalThis, "CSS");
    document.body.innerHTML = `<div id="root"><div data-message-id="a">quartz</div></div>`;
    expect(() => highlightTranscript(document.getElementById("root")!, "quartz", "a")).not.toThrow();
  });
});
