// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "./preferences";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../workbench/client-storage";
import { followThemePreference, nextTheme } from "./theme";

let storage: ClientStorage;

beforeEach(() => {
  storage = createMemoryStorage();
  setClientStorage(storage);
  document.documentElement.removeAttribute("data-theme");
});

describe("the theme preference", () => {
  it("follows the system until someone says otherwise", () => {
    expect(new PreferencesStore().getSnapshot().theme).toBe("system");
    storage.set(STORAGE_KEYS.preferences, JSON.stringify({ theme: "sepia" }));
    expect(new PreferencesStore().getSnapshot().theme).toBe("system");
  });

  it("survives the window it was set in", () => {
    new PreferencesStore().setTheme("light");
    expect(new PreferencesStore().getSnapshot().theme).toBe("light");
  });

  it("is on <html> before the first render and stays in step with the store", () => {
    const preferences = new PreferencesStore();
    preferences.setTheme("light");
    const stop = followThemePreference(preferences);
    expect(document.documentElement.dataset.theme).toBe("light");

    preferences.setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    stop();
    preferences.setTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("cycles system, dark, light and back", () => {
    expect(nextTheme("system")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
  });

  it("registers user themes and injects dynamic stylesheet when selected", async () => {
    const { registerUserTheme, applyTheme, clearUserThemes, isThemePreference } = await import("./theme");
    clearUserThemes();

    registerUserTheme({
      id: "monokai",
      name: "Monokai Pro",
      css: ":root { --acid: #a6e22e; }",
    });

    expect(isThemePreference("monokai")).toBe(true);

    const preferences = new PreferencesStore();
    preferences.setTheme("monokai");
    expect(preferences.getSnapshot().theme).toBe("monokai");

    applyTheme("monokai");
    expect(document.documentElement.dataset.theme).toBe("monokai");

    const styleEl = document.getElementById("user-theme") as HTMLStyleElement | null;
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toBe(":root { --acid: #a6e22e; }");

    // Switching back to built-in theme removes the dynamic style element
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.getElementById("user-theme")).toBeNull();

    clearUserThemes();
  });

  it("cycles through user themes when available", async () => {
    const { registerUserThemes, clearUserThemes } = await import("./theme");
    registerUserThemes([
      { id: "dracula", name: "Dracula", css: "" },
      { id: "nord", name: "Nord", css: "" },
    ]);

    expect(nextTheme("light")).toBe("dracula");
    expect(nextTheme("dracula")).toBe("nord");
    expect(nextTheme("nord")).toBe("system");

    clearUserThemes();
  });
});
