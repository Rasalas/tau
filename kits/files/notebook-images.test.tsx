// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTEBOOK_MAX_IMAGE_BYTES, NOTEBOOK_MAX_IMAGES, parseNotebook } from "./notebook.js";
import { NotebookPreview } from "./notebook-preview.js";

vi.mock("tau", async (original) => ({ ...await original<typeof import("tau")>(), AttachmentLightbox: ({ onClose }: { onClose(): void }) => <div role="dialog" aria-label="Image preview"><button onClick={onClose}>Close preview</button></div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
function notebook(data: Record<string, unknown>[]) { return JSON.stringify({ nbformat: 4, cells: [{ cell_type: "code", source: "", outputs: data.map((value) => ({ output_type: "display_data", data: value })) }] }); }
function parse(data: Record<string, unknown>[]) { const result = parseNotebook(notebook(data)); if (!result.ok) throw new Error(result.error); return result; }

describe("saved passive notebook image output", () => {
  it("retains supported MIME images and plain fallbacks, while discarding executable output", () => {
    const result = parse([{ "image/png": PNG, "text/plain": "Saved chart", "text/html": "<script>execute()</script>" }, { "image/svg+xml": SVG }, { "application/javascript": "run()" }]);
    expect(result.cells[0]?.outputs.filter((output) => output.kind === "image")).toEqual([{ kind: "image", mime: "image/png", label: "Output image", text: PNG }, { kind: "image", mime: "image/svg+xml", label: "Output image", text: SVG }]);
    expect(result.cells[0]?.outputs).toContainEqual({ kind: "text", label: "Output", text: "Saved chart" }); expect(JSON.stringify(result)).not.toMatch(/execute\(\)|run\(\)/u);
  });
  it.each(['<svg onload="execute()"/>', '<svg><image href="https://example.test/a.png"/></svg>', '<svg><s:script>execute()</s:script></svg>', '<svg><style>rect{fill:url(https://example.test)}</style></svg>', '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///etc/passwd">]><svg/>'])("omits SVG containing resource or executable markup", (svg) => {
    expect(parse([{ "image/svg+xml": svg }]).cells[0]?.outputs.every((output) => output.kind === "notice")).toBe(true);
  });
  it("bounds decoded bytes, image count and image signatures", () => {
    const oversized = Buffer.alloc(NOTEBOOK_MAX_IMAGE_BYTES + 1).toString("base64");
    expect(parse([{ "image/png": oversized }]).cells[0]?.outputs).toContainEqual({ kind: "notice", label: "Output notice", text: "Image output omitted: larger than 5 MB." });
    const result = parse(Array.from({ length: NOTEBOOK_MAX_IMAGES + 1 }, () => ({ "image/png": PNG })));
    expect(result.cells[0]?.outputs.filter((output) => output.kind === "image")).toHaveLength(30);
    expect(result.cells[0]?.outputs).toContainEqual({ kind: "notice", label: "Output notice", text: expect.stringContaining("30 images") });
    expect(parse([{ "image/png": btoa("<script>not PNG</script>") }]).cells[0]?.outputs.every((output) => output.kind === "notice")).toBe(true);
  });
  it("uses local Blob URLs, opens the existing lightbox and releases bytes when unmounted", async () => {
    const create = vi.fn<(blob: Blob) => string>(() => "blob:local-output"); const revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = render(<NotebookPreview text={notebook([{ "image/png": PNG }])} />);
    expect((await screen.findByAltText("Output image 1 of cell 1")).getAttribute("src")).toBe("blob:local-output");
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    fireEvent.click(screen.getByRole("button", { name: "Open Output image 1 of cell 1" }));
    expect(await screen.findByRole("dialog", { name: "Image preview" })).toBeTruthy(); fireEvent.click(screen.getByText("Close preview"));
    view.unmount(); await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:local-output")); expect(fetch).not.toHaveBeenCalled();
  });
});

it("supports inert matplotlib SVG declarations, styles and fragment references", () => {
  const svg = '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><metadata><rdf:RDF>metadata</rdf:RDF></metadata><defs><style type="text/css">*{stroke-linejoin: round}</style><path id="line" d="M 0 0 L 1 1"/></defs><use xlink:href="#line" style="clip-path:url(#clip)"/></svg>';
  const result = parse([{ "image/svg+xml": svg }]);
  expect(result.cells[0]?.outputs[0]).toMatchObject({ kind: "image", mime: "image/svg+xml" });
  expect(result.cells[0]?.outputs[0]?.text).not.toContain("DOCTYPE");
});
