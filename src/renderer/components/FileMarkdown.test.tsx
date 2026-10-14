// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiFileContent } from "../../shared/workspace-kit-types";
import type { StageFileTab, WorkspaceResourceOrigin } from "../../workbench/stage";
import { createMemoryStorage, getClientStorage, setClientStorage } from "../../workbench/client-storage";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { WorkbenchContext, type WorkbenchContextValue } from "../workbench-context";
import { FileViewer } from "./FileViewer";
import { resolveBeside } from "./FileMarkdown";

const STORAGE_KEY = "tau:markdown-rendered";
const PATH = ".scratch/foo/README.md";
const DOC = [
  "# Title",
  "",
  "[Issue](issues/01-x.md) [Notes](../notes.md#top) [Here](#section) [Web](https://example.com/a)",
  "",
  "![shot](img/a.png) ![shared](../shared/b.png)",
  "",
  "## Section",
  "",
  "body",
].join("\n");

const textFile = (text: string, extra: Partial<UiFileContent> = {}): UiFileContent => ({ path: `/repo/${PATH}`, name: "README.md", size: text.length, kind: "text", text, language: "markdown", ...extra });
const imageFile = (): UiFileContent => ({ path: "/repo/a.png", name: "a.png", size: 4, kind: "image", dataUrl: "data:image/png;base64,AAAA" });

const scrolled: Element[] = [];
const openFile = vi.fn();
const openWorkspaceFile = vi.fn();

beforeEach(() => {
  setClientStorage(createMemoryStorage());
  scrolled.length = 0;
  openFile.mockReset();
  openWorkspaceFile.mockReset();
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
});
afterEach(() => { cleanup(); setClientStorage(undefined); });

function viewer(options: {
  path?: string;
  text?: string;
  tab?: Partial<StageFileTab>;
  changed?: boolean;
  content?: UiFileContent;
  loadFile?: (path: string) => Promise<UiFileContent>;
} = {}) {
  const path = options.path ?? PATH;
  const loadFile = options.loadFile ?? vi.fn(async (requested: string) => requested === path ? options.content ?? textFile(options.text ?? DOC) : imageFile());
  const workbench = { openFile, openWorkspaceFile } as unknown as WorkbenchContextValue;
  const tab: StageFileTab = { id: `file:/repo/${path}`, kind: "file", path: `/repo/${path}`, view: "source", preview: false, ...options.tab };
  const element = (key: string) => <HostClientProvider key={key} client={createFakeHostClient()}>
    <WorkbenchContext.Provider value={workbench}>
      <FileViewer
        tab={tab}
        relativePath={tab.resourceOrigin !== undefined ? tab.path : path}
        changed={options.changed ?? false}
        loadFile={loadFile}
        loadDiff={() => new Promise(() => undefined)}
        onChangeView={() => undefined}
        onOpenInEditor={() => undefined}
      />
    </WorkbenchContext.Provider>
  </HostClientProvider>;
  return { loadFile, ...render(element("a")) };
}

describe("a Markdown file in a file tab", () => {
  it("opens rendered, in the column the chat reads in", async () => {
    const { container } = viewer();
    await screen.findByRole("heading", { name: "Title" });
    expect(container.querySelector(".stage-markdown-scroll > .markdown")).not.toBeNull();
    expect(container.querySelector(".source-code")).toBeNull();
    expect(screen.getByRole("button", { name: "Show markdown source" })).toBeTruthy();
  });

  it("switches to the source and keeps the choice for the next file and the next start", async () => {
    const first = viewer();
    await screen.findByRole("heading", { name: "Title" });
    fireEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
    expect(first.container.querySelector(".source-code")?.textContent).toContain("# Title");
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
    expect(getClientStorage()?.get(STORAGE_KEY)).toBe("off");
    first.unmount();

    // Another Markdown file, read from the same storage a restart would read.
    const second = viewer({ path: "docs/other.md", text: "# Other" });
    await waitFor(() => expect(second.container.querySelector(".source-code")?.textContent).toContain("# Other"));
    expect(screen.queryByRole("heading", { name: "Other" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    await screen.findByRole("heading", { name: "Other" });
    expect(getClientStorage()?.get(STORAGE_KEY)).toBe("on");
  });

  it("lets two open tabs follow the same choice", async () => {
    const one = viewer();
    const two = render(<HostClientProvider client={createFakeHostClient()}>
      <FileViewer
        tab={{ id: "file:/repo/docs/two.md", kind: "file", path: "/repo/docs/two.md", view: "source", preview: false }}
        relativePath="docs/two.md"
        changed={false}
        loadFile={async () => textFile("# Two")}
        loadDiff={() => new Promise(() => undefined)}
        onChangeView={() => undefined}
        onOpenInEditor={() => undefined}
      />
    </HostClientProvider>);
    await screen.findByRole("heading", { name: "Two" });
    await screen.findByRole("heading", { name: "Title" });
    fireEvent.click(buttonIn(two.container, "Show markdown source"));
    await waitFor(() => expect(one.container.querySelector(".source-code")).not.toBeNull());
    expect(two.container.querySelector(".source-code")).not.toBeNull();
  });

  it("offers no switch for other text, for .mdx, or in the diff", async () => {
    const code = viewer({ path: "src/a.ts", text: "export const a = 1;" });
    await waitFor(() => expect(code.container.querySelector(".source-code")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /markdown/iu })).toBeNull();
    code.unmount();

    const mdx = viewer({ path: "docs/page.mdx", text: "# Page" });
    await waitFor(() => expect(mdx.container.querySelector(".source-code")?.textContent).toContain("# Page"));
    expect(screen.queryByRole("button", { name: /markdown/iu })).toBeNull();
    mdx.unmount();

    viewer({ changed: true, tab: { view: "diff" } });
    expect(screen.queryByRole("button", { name: /markdown/iu })).toBeNull();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
  });

  it("shows the source at the requested line until the switch is used", async () => {
    const { container } = viewer({ text: "a\nb\n# c\nd", tab: { line: 3, reveal: 1 } });
    await waitFor(() => expect(container.querySelector(".source-line-mark")?.getAttribute("data-line")).toBe("3"));
    expect(screen.queryByRole("heading", { name: "c" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    await screen.findByRole("heading", { name: "c" });
    expect(container.querySelector(".source-line-mark")).toBeNull();
    expect(getClientStorage()?.get(STORAGE_KEY)).toBe("on");
  });

  it("does not open the source for a file that was opened without a line", async () => {
    viewer({ tab: { reveal: 1 } });
    await screen.findByRole("heading", { name: "Title" });
  });

  it("says when only the start of a large file is shown", async () => {
    viewer({ content: textFile("# Big", { truncated: true, size: 5_000_000 }) });
    await screen.findByRole("heading", { name: "Big" });
    expect(screen.getByRole("status").textContent).toMatch(/Showing the first .* of 4\.8 MB/u);
  });
});

function buttonIn(container: HTMLElement, name: string): HTMLElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name);
  if (!button) throw new Error(`No button ${name}`);
  return button;
}

describe("links and images in a rendered file", () => {
  it("opens a relative link from the folder of the file", async () => {
    viewer();
    fireEvent.click(await screen.findByRole("link", { name: "Issue" }));
    expect(openFile).toHaveBeenCalledWith(".scratch/foo/issues/01-x.md");
    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    // The heading after # is not followed into another file.
    expect(openFile).toHaveBeenLastCalledWith(".scratch/notes.md");
  });

  it("opens a link of a file from another thread's workspace in that workspace", async () => {
    const origin: WorkspaceResourceOrigin = { sessionId: "s", workspace: "w", sourceId: "src" };
    viewer({ tab: { resourceOrigin: origin, path: PATH }, loadFile: async () => textFile(DOC) });
    fireEvent.click(await screen.findByRole("link", { name: "Issue" }));
    expect(openWorkspaceFile).toHaveBeenCalledWith(".scratch/foo/issues/01-x.md", origin);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("jumps to a heading of the document and leaves the web to the browser", async () => {
    viewer();
    fireEvent.click(await screen.findByRole("link", { name: "Here" }));
    expect(scrolled.map((element) => element.id)).toEqual(["user-content-section"]);
    expect(openFile).not.toHaveBeenCalled();
    const web = screen.getByRole("link", { name: "Web" });
    expect(web.getAttribute("target")).toBe("_blank");
  });

  it("reads an image beside the file, also one above its folder", async () => {
    const { loadFile } = viewer();
    await screen.findByAltText("shot");
    await screen.findByAltText("shared");
    expect(loadFile).toHaveBeenCalledWith(".scratch/foo/img/a.png");
    expect(loadFile).toHaveBeenCalledWith(".scratch/shared/b.png");
  });
});

describe("resolveBeside", () => {
  it.each([
    ["docs", "a.md", "docs/a.md"],
    ["docs", "./a.md", "docs/a.md"],
    ["docs/guide", "../a.md", "docs/a.md"],
    ["docs/guide", "x/../y/./z.md", "docs/guide/y/z.md"],
    ["", "a.md", "a.md"],
    ["", "../a.md", "../a.md"],
    ["docs", "../../a.md", "../a.md"],
    ["/repo/docs", "../a.md", "/repo/a.md"],
    ["/repo", "../../a.md", "/a.md"],
    ["/", "a.md", "/a.md"],
    ["C:/repo/docs", "../../../a.md", "C:/a.md"],
  ])("%j + %j = %j", (directory, link, expected) => {
    expect(resolveBeside(directory, link)).toBe(expected);
  });
});
