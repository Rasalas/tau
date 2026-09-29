// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import appearanceExtension from "./desktop.js";
import { APPEARANCE_EXTENSION_ID as ID, APPEARANCE_SETTINGS_PAGE, TERMINAL_FONT_SERVICE, type TerminalFontService, type TerminalFontServiceState } from "./protocol.js";
import { terminalSizeInput } from "./terminal-font.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-text-size");
  setClientStorage(undefined);
  document.documentElement.removeAttribute("style");
});

function activate(invoke: (extensionId: string, command: string, input?: unknown) => Promise<unknown> = vi.fn(async () => undefined)) {
  const harness = createKitHarness(invoke);
  harness.registry.activate(appearanceExtension);
  return { ...harness, invoke };
}

describe("the Appearance Kit applies what the preferences say", () => {
  it("sets the density, the faces and the contrast on the window, and takes them back", () => {
    const { registry, preferences } = activate();
    preferences.setValue(ID, "density", "compact");
    preferences.setValue(ID, "contrast", "40");
    preferences.setValue(ID, "prompt-font-family", "JetBrains Mono; }");
    preferences.setValue(ID, "code-font-size", "15");
    preferences.setValue(ID, "timestamps", "12h");
    const root = document.documentElement;
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.timestamps).toBe("12h");
    expect(root.style.getPropertyValue("--prompt-font-family")).toBe("JetBrains Mono");
    expect(root.style.getPropertyValue("--code-font-scale")).toBe("1.25");
    expect(document.getElementById("tau-appearance")?.textContent).toContain("var(--ink) 14%");

    preferences.setValue(ID, "density", "normal");
    expect(root.dataset.density).toBeUndefined();
    registry.deactivate(ID);
    expect(root.style.getPropertyValue("--code-font-scale")).toBe("");
    expect(document.getElementById("tau-appearance")).toBeNull();
  });

  it("paints a user theme as the dark scheme's theme", async () => {
    const { preferences } = activate();
    const client = createFakeHostClient({ listUserThemes: async () => [{ id: "ember", name: "Ember", css: ":root { color-scheme: dark; --shell: #1a1010; }" }] });
    preferences.bindHost(client);
    await preferences.syncFromHost();
    preferences.setValue(ID, "theme-dark", "ember");
    const css = document.getElementById("tau-appearance")?.textContent ?? "";
    expect(css).toContain(':root[data-theme="dark"] { --shell: #1a1010; }');
    expect(css).not.toContain('data-theme="light"');
  });
});

describe("Settings → Appearance", () => {
  function renderPageWith({ registry, preferences }: Pick<ReturnType<typeof activate>, "registry" | "preferences">) {
    const page = registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    return render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
  }

  function renderPage(invoke?: (extensionId: string, command: string, input?: unknown) => Promise<unknown>) {
    const { registry, preferences } = activate(invoke);
    const page = registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    const editorRegion = registry.getRegions("title-bar").find((entry) => entry.id === "appearance.theme-editor")!;
    const notify = vi.fn();
    const actions = { notify } as unknown as WorkbenchActions;
    render(<TestProviders preferences={preferences}>
      <page.Component onNotify={vi.fn()} />
      <editorRegion.Component actions={actions} />
    </TestProviders>);
    return { page, preferences, notify };
  }

  it("is a page of project-capable rows: modes, a theme per scheme, density, contrast, type", () => {
    const { page } = renderPage();
    expect(page.scope).toBe("both");
    expect(page.keywords).toContain("density");
    for (const title of ["Mode", "Themes", "Density", "Contrast", "Timestamps", "Panel animations", "Interface font", "Prompt font", "Code font"]) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeTruthy();
    }
    expect(within(screen.getByRole("radiogroup", { name: "Density" })).getAllByRole("radio").map((button) => button.textContent)).toEqual(["Compact", "Normal", "Comfortable"]);
  });

  it("chooses the mode from three tiles and gives a theme one scheme from its card", async () => {
    const harness = activate();
    const { preferences } = harness;
    const client = createFakeHostClient({ listUserThemes: async () => [{ id: "ember", name: "Ember", css: ":root { color-scheme: dark; --shell: #1a1010; --acid: #ff7a00; }" }] });
    preferences.bindHost(client);
    await preferences.syncFromHost();
    const page = renderPageWith(harness);

    const tiles = within(screen.getByRole("group", { name: "Mode" })).getAllByRole("button");
    expect(tiles.map((tile) => tile.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(tiles[0]!.getAttribute("aria-pressed")).toBe("true");
    // System shows both schemes side by side.
    expect(tiles[0]!.querySelectorAll(".appearance-wireframe-pane")).toHaveLength(2);
    fireEvent.click(tiles[2]!);
    expect(preferences.getSnapshot().theme).toBe("dark");

    // Tau has both schemes; Ember only the dark one it declares.
    expect(screen.getByRole("button", { name: "Use Tau for the light scheme" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Use Ember for the light scheme" })).toBeNull();
    const ember = screen.getByRole("button", { name: "Use Ember for the dark scheme" });
    expect(ember.querySelector(".appearance-swatch i")?.getAttribute("style")).toContain("rgb(255, 122, 0)");
    fireEvent.click(ember);
    expect(preferences.value(ID, "theme-dark")).toBe("ember");
    expect(preferences.value(ID, "theme-light")).toBeUndefined();
    page.unmount();
  });

  it("sets how long panels take to open, and writes it onto the window", () => {
    const harness = activate();
    const { preferences } = harness;
    const page = renderPageWith(harness);
    const slider = screen.getByRole("slider", { name: "Panel animation duration" });
    expect(screen.getByText("0 ms")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "150" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(preferences.value(ID, "panel-motion")).toBe("150");
    expect(document.documentElement.style.getPropertyValue("--panel-motion")).toBe("150ms");
    preferences.setValue(ID, "panel-motion", "0");
    expect(document.documentElement.style.getPropertyValue("--panel-motion")).toBe("");
    page.unmount();
  });

  it("imports a VS Code theme into the editor, previews it on the window and saves it as the dark theme", async () => {
    const invoke = vi.fn(async (_extension: string, command: string, input?: unknown) => (command === "save-theme" ? { id: (input as { id: string }).id, path: "/themes/night.css" } : undefined));
    const { preferences, notify } = renderPage(invoke);
    const file = new File([JSON.stringify({ name: "Night", type: "dark", colors: { "editor.background": "#101820", "editor.foreground": "#e0e6f0", "focusBorder": "#3fa7ff" } })], "night-color-theme.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("VS Code theme file"), { target: { files: [file] } });

    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    expect((within(editor).getByRole("textbox", { name: "Theme name" }) as HTMLInputElement).value).toBe("Night");
    expect(document.getElementById("tau-appearance-editor")?.textContent).toContain("--shell: #101820;");
    expect((within(editor).getByRole("textbox", { name: "Background" }) as HTMLInputElement).value).toBe("#101820");

    fireEvent.change(within(editor).getByRole("textbox", { name: "Accent" }), { target: { value: "#ff8800" } });
    fireEvent.blur(within(editor).getByRole("textbox", { name: "Accent" }));
    expect(document.getElementById("tau-appearance-editor")?.textContent).toContain("--acid: #ff8800;");
    // An accent change leaves the surfaces the file set alone.
    expect(document.getElementById("tau-appearance-editor")?.textContent).toContain("--shell: #101820;");

    await act(async () => { fireEvent.click(within(editor).getByRole("button", { name: "Save theme" })); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Theme editor" })).toBeNull());
    expect(invoke.mock.calls[0]![0]).toBe(ID);
    const saved = invoke.mock.calls.find(([, command]) => command === "save-theme")![2] as { id: string; appearance: string; tokens: Record<string, string> };
    expect(saved).toMatchObject({ id: "night", appearance: "dark" });
    expect(saved.tokens["--acid"]).toBe("#ff8800");
    expect(preferences.value(ID, "theme-dark")).toBe("night");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Night saved to \/themes\/night.css/u));
    expect(document.getElementById("tau-appearance-editor")).toBeNull();
  });

  it("says why a file is no theme, and keeps the editor closed", async () => {
    const { registry } = activate();
    const page = registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    const onNotify = vi.fn();
    render(<TestProviders><page.Component onNotify={onNotify} /></TestProviders>);
    const file = new File(["{ \"colors\": {} }"], "broken.json");
    fireEvent.change(screen.getByLabelText("VS Code theme file"), { target: { files: [file] } });
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/broken.json: .*editor.background/u)));
  });
});

describe("the text size", () => {
  it("is this device's: the row sets it on the window and in client storage, and a new window reads it back", async () => {
    const storage = createMemoryStorage();
    setClientStorage(storage);
    const { registry, preferences } = activate();
    const page = registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    const control = await screen.findByRole("radiogroup", { name: "Text size" });
    fireEvent.click(within(control).getByRole("radio", { name: "Large" }));
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect(storage.get("tau.appearance.text-size")).toBe("large");
    // The host's settings are not where it lives.
    expect(preferences.value(ID, "text-size")).toBeUndefined();

    registry.deactivate(appearanceExtension.id);
    expect(document.documentElement.dataset.textSize).toBeUndefined();
    activate();
    expect(document.documentElement.dataset.textSize).toBe("large");
    cleanup();

    const again = activate();
    const pageAgain = again.registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    render(<TestProviders preferences={again.preferences}><pageAgain.Component onNotify={vi.fn()} /></TestProviders>);
    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Text size" })).getByRole("radio", { name: "Default" }));
    expect(document.documentElement.dataset.textSize).toBeUndefined();
    expect(storage.get("tau.appearance.text-size")).toBeNull();
  });
});

describe("the terminal's row on Settings → Appearance", () => {
  /** Terminal Kit's font service as a fake: it keeps what it is told. */
  function fakeTerminalFont() {
    let state: TerminalFontServiceState = {
      family: "", size: "",
      resolved: { face: "JetBrains Mono", stack: "\"JetBrains Mono\", monospace", size: 13, familySource: "ghostty", sizeSource: "ghostty" },
      ghostty: { face: "JetBrains Mono", size: 13, files: ["/home/.config/ghostty/config"], problems: ["font-size = x is no number"] },
      sizeRange: { min: 6, max: 32 },
    };
    const listeners = new Set<() => void>();
    const service: TerminalFontService = {
      getSnapshot: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      set: vi.fn((change: { family?: string; size?: string }) => {
        state = { ...state, ...change };
        listeners.forEach((listener) => listener());
      }),
      refresh: vi.fn(async () => undefined),
    };
    const kit: DesktopExtension = { id: "tau.terminal", name: "Terminal", activate: (plugin) => { plugin.provideService(TERMINAL_FONT_SERVICE, service); } };
    return { service, kit };
  }

  it("shows the terminal's font while Terminal Kit is on, and sets it through its service", async () => {
    const { registry, preferences } = activate();
    const { service, kit } = fakeTerminalFont();
    const page = registry.getSettingsPages().find((entry) => entry.id === APPEARANCE_SETTINGS_PAGE)!;
    expect(page.keywords).toContain("terminal");
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    expect(screen.queryByRole("heading", { level: 3, name: "Terminal font" })).toBeNull();

    act(() => registry.activate(kit));
    expect(screen.getByRole("heading", { level: 3, name: "Terminal font" })).toBeTruthy();
    expect(service.refresh).toHaveBeenCalled();
    expect(screen.getByText("JetBrains Mono (from your Ghostty config) at 13px (from your Ghostty config).")).toBeTruthy();
    // The name only; the path, with the user's home in it, is the tooltip.
    expect(screen.queryByText("/home/.config/ghostty/config")).toBeNull();
    expect(screen.getByText("config").getAttribute("title")).toBe("/home/.config/ghostty/config");
    expect(screen.getByText(/is no number/u)).toBeTruthy();
    const family = screen.getByRole("textbox", { name: "Terminal font family" }) as HTMLInputElement;
    expect(family.placeholder).toBe("JetBrains Mono");

    fireEvent.change(family, { target: { value: "Iosevka" } });
    fireEvent.keyDown(family, { key: "Enter" });
    expect(service.set).toHaveBeenLastCalledWith({ family: "Iosevka" });
    const size = screen.getByRole("spinbutton", { name: "Terminal font size" }) as HTMLInputElement;
    fireEvent.change(size, { target: { value: "99" } });
    fireEvent.blur(size);
    // Out of range: the draft stays with the reason under it, nothing is written.
    expect(size.value).toBe("99");
    expect(screen.getByRole("alert").textContent).toMatch(/from \d+ to \d+/u);
    expect(service.set).toHaveBeenCalledTimes(1);
    fireEvent.change(size, { target: { value: "14.5" } });
    fireEvent.blur(size);
    expect(service.set).toHaveBeenLastCalledWith({ size: "14.5" });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(service.set).toHaveBeenLastCalledWith({ family: "", size: "" });

    act(() => registry.deactivate(kit.id));
    expect(screen.queryByRole("heading", { level: 3, name: "Terminal font" })).toBeNull();
  });

  it("takes a size the terminal draws, and nothing else", () => {
    const range = { min: 6, max: 32 };
    expect(terminalSizeInput(" 13 ", range)).toBe("13");
    expect(terminalSizeInput("12.5", range)).toBe("12.5");
    expect(terminalSizeInput("", range)).toBe("");
    expect(terminalSizeInput("12.3", range)).toBeUndefined();
    expect(terminalSizeInput("5", range)).toBeUndefined();
    expect(terminalSizeInput("big", range)).toBeUndefined();
  });
});
