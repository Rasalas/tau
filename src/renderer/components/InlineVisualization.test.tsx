// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceResources } from "../workspace-resource-context";
import { InlineVisualization, visualizationTheme } from "./InlineVisualization";

const fixture = vi.hoisted(() => ({ resources: undefined as WorkspaceResources | undefined }));
vi.mock("../workspace-resource-context", async (load) => ({ ...await load<typeof import("../workspace-resource-context")>(), useWorkspaceResources: () => fixture.resources }));
beforeAll(() => {
  HTMLDialogElement.prototype.show = function () { this.open = true; };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); fixture.resources = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme; document.documentElement.style.colorScheme = ""; });
function resources(loadVisualization: NonNullable<WorkspaceResources["loadVisualization"]>): WorkspaceResources {
  return { available: true, displayPath: "/home/work", loadFile: vi.fn(), openFile: vi.fn(), loadVisualization };
}

describe("inline visualization surface", () => {
  it("follows system appearance and subsequent device appearance changes", async () => {
    let dark = true;
    let notify: (() => void) | undefined;
    const remove = vi.fn();
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; }, addEventListener: (_name: string, callback: () => void) => { notify = callback; }, removeEventListener: remove }));
    document.documentElement.dataset.theme = "system";
    const load = vi.fn(async () => ({ url: "tau-ext://resources/test" }));
    fixture.resources = resources(load);
    const view = render(<InlineVisualization reference={{ path: "visuals/a.html" }} />);
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("visuals/a.html", "dark"));
    act(() => { dark = false; notify?.(); });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("visuals/a.html", "light"));
    view.unmount();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });
  it("lets explicit and custom theme schemes override system appearance", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.documentElement.dataset.theme = "light";
    expect(visualizationTheme()).toBe("light");
    document.documentElement.dataset.theme = "dark";
    expect(visualizationTheme()).toBe("dark");
    document.documentElement.dataset.theme = "custom";
    document.documentElement.style.colorScheme = "light";
    expect(visualizationTheme()).toBe("light");
    document.documentElement.style.colorScheme = "dark";
    expect(visualizationTheme()).toBe("dark");
  });
  it("loads on the captured workspace, uses an opaque iframe, and releases the capability", async () => {
    const release = vi.fn();
    const load = vi.fn(async () => ({ url: "tau-ext://resources/test", release }));
    fixture.resources = resources(load);
    const view = render(<InlineVisualization reference={{ path: "/home/work/visuals/mock.html" }} />);
    await waitFor(() => expect(screen.getByTitle("Visualization")).toBeTruthy());
    expect(load).toHaveBeenCalledWith("visuals/mock.html", "light");
    expect(screen.getByTitle("Visualization").getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByTitle("Visualization").getAttribute("srcdoc")).toBeNull();
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not request a device absolute path outside the workspace", () => {
    const load = vi.fn();
    fixture.resources = resources(load);
    render(<InlineVisualization reference={{ path: "/etc/secret.html" }} />);
    expect(screen.getByRole("status").textContent).toContain("inside the thread's workspace");
    expect(load).not.toHaveBeenCalled();
  });
  it("draws an actionable fallback for missing source files", async () => {
    fixture.resources = resources(async () => { throw new Error("Visualization file not found on this thread's machine."); });
    render(<InlineVisualization reference={{ path: "visuals/missing.html" }} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("not found"));
    fireEvent.click(screen.getByRole("button", { name: "Open visualization source" }));
    expect(fixture.resources.openFile).toHaveBeenCalledWith("visuals/missing.html");
  });
  it("releases an asynchronous response after the originating surface unmounts", async () => {
    const release = vi.fn();
    let finish!: (value: { url: string; release: () => void }) => void;
    fixture.resources = resources(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<InlineVisualization reference={{ path: "visuals/a.html" }} />);
    view.unmount();
    await act(async () => { finish({ url: "tau-ext://resources/late", release }); });
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not trust unrelated window resize messages", async () => {
    fixture.resources = resources(async () => ({ url: "tau-ext://resources/test" }));
    render(<InlineVisualization reference={{ path: "visuals/a.html" }} />);
    await waitFor(() => expect(screen.getByTitle("Visualization")).toBeTruthy());
    const iframe = screen.getByTitle("Visualization") as HTMLIFrameElement;
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "tau-visualization-height", height: 900 }, source: window })));
    expect(iframe.style.height).toBe("600px");
    act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "tau-visualization-height", height: 999999 }, source: iframe.contentWindow })));
    expect(iframe.style.height).toBe("2000px");
  });
  it("keeps the same interactive document across expansion and collapse", async () => {
    fixture.resources = resources(async () => ({ url: "tau-ext://resources/test" }));
    render(<InlineVisualization reference={{ path: "visuals/a.html", mode: "wide" }} />);
    await waitFor(() => expect(screen.getByTitle("Visualization")).toBeTruthy());
    const frame = screen.getByTitle("Visualization") as HTMLIFrameElement;
    frame.dataset.qaInstance = "persistent";
    const originalDocument = frame.contentDocument;
    fireEvent.click(screen.getByRole("button", { name: "Expand visualization" }));
    await waitFor(() => expect(screen.getByRole("dialog").hasAttribute("data-preview-overlay")).toBe(true));
    expect(screen.getByTitle("Visualization")).toBe(frame);
    expect(frame.dataset.qaInstance).toBe("persistent");
    expect(frame.contentDocument).toBe(originalDocument);
    fireEvent.click(screen.getByRole("button", { name: "Collapse visualization" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTitle("Visualization")).toBe(frame);
    expect(frame.dataset.qaInstance).toBe("persistent");
    expect(frame.contentDocument).toBe(originalDocument);
  });
});
