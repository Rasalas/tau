// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentSourceContribution } from "../extension-system";
import { TestProviders } from "../test-support/test-providers";
import { WorkspaceFileSheet } from "./WorkspaceFileSheet";

afterEach(cleanup);

function fixture(sourceId = "workspace.documents") {
  const renderPreview = vi.fn((path: string, from: { workspace: string }) => <article aria-label="Document preview">{path} in {from.workspace}</article>);
  const loadFile = vi.fn(async () => { throw new Error("A binary document must not use the text loader."); });
  const source: DocumentSourceContribution = {
    id: "workspace.documents", renderPreview, loadFile,
    loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }),
    getState: () => ({ changes: { files: [], added: 0, removed: 0 } }),
    subscribe: () => () => undefined, openInEditor: () => undefined,
  };
  render(<TestProviders><WorkspaceFileSheet
    tab={{ id: "document", kind: "file", path: "guide.docx", preview: true, view: "source", resourceOrigin: { sessionId: "thread", workspace: "workspace-of-this-tab", sourceId } }}
    source={source} onClose={() => undefined}
  /></TestProviders>);
  return { renderPreview, loadFile };
}

it("uses the extension's passive reader on a phone with the tab's explicit workspace", async () => {
  const h = fixture();
  expect(await screen.findByRole("article", { name: "Document preview" })).toHaveProperty("textContent", "guide.docx in workspace-of-this-tab");
  expect(h.renderPreview).toHaveBeenCalledWith("guide.docx", { workspace: "workspace-of-this-tab" });
  expect(h.loadFile).not.toHaveBeenCalled();
});

it("does not hand a tab from another source to a passive reader", async () => {
  const h = fixture("another-source");
  await waitFor(() => expect(screen.getByText(/unavailable on this connection/u)).toBeTruthy());
  expect(h.renderPreview).not.toHaveBeenCalled();
  expect(h.loadFile).not.toHaveBeenCalled();
});
