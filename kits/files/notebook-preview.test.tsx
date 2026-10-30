// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookPreview } from "./notebook-preview.js";
import { NOTEBOOK_MAX_TEXT_CHARS } from "./notebook.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function notebook(cells: unknown[], language = "python") {
  return JSON.stringify({ nbformat: 4, metadata: { language_info: { name: language } }, cells });
}

describe("inert saved notebook preview", () => {
  it("renders Markdown, saved code, streams, plain MIME fallbacks, tracebacks and raw cells", async () => {
    render(<NotebookPreview text={notebook([
      { cell_type: "markdown", source: ["# Analysis\n", "\nSome *emphasis*.\n"] },
      { cell_type: "code", source: "print('saved')\n", execution_count: 12, outputs: [
        { output_type: "stream", name: "stdout", text: "saved\n" },
        { output_type: "execute_result", data: { "text/plain": "42" } },
        { output_type: "error", traceback: ["\u001b[31mTraceback\u001b[0m", "ValueError: failed"] },
      ] },
      { cell_type: "raw", source: "Raw cell content" },
    ])} />);
    expect(await screen.findByRole("heading", { name: "Analysis" })).toBeTruthy();
    expect(screen.getByText("emphasis").tagName).toBe("EM");
    await waitFor(() => expect(screen.getByLabelText("Cell 2 source").textContent).toContain("print('saved')"));
    expect(screen.getByText("In [12]")).toBeTruthy();
    expect(screen.getByLabelText("Cell 2 stdout").textContent).toBe("saved\n");
    expect(screen.getByLabelText("Cell 2 Output").textContent).toBe("42");
    expect(screen.getByLabelText("Cell 2 Error").textContent).toBe("Traceback\nValueError: failed");
    expect(await within(screen.getByLabelText("Cell 3 source")).findByText("Raw cell content")).toBeTruthy();
    expect(screen.getByText(/Code is never executed/u)).toBeTruthy();
  });

  it("keeps authored links, image references, inline paths, raw HTML and rich outputs inactive", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { container } = render(<NotebookPreview text={notebook([
      { cell_type: "markdown", source: [
        "# Untrusted notebook\n\n",
        "[External](https://example.test/track) [Prompt](tau://new?prompt=execute) [Local](./secret.txt)\n\n",
        "![Remote image](https://example.test/remote.png) ![Attached][attachment]\n\n[attachment]: attachment:plot.png\n\n",
        "`src/secret.ts`\n\n<iframe src=\"https://example.test/frame\"></iframe>\n\n<script>globalThis.executed = true</script>\n\n",
        "```mermaid\ngraph LR; A-->B\n```\n",
      ] },
      { cell_type: "code", source: "", outputs: [
        { output_type: "display_data", data: { "text/html": '<img src="https://example.test/output.png" onerror="execute()">', "text/plain": "Inert fallback" } },
        { output_type: "display_data", data: { "application/javascript": "execute()", "image/svg+xml": '<svg onload="execute()" />' } },
        { output_type: "stream", text: '<img src="https://example.test/stream.png">' },
      ] },
    ])} />);
    expect(await screen.findByRole("heading", { name: "Untrusted notebook" })).toBeTruthy();
    expect(screen.getByText("External").tagName).toBe("SPAN");
    expect(screen.getByText("src/secret.ts").tagName).toBe("CODE");
    expect(screen.getByText("[Image omitted: Remote image]")).toBeTruthy();
    expect(screen.getByText("[Image omitted: Attached]")).toBeTruthy();
    expect(screen.getByLabelText("Cell 2 Output").textContent).toBe("Inert fallback");
    expect(screen.getAllByText(/Rich output omitted/u)).toHaveLength(2);
    expect(container.querySelector("a, button, img, iframe, script, svg, video, audio, object, embed, [src], [srcdoc]")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows app visualization directives as plain source without mounting their frame or actions", async () => {
    const marker = '\uE200visualize\uE202{"path":"secret.html"}\uE201';
    const { container } = render(<NotebookPreview text={notebook([{ cell_type: "markdown", source: marker }])} />);
    expect(await within(screen.getByLabelText("Cell 1 source")).findByText(marker)).toBeTruthy();
    expect(screen.getByText(/app directives is shown as plain text/u)).toBeTruthy();
    expect(container.querySelector("iframe, dialog, button")).toBeNull();
  });

  it("mounts twenty cells at a time and reveals the rest on request", async () => {
    render(<NotebookPreview text={notebook(Array.from({ length: 21 }, (_, index) => ({ cell_type: "markdown", source: `# Cell title ${index + 1}` })))} />);
    expect(await screen.findByRole("heading", { name: "Cell title 20" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Cell title 21" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more cells (1 remaining)" }));
    expect(await screen.findByRole("heading", { name: "Cell title 21" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show more cells/u })).toBeNull();
  });

  it("shows empty notebooks, malformed JSON and truncated reads explicitly and updates changed content", async () => {
    const { rerender } = render(<NotebookPreview text={notebook([])} />);
    expect(await screen.findByText("This notebook is empty.")).toBeTruthy();
    rerender(<NotebookPreview text="{broken" />);
    expect((await screen.findByRole("alert")).textContent).toContain("not valid JSON");
    rerender(<NotebookPreview text={notebook([])} truncated />);
    expect((await screen.findByRole("alert")).textContent).toContain("only partly loaded");
    rerender(<NotebookPreview text={notebook([{ cell_type: "markdown", source: "# Repaired notebook" }])} />);
    expect(await screen.findByRole("heading", { name: "Repaired notebook" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("displays limit and unsupported-output notices beside the retained content", async () => {
    render(<NotebookPreview text={notebook([{ cell_type: "code", source: "x".repeat(NOTEBOOK_MAX_TEXT_CHARS + 1), outputs: [{ output_type: "widget" }] }], "constructor")} />);
    expect(await screen.findByText(/Cell source was shortened/u)).toBeTruthy();
    expect(screen.getByText(/Unsupported output type/u)).toBeTruthy();
    const source = screen.getByLabelText("Cell 1 source");
    expect(await within(source).findByText("x".repeat(NOTEBOOK_MAX_TEXT_CHARS))).toBeTruthy();
  });
});
