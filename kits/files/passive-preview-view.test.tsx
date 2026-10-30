// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassivePreviewView } from "./passive-preview-view.js";
import type { FilesHost } from "./protocol.js";
import type { PassiveContent } from "./passive-preview.js";

afterEach(cleanup);
function host(content: PassiveContent) { return { preview: vi.fn(async () => ({ ok: true, content, notices: [] })) } as unknown as FilesHost; }
describe("passive stage previews", () => {
  it("keeps document text, app directives and authored HTML inert", async () => {
    const body = '<script>execute()</script> [link](https://example.test) \uE200visualize\uE202{"path":"private.html"}\uE201';
    const { container } = render(<PassivePreviewView host={host({ kind: "document", blocks: [{ kind: "paragraph", text: body }] })} workspace="ws" path="a.docx" />);
    expect(await screen.findByText(body)).toBeTruthy(); expect(container.querySelector("a,img,script,iframe,object,embed")).toBeNull();
  });
  it("switches sheets while keeping formulas in titles and cached values in cells", async () => {
    render(<PassivePreviewView host={host({ kind: "sheet", sheets: [{ name: "One", rowCount: 1, rows: [[{ value: "42", formula: 'WEBSERVICE("https://example.test")' }]] }, { name: "Two", rowCount: 1, rows: [[{ value: "second" }]] }] })} workspace="ws" path="a.xlsx" />);
    expect(await screen.findByText("42")).toBeTruthy(); expect(screen.getByText("42").title).toContain("WEBSERVICE");
    fireEvent.click(screen.getByRole("button", { name: "Two" })); expect(await screen.findByText("second")).toBeTruthy(); expect(screen.queryByText("42")).toBeNull();
  });
  it("shows speaker notes collapsed and EPUB chapters one at a time", async () => {
    const view = render(<PassivePreviewView host={host({ kind: "slides", slides: [{ title: "Slide", blocks: [{ kind: "paragraph", text: "Saved slide" }], notes: [{ kind: "paragraph", text: "Saved notes" }] }] })} workspace="ws" path="a.pptx" />);
    expect(await screen.findByText("Saved slide")).toBeTruthy(); expect(screen.getByText("Notes").closest("details")?.open).toBe(false);
    view.unmount();
    render(<PassivePreviewView host={host({ kind: "book", title: "Book", author: "Writer", chapters: [{ title: "One", blocks: [{ kind: "paragraph", text: "first body" }] }, { title: "Two", blocks: [{ kind: "paragraph", text: "second body" }] }] })} workspace="ws" path="a.epub" />);
    expect(await screen.findByText("first body")).toBeTruthy(); expect(screen.queryByText("second body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" })); expect(await screen.findByText("second body")).toBeTruthy(); expect(screen.queryByText("first body")).toBeNull();
  });
  it("collapses archive folders and only displays links and traversal names", async () => {
    const { container } = render(<PassivePreviewView host={host({ kind: "archive", unpackedBytes: 20, entries: [{ name: "folder/file", size: 10, encrypted: true, directory: false }, { name: "../escape", size: 10, directory: false, encrypted: false, link: "/etc/passwd" }] })} workspace="ws" path="a.zip" />);
    expect(await screen.findByText("folder/file")).toBeTruthy(); expect(screen.getByLabelText("Encrypted")).toBeTruthy(); expect(screen.getByText(/\.\.\/escape/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "folder/" })); expect(screen.queryByText("folder/file")).toBeNull(); expect(container.querySelector("a")).toBeNull();
  });
  it("requests only a selected database table and exposes schema without SQL input", async () => {
    const api = host({ kind: "database", tables: [{ name: "one", type: "table", schema: "CREATE TABLE one(value)" }, { name: "two", type: "table", schema: "CREATE TABLE two(value)" }], selected: "one", columns: ["value"], rows: [["saved"]] });
    const { container } = render(<PassivePreviewView host={api} workspace="ws-b" path="a.db" />);
    expect(await screen.findByText("saved")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Schema" })); expect(screen.getByText("CREATE TABLE one(value)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "two · table" }));
    expect(api.preview).toHaveBeenLastCalledWith("ws-b", "a.db", "two"); expect(container.querySelector("input,textarea")).toBeNull();
  });
  it("ignores a stale result when the stage switches files", async () => {
    let finish!: (value: unknown) => void;
    const api = { preview: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: false, reason: "size", error: "This file is larger than 20 MB. Open it in another app." }) } as unknown as FilesHost;
    const view = render(<PassivePreviewView host={api} workspace="ws" path="old.docx" />);
    view.rerender(<PassivePreviewView host={api} workspace="ws" path="new.docx" />);
    expect(await screen.findByText(/larger than 20 MB/u)).toBeTruthy(); finish({ ok: true, content: { kind: "document", blocks: [{ kind: "paragraph", text: "stale" }] }, notices: [] });
    expect(screen.queryByText("stale")).toBeNull();
  });
});

it("falls back to ordinary text for a .db without a SQLite header", async () => {
  const api = { preview: vi.fn(async () => ({ ok: false, reason: "unsupported", error: "Not SQLite" })), read: vi.fn(async () => ({ kind: "text", text: "saved NeDB text" })) } as unknown as FilesHost;
  render(<PassivePreviewView host={api} workspace="db-project" path="notes.db" />);
  expect(await screen.findByText("saved NeDB text")).toBeTruthy();
  expect(api.read).toHaveBeenCalledWith("db-project", "notes.db");
});
