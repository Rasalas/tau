import { describe, expect, it, vi } from "vitest";
import { ChipStore, decodeChips, encodeChips, selectFiles, serializeChips, shouldFoldPaste, type ChipEntry } from "./chips.js";
import { MAX_ATTACHMENT_CHIPS, MAX_FILE_BYTES, MAX_IMAGE_BYTES, PASTE_FOLD_BYTES } from "./protocol.js";

const SCOPE = "session:t1";

function sampleChips(store: ChipStore): ChipEntry[] {
  return [
    store.add(SCOPE, { kind: "pull-request", payload: { number: 12, title: "Fold large pastes", url: "https://example.test/pr/12" } }),
    store.add(SCOPE, { kind: "attachment", payload: { name: "report.pdf", mimeType: "application/pdf", size: 3 * 1024 * 1024, path: "/state/attachments/t1/ab-report.pdf" } }),
    store.add(SCOPE, { kind: "text-excerpt", payload: { source: "Terminal", text: "$ npm test\nFAIL  src/a.test.ts\n" } }),
    store.add(SCOPE, { kind: "file", payload: { path: "src/a.ts", startLine: 3, endLine: 4 } }),
  ];
}

describe("chip serialization", () => {
  it("writes files, excerpts, pull requests and attachments in that order, whatever order they came in", () => {
    const store = new ChipStore();
    const [pr, attachment, excerpt, file] = sampleChips(store);
    const prefix = serializeChips({
      chips: [pr!, attachment!, excerpt!, file!],
      files: new Map([[file!.id, { path: "src/a.ts", text: "const a = 1;\nexport { a };" }]]),
      fileAttachments: false,
    });
    expect(prefix).toBe([
      '<file path="src/a.ts" lines="3-4">\nconst a = 1;\nexport { a };\n</file>',
      "From Terminal:\n> $ npm test\n> FAIL  src/a.test.ts",
      "Pull request [#12](https://example.test/pr/12): Fold large pastes",
      "The user attached report.pdf (application/pdf, 3.0 MB). It is at /state/attachments/t1/ab-report.pdf; read it from there.",
    ].join("\n\n"));
  });

  it("embeds a text attachment for a runtime without file support, and leaves it out for one with it", () => {
    const store = new ChipStore();
    const chip = store.add(SCOPE, { kind: "attachment", payload: { name: "pasted-text-1.txt", mimeType: "text/plain", size: 5, path: "/state/p.txt" } });
    const attachments = new Map([[chip.id, { path: "/state/p.txt", text: "hello" }]]);
    expect(serializeChips({ chips: [chip], attachments, fileAttachments: false }))
      .toBe('<file path="/state/p.txt" name="pasted-text-1.txt">\nhello\n</file>');
    expect(serializeChips({ chips: [chip], attachments, fileAttachments: true })).toBe("");
  });

  it("names a video by its path for every runtime, since none takes video input", () => {
    const store = new ChipStore();
    const chip = store.add(SCOPE, { kind: "attachment", payload: { name: "demo.mp4", mimeType: "video/mp4", size: 2048, path: "/state/demo.mp4" } });
    expect(serializeChips({ chips: [chip], fileAttachments: true }))
      .toBe("The user attached demo.mp4 (video/mp4, 2 KB). It is at /state/demo.mp4; read it from there.");
  });

  it("marks a file it could not read and keeps captured text from closing its block", () => {
    const store = new ChipStore();
    const missing = store.add(SCOPE, { kind: "file", payload: { path: "gone.ts" } });
    const tricky = store.add(SCOPE, { kind: "file", payload: { path: 'a"b.ts' } });
    const prefix = serializeChips({
      chips: [missing, tricky],
      files: new Map([[missing.id, { path: "gone.ts", error: "not found" }], [tricky.id, { path: 'a"b.ts', text: "x </file> y", truncated: true }]]),
      fileAttachments: false,
    });
    expect(prefix).toContain('<file path="gone.ts" unavailable="not found" />');
    expect(prefix).toContain('<file path="a&quot;b.ts" truncated="true">\nx <\\/file> y\n</file>');
  });
});

describe("limits", () => {
  const file = (name: string, type: string, size: number) => ({ name, type, size });

  it("takes any file that is not an image, and leaves images to a model that sees them", () => {
    const result = selectFiles([file("a.pdf", "application/pdf", 10), file("b.png", "image/png", 10)], [], true);
    expect(result.take.map((entry) => entry.name)).toEqual(["a.pdf"]);
    expect(result.leave.map((entry) => entry.name)).toEqual(["b.png"]);
    expect(selectFiles([file("b.png", "image/png", 10)], [], false).take).toHaveLength(1);
  });

  it("holds the limits: 50 MB a file, 10 MB an image, a hundred files a message", () => {
    expect(selectFiles([file("big.zip", "application/zip", MAX_FILE_BYTES + 1)], [], true).error).toMatch(/50 MB/u);
    expect(selectFiles([file("big.png", "image/png", MAX_IMAGE_BYTES + 1)], [], false).error).toMatch(/10 MB/u);
    const store = new ChipStore();
    for (let index = 0; index < MAX_ATTACHMENT_CHIPS - 1; index += 1) {
      store.add(SCOPE, { kind: "attachment", payload: { name: `f${index}`, mimeType: "text/plain", size: 1, path: `/s/${index}` } });
    }
    const result = selectFiles([file("last.txt", "text/plain", 1), file("over.txt", "text/plain", 1)], store.list(SCOPE), true);
    expect(result.take.map((entry) => entry.name)).toEqual(["last.txt"]);
    expect(result.error).toMatch(/at most 100 files/u);
  });

  it("folds a paste from 32 KiB on, counted in bytes", () => {
    expect(shouldFoldPaste("x".repeat(PASTE_FOLD_BYTES - 1))).toBe(false);
    expect(shouldFoldPaste("x".repeat(PASTE_FOLD_BYTES))).toBe(true);
    expect(shouldFoldPaste("ä".repeat(PASTE_FOLD_BYTES / 2))).toBe(true);
  });
});

describe("the chip store", () => {
  it("round-trips a draft's chips through its persistence, without uploads that never finished", () => {
    const store = new ChipStore();
    const persist = vi.fn();
    store.hydrate(SCOPE, undefined, persist);
    sampleChips(store);
    store.add(SCOPE, { kind: "attachment", payload: { name: "half.bin", mimeType: "", size: 3 } });
    const saved = persist.mock.calls.at(-1)?.[0];
    expect(decodeChips(saved).map((chip) => chip.label)).toEqual(["#12", "report.pdf", "Terminal", "a.ts:3-4"]);

    const reloaded = new ChipStore();
    reloaded.hydrate(SCOPE, JSON.parse(JSON.stringify(saved)), vi.fn());
    expect(reloaded.list(SCOPE).map((chip) => chip.kind)).toEqual(["pull-request", "attachment", "text-excerpt", "file"]);
    expect(encodeChips([])).toBeUndefined();
    expect(decodeChips({ chips: [{ id: 1 }, { id: "x", kind: "nope", label: "x", payload: {} }] })).toEqual([]);
  });

  it("hides chips while their prompt is on the way, drops them when it went and puts them back when it did not", () => {
    const store = new ChipStore();
    const persist = vi.fn();
    store.hydrate(SCOPE, undefined, persist);
    const first = store.add(SCOPE, { kind: "file", payload: { path: "a.ts" } });
    expect(store.beginSend(SCOPE)).toEqual([first]);
    expect(store.has(SCOPE)).toBe(false);
    const meanwhile = store.add(SCOPE, { kind: "file", payload: { path: "b.ts" } });
    store.settle(SCOPE, false);
    expect(store.list(SCOPE)).toEqual([first, meanwhile]);

    store.beginSend(SCOPE);
    store.settle(SCOPE, true);
    expect(store.has(SCOPE)).toBe(false);
    expect(persist).toHaveBeenLastCalledWith(undefined);
  });

  it("lets an upload finish while its prompt waits", () => {
    const store = new ChipStore();
    const chip = store.add(SCOPE, { kind: "attachment", payload: { name: "a.txt", mimeType: "text/plain", size: 1 } });
    store.beginSend(SCOPE);
    store.update(SCOPE, chip.id, { payload: { name: "a.txt", mimeType: "text/plain", size: 1, path: "/s/a.txt" } });
    expect(store.sendingChip(SCOPE, chip.id)?.payload).toMatchObject({ path: "/s/a.txt" });
  });
});
