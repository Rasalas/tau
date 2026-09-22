// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import appearanceExtension from "./desktop.js";
import { APPEARANCE_EXTENSION_ID as ID, APPEARANCE_SETTINGS_PAGE } from "./protocol.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
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
    for (const title of ["Mode", "Light theme", "Dark theme", "Theme editor", "Density", "Contrast", "Timestamps", "Interface font", "Prompt font", "Code font"]) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeTruthy();
    }
    expect(within(screen.getByRole("group", { name: "Density" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["Compact", "Normal", "Comfortable"]);
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
