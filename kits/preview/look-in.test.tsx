// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, RegionProps, WorkbenchActions } from "tau";
import { EMPTY_PREVIEW_STATE, type PreviewState } from "./protocol.js";
import LookInPreview from "./look-in.js";
import { environmentsCell } from "./machine.js";

afterEach(() => {
  cleanup();
  environmentsCell.set(undefined);
});

const lookIn = { machine: "host-rex", machineName: "rex", sessionId: "t9", connected: true };

function setup(state: Partial<PreviewState> | undefined, props: Partial<RegionProps["lookIn"]> = {}) {
  let current = state;
  const readExtension = vi.fn(async (_machine: string, _extension: string, command: string) => {
    if (command === "state") return current ? { ...EMPTY_PREVIEW_STATE, ...current } : null;
    if (command === "live-frame") return { id: "f1", data: "SlBFRw==", width: 640, height: 400, url: current?.url };
    throw new Error(`unexpected ${command}`);
  });
  environmentsCell.set({ readExtension } as unknown as PlatformEnvironments);
  const view = render(<LookInPreview actions={{} as WorkbenchActions} lookIn={{ ...lookIn, ...props }} />);
  return { readExtension, view, change: (next: Partial<PreviewState> | undefined) => { current = next; } };
}

describe("another machine's Preview in a look-in tab", () => {
  it("shows the page there, small and view only, from commands that only read", async () => {
    const { readExtension } = setup({ url: "http://127.0.0.1:18810/", title: "Page on rex", driver: { threadId: "t9", source: "browser", since: 1 } });
    const image = await screen.findByAltText("rex's Preview: Page on rex");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,SlBFRw==");
    expect(screen.getByText("View only")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    const commands = readExtension.mock.calls.map(([machine, extension, command]) => `${machine} ${extension} ${command}`);
    expect(new Set(commands)).toEqual(new Set(["host-rex tau.preview state", "host-rex tau.preview live-frame"]));
    // Nothing here clicks, types or lays the page out.
    fireEvent.pointerDown(image);
    fireEvent.click(image);
    expect(readExtension.mock.calls.every(([, , command]) => command === "state" || command === "live-frame")).toBe(true);
  });

  it("stays out of the way while the machine shows no page, and hides the picture on request", async () => {
    const { change, readExtension } = setup(undefined);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
    change({ url: "http://127.0.0.1:18810/", title: "Page on rex" });
    render(<LookInPreview actions={{} as WorkbenchActions} lookIn={lookIn} />);
    await screen.findByAltText("rex's Preview: Page on rex");
    const frames = readExtension.mock.calls.filter(([, , command]) => command === "live-frame").length;
    fireEvent.click(screen.getByRole("button", { name: "Hide rex's Preview" }));
    expect(screen.queryByAltText("rex's Preview: Page on rex")).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(readExtension.mock.calls.filter(([, , command]) => command === "live-frame").length).toBe(frames);
  });

  it("says the machine has no display, and asks nothing while it is away", async () => {
    setup({ url: "http://127.0.0.1:18810/", noWindow: { displayService: true } });
    expect(await screen.findByText("rex has no display")).toBeTruthy();
    cleanup();
    const away = setup({ url: "http://127.0.0.1:18810/" }, { connected: false });
    await act(async () => { await Promise.resolve(); });
    expect(away.readExtension).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
