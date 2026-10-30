import { describe, expect, it } from "vitest";
import { NOTEBOOK_MAX_BYTES, NOTEBOOK_MAX_CELLS, NOTEBOOK_MAX_OUTPUTS, NOTEBOOK_MAX_OUTPUTS_PER_CELL, NOTEBOOK_MAX_TEXT_CHARS, NOTEBOOK_MAX_TOTAL_CHARS, parseNotebook } from "./notebook.js";

function notebook(cells: unknown[] = [], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: "python" } }, cells, ...extra });
}

function read(cells: unknown[] = [], extra: Record<string, unknown> = {}) {
  const result = parseNotebook(notebook(cells, extra));
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("saved Jupyter notebook parsing", () => {
  it("reads Markdown, code and raw sources as strings or string fragments without changing them", () => {
    const result = read([
      { cell_type: "markdown", source: ["# Title\n", "\nSome *text*.\n"] },
      { cell_type: "code", execution_count: 0, source: "print('hello')\n", outputs: [] },
      { cell_type: "raw", source: ["---\n", "title: Raw metadata\n", "---\n"] },
    ]);
    expect(result.language).toBe("python");
    expect(result.cellCount).toBe(3);
    expect(result.cells.map(({ kind, source, executionCount }) => ({ kind, source, executionCount }))).toEqual([
      { kind: "markdown", source: "# Title\n\nSome *text*.\n", executionCount: null },
      { kind: "code", source: "print('hello')\n", executionCount: 0 },
      { kind: "raw", source: "---\ntitle: Raw metadata\n---\n", executionCount: null },
    ]);
    expect(result.notices).toEqual([]);
    expect(result.cells.every((cell) => cell.notices.length === 0)).toBe(true);
  });

  it("reads streams, plain MIME fallbacks and errors, removing terminal control sequences", () => {
    const result = read([{ cell_type: "code", source: "1 / 0", execution_count: 8, outputs: [
      { output_type: "stream", name: "stdout", text: ["hello", " world\n"] },
      { output_type: "stream", name: "stderr", text: "\u001b[33mwarning\u001b[0m\n" },
      { output_type: "execute_result", data: { "text/plain": ["42", "\n"] } },
      { output_type: "display_data", data: { "text/plain": "\u001b]8;;https://example.test\u0007saved\u001b]8;;\u0007" } },
      { output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[31mTraceback\u001b[0m", "ZeroDivisionError: division by zero"] },
      { output_type: "error", ename: "ValueError", evalue: "bad value", traceback: [] },
    ] }]);
    expect(result.cells[0]?.outputs).toEqual([
      { kind: "text", label: "stdout", text: "hello world\n" },
      { kind: "text", label: "stderr", text: "warning\n" },
      { kind: "text", label: "Output", text: "42\n" },
      { kind: "text", label: "Output", text: "saved" },
      { kind: "error", label: "Error", text: "Traceback\nZeroDivisionError: division by zero" },
      { kind: "error", label: "Error", text: "ValueError: bad value" },
    ]);
    expect(result.cells[0]?.executionCount).toBe(8);
  });

  it("omits rich data, even alongside plain text, and explains unsupported or empty outputs", () => {
    const result = read([{ cell_type: "code", source: "", outputs: [
      { output_type: "display_data", data: { "text/html": "<script>active()</script>", "text/plain": "Safe fallback" } },
      { output_type: "display_data", data: { "image/png": "base64-image", "application/javascript": "run()" } },
      { output_type: "display_data", data: {} },
      { output_type: "update_display_data", data: { "text/plain": "Unknown protocol output" } },
      null,
    ] }]);
    const outputs = result.cells[0]!.outputs;
    expect(outputs.filter((output) => output.kind !== "notice")).toEqual([{ kind: "text", label: "Output", text: "Safe fallback" }]);
    expect(outputs.filter((output) => output.kind === "notice").map((output) => output.text)).toEqual([
      "Rich output omitted. Only saved text/plain output is shown.",
      "Rich output omitted. Image data is not valid base64.",
      "No saved text/plain output. Switch to source to inspect this output.",
      "Unsupported output type. Switch to source to inspect this output.",
      "Unsupported output type. Switch to source to inspect this output.",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/active\(\)|base64-image|run\(\)|Unknown protocol output/u);
  });

  it("reports malformed fields and unknown cells without coercing objects into text", () => {
    const result = read([
      null,
      { cell_type: "future-cell", source: "Unknown cell's readable source", outputs: [{ output_type: "stream", text: "ignored" }] },
      { cell_type: "code", source: ["before", { arbitrary: "after" }], outputs: {} },
      { cell_type: "code", source: "", execution_count: -1, outputs: [
        { output_type: "stream", text: ["valid fragment", 10] },
        { output_type: "execute_result", data: { "text/plain": { unsafe: "object" } } },
      ] },
    ]);
    expect(result.cells[0]).toMatchObject({ kind: "unknown", source: "" });
    expect(result.cells[0]?.notices).toHaveLength(2);
    expect(result.cells[1]).toMatchObject({ kind: "unknown", source: "Unknown cell's readable source", outputs: [] });
    expect(result.cells[2]?.source).toBe("");
    expect(result.cells[2]?.notices).toHaveLength(2);
    expect(result.cells[3]?.executionCount).toBeNull();
    expect(result.cells[3]?.outputs.every((output) => output.kind === "notice")).toBe(true);
  });

  it.each(["{broken", "", "null", "[]", '{"nbformat":3,"cells":[]}', '{"nbformat":4,"cells":{}}'])("returns an actionable preview error for invalid JSON or notebook structure: %s", (source) => {
    expect(parseNotebook(source)).toMatchObject({ ok: false, error: expect.stringMatching(/Switch to source/u) });
  });

  it("accepts an empty notebook and a BOM and uses bounded language metadata", () => {
    expect(parseNotebook(`\uFEFF${notebook()}`)).toMatchObject({ ok: true, cellCount: 0, cells: [] });
    expect(read([], { metadata: { kernelspec: { language: "JavaScript" } } }).language).toBe("javascript");
    for (const name of ["<script>", "x".repeat(41), { name: "python" }, "__proto__", null]) {
      expect(read([], { metadata: { language_info: { name } } }).language).toBe("text");
    }
  });

  it("rejects truncated reads before attempting JSON, including a valid prefix of a larger file", () => {
    expect(parseNotebook(notebook(), { truncated: true })).toMatchObject({ ok: false, error: expect.stringContaining("partly loaded") });
    expect(parseNotebook("{broken", { truncated: true })).toMatchObject({ ok: false, error: expect.stringContaining("partly loaded") });
  });

  it("bounds the UTF-8 input size as well as the JavaScript string length", () => {
    expect(parseNotebook(" ".repeat(NOTEBOOK_MAX_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringContaining("10 MB") });
    const unicode = notebook([{ cell_type: "raw", source: "é".repeat(NOTEBOOK_MAX_BYTES / 2) }]);
    expect(unicode.length).toBeLessThan(NOTEBOOK_MAX_BYTES);
    expect(parseNotebook(unicode)).toMatchObject({ ok: false, error: expect.stringContaining("10 MB") });
    expect(parseNotebook(notebook().padEnd(NOTEBOOK_MAX_BYTES, " "))).toMatchObject({ ok: true });
  });

  it("limits cells while retaining the actual cell count and a visible reason", () => {
    const result = read(Array.from({ length: NOTEBOOK_MAX_CELLS + 1 }, () => ({ cell_type: "raw", source: "x" })));
    expect(result.cellCount).toBe(NOTEBOOK_MAX_CELLS + 1);
    expect(result.cells).toHaveLength(NOTEBOOK_MAX_CELLS);
    expect(result.notices).toEqual([expect.stringContaining(`first ${NOTEBOOK_MAX_CELLS}`)]);
  });

  it("bounds source and output text while joining fragments and reports each shortened field", () => {
    const result = read([{ cell_type: "code", source: ["s".repeat(NOTEBOOK_MAX_TEXT_CHARS), "not shown"], outputs: [
      { output_type: "stream", text: "t".repeat(NOTEBOOK_MAX_TEXT_CHARS + 1) },
    ] }]);
    expect(result.cells[0]?.source).toBe("s".repeat(NOTEBOOK_MAX_TEXT_CHARS));
    expect(result.cells[0]?.notices).toEqual([expect.stringContaining("Cell source was shortened")]);
    expect(result.cells[0]?.outputs).toEqual([
      { kind: "text", label: "stdout", text: "t".repeat(NOTEBOOK_MAX_TEXT_CHARS) },
      { kind: "notice", label: "Output notice", text: expect.stringContaining("Stream output was shortened") },
    ]);
  });

  it("bounds the combined error name and message and explains malformed error details", () => {
    const result = read([{ cell_type: "code", source: "", outputs: [
      { output_type: "error", ename: "x".repeat(NOTEBOOK_MAX_TEXT_CHARS), evalue: "overflow" },
      { output_type: "error", ename: { unsafe: "object" }, evalue: "Readable message", traceback: "bad traceback" },
    ] }]);
    expect(result.cells[0]?.outputs).toEqual([
      { kind: "error", label: "Error", text: "x".repeat(NOTEBOOK_MAX_TEXT_CHARS) },
      { kind: "notice", label: "Output notice", text: expect.stringContaining("Error message was shortened") },
      { kind: "error", label: "Error", text: "Error: Readable message" },
      { kind: "notice", label: "Output notice", text: expect.stringContaining("Error details are malformed") },
    ]);
  });

  it("caps total preview text and distinguishes a prefix from a complete notebook", () => {
    const count = NOTEBOOK_MAX_TOTAL_CHARS / NOTEBOOK_MAX_TEXT_CHARS;
    const result = read(Array.from({ length: count + 1 }, () => ({ cell_type: "raw", source: "s".repeat(NOTEBOOK_MAX_TEXT_CHARS) })));
    expect(result.cells).toHaveLength(count);
    expect(result.cells.reduce((sum, cell) => sum + cell.source.length, 0)).toBe(NOTEBOOK_MAX_TOTAL_CHARS);
    expect(result.notices).toEqual([expect.stringContaining("Notebook text limit reached")]);
  });

  it("caps outputs per cell and across the notebook, even for outputs with no text", () => {
    const result = read([{ cell_type: "code", source: "", outputs: Array.from({ length: NOTEBOOK_MAX_OUTPUTS_PER_CELL + 1 }, () => ({ output_type: "stream", text: "x" })) }]);
    expect(result.cells[0]?.outputs).toHaveLength(NOTEBOOK_MAX_OUTPUTS_PER_CELL);
    expect(result.cells[0]?.notices).toEqual([expect.stringContaining(`first ${NOTEBOOK_MAX_OUTPUTS_PER_CELL} outputs`)]);
    const total = read(Array.from({ length: NOTEBOOK_MAX_OUTPUTS / NOTEBOOK_MAX_OUTPUTS_PER_CELL + 1 }, () => ({
      cell_type: "code", source: "", outputs: Array.from({ length: NOTEBOOK_MAX_OUTPUTS_PER_CELL }, () => ({})),
    })));
    expect(total.cells.reduce((sum, cell) => sum + cell.outputs.length, 0)).toBe(NOTEBOOK_MAX_OUTPUTS);
    expect(total.cells.at(-1)?.notices).toEqual([expect.stringContaining("Notebook output or text limit reached")]);
  });
});
