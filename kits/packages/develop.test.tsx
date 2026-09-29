// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PackageBuild } from "tau";
import { DevelopSection, groupBuilds, mergeBuild } from "./develop.js";

afterEach(cleanup);

const desktopFailed: PackageBuild = { id: "me.kit", directory: "/k", half: "desktop", entry: "/k/desktop.tsx", at: 3, ok: false, message: "desktop.tsx:1:8: Expected \";\"\n  const x y = 1;\n          ^" };
const hostBuilt: PackageBuild = { id: "me.kit", directory: "/k", half: "host", entry: "/k/host.ts", at: 2, ok: true };
const other: PackageBuild = { id: "me.other", directory: "/o", half: "desktop", entry: "/o/desktop.tsx", at: 1, ok: true };

describe("the builds of a package in development", () => {
  it("groups the last builds by package, newest package first, desktop half first", () => {
    expect(groupBuilds([other, hostBuilt, desktopFailed]).map((group) => [group.id, group.halves.map((build) => build.half)]))
      .toEqual([["me.kit", ["desktop", "host"]], ["me.other", ["desktop"]]]);
  });

  it("replaces a half's build with its newer one", () => {
    const fixed = { ...desktopFailed, at: 4, ok: true, message: undefined };
    expect(mergeBuild([desktopFailed, hostBuilt], fixed)).toEqual([fixed, hostBuilt]);
  });

  it("shows the whole build error, follows new builds and rebuilds on request", async () => {
    let listener: ((payload: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => command === "builds" ? { builds: [desktopFailed, hostBuilt] } : { message: "Rebuilt." });
    const onNotify = vi.fn();
    render(<DevelopSection host={{ invoke, onEvent: (_name, next) => { listener = next; return () => undefined; } }} nameOf={(id) => id === "me.kit" ? "My kit" : undefined} onNotify={onNotify} />);
    expect(await screen.findByText("Did not build")).toBeTruthy();
    expect(screen.getByLabelText("desktop build error").textContent).toContain("desktop.tsx:1:8: Expected \";\"\n  const x y = 1;");
    act(() => listener?.({ ...desktopFailed, at: 5, ok: true, message: undefined }));
    expect(await screen.findByText("Built")).toBeTruthy();
    expect(screen.queryByLabelText("desktop build error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Rebuild/u }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Rebuilt."));
  });
});
