// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppOverlays } from "./use-app-overlays";

describe("useAppOverlays", () => {
  it("manages palette, new thread picker, and overlay states", () => {
    const { result } = renderHook(() => useAppOverlays());

    expect(result.current.paletteOpen).toBe(false);
    act(() => result.current.openPalette());
    expect(result.current.paletteOpen).toBe(true);
    act(() => result.current.closePalette());
    expect(result.current.paletteOpen).toBe(false);

    expect(result.current.newThreadOpen).toBe(false);
    act(() => result.current.openNewThreadPicker());
    expect(result.current.newThreadOpen).toBe(true);
    act(() => result.current.closeNewThreadPicker());
    expect(result.current.newThreadOpen).toBe(false);

    expect(result.current.projectSourcesOpen).toBe(false);
    act(() => result.current.openProjectSources());
    expect(result.current.projectSourcesOpen).toBe(true);
    act(() => result.current.closeProjectSources());
    expect(result.current.projectSourcesOpen).toBe(false);

    expect(result.current.activeOverlayId).toBeUndefined();
    act(() => result.current.openOverlay("custom-overlay"));
    expect(result.current.activeOverlayId).toBe("custom-overlay");
    act(() => result.current.closeOverlay());
    expect(result.current.activeOverlayId).toBeUndefined();

    expect(result.current.settingsPage).toBeUndefined();
    act(() => result.current.setSettingsPage("packages"));
    expect(result.current.settingsPage).toBe("packages");
  });

  it("closes the new-thread picker before opening project sources", () => {
    const { result } = renderHook(() => useAppOverlays());

    act(() => result.current.openNewThreadPicker());
    expect(result.current.newThreadOpen).toBe(true);

    act(() => result.current.openProjectSources());

    expect(result.current.newThreadOpen).toBe(false);
    expect(result.current.projectSourcesOpen).toBe(true);
  });

  it("remembers the level the palette and the source the project sources open on, until the next open", () => {
    const { result } = renderHook(() => useAppOverlays());
    act(() => result.current.openPalette({ menu: "runtime.theme-menu" }));
    expect(result.current.paletteMenu).toBe("runtime.theme-menu");
    act(() => result.current.openPalette());
    expect(result.current.paletteMenu).toBeUndefined();
    act(() => result.current.openProjectSources("workspace.git-clone"));
    expect(result.current.projectSource).toBe("workspace.git-clone");
  });
});
