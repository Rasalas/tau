// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppPageStore } from "../workbench/app-page-store";
import { usePhoneNavigation } from "./use-phone-navigation";

function setup() {
  const pages = new AppPageStore();
  return renderHook(() => {
    const [settingsPage, setSettingsPage] = useState<string>();
    const navigation = usePhoneNavigation({ phone: true, pages, settingsPage, setSettingsPage, sessionId: undefined, drafting: false });
    return { navigation, setSettingsPage };
  });
}

describe("phone settings navigation", () => {
  it("shows a section opened by a workbench action directly, including after closing Settings", () => {
    const { result } = setup();
    act(() => result.current.setSettingsPage("about"));
    expect(result.current.navigation.settingsView).toBe("page");
    expect(result.current.navigation.route).toEqual({ kind: "settings", section: "about" });

    act(() => result.current.navigation.setSettingsView("sections"));
    act(() => result.current.setSettingsPage(undefined));
    act(() => result.current.setSettingsPage("about"));
    expect(result.current.navigation.settingsView).toBe("page");
  });

  it("keeps the bottom Settings tab at the section list and opens an external target from there", () => {
    const { result } = setup();
    act(() => result.current.navigation.openTab({ kind: "settings" }));
    expect(result.current.navigation.settingsView).toBe("sections");
    expect(result.current.navigation.route).toEqual({ kind: "settings" });

    act(() => result.current.setSettingsPage("about"));
    expect(result.current.navigation.route).toEqual({ kind: "settings", section: "about" });
    act(() => result.current.setSettingsPage("general"));
    expect(result.current.navigation.route).toEqual({ kind: "settings", section: "general" });
    act(() => result.current.navigation.openTab({ kind: "settings" }));
    expect(result.current.navigation.settingsView).toBe("sections");
  });
});
