import { Palette } from "lucide-react";
import type { DesktopExtension, RegionProps, SettingsPageProps } from "tau";
import { userThemes } from "tau";
import { AppearanceApplier, readAppearance } from "./apply.js";
import { ThemeEditorPanel, ThemeEditorStore, draftFromWindow } from "./editor.js";
import { AppearancePage } from "./page.js";
import { APPEARANCE_EXTENSION_ID, APPEARANCE_SETTINGS_PAGE, TERMINAL_FONT_SERVICE, type TerminalFontService } from "./protocol.js";
import { TerminalFontLink } from "./terminal-font.js";

/**
 * The desktop half of `tau.appearance`: Settings → Appearance, the theme
 * editor floating over the window, and what applies the values — density,
 * contrast, a theme per scheme, the prompt and code faces, panel motion.
 */
export const appearanceExtension: DesktopExtension = {
  id: APPEARANCE_EXTENSION_ID,
  name: "Appearance",
  activate(plugin) {
    const applier = new AppearanceApplier();
    const editor = new ThemeEditorStore();
    const apply = () => applier.apply(readAppearance(plugin.preferences), userThemes());
    apply();
    const stopFollowing = plugin.preferences.subscribe(apply);
    // The terminal's font is Terminal Kit's; this page only draws its row while that kit is on.
    const terminalFont = new TerminalFontLink();
    const stopTerminalFont = plugin.useService<TerminalFontService>(TERMINAL_FONT_SERVICE, (service) => terminalFont.connect(service));

    plugin.registerSettingsPage({
      id: APPEARANCE_SETTINGS_PAGE,
      label: "Appearance",
      group: "general",
      Icon: Palette,
      order: 5,
      profiles: ["desktop", "web", "compact"],
      scope: "both",
      rows: [
        { id: "setting-appearance-mode", label: "Mode", keywords: ["theme", "dark", "light", "system"] },
        { id: "setting-appearance-themes", label: "Themes", keywords: ["theme", "colors", "colours", "vs code", "import", "new theme"] },
        { id: "setting-appearance-density", label: "Density", keywords: ["compact", "comfortable", "spacing"] },
        { id: "setting-appearance-contrast", label: "Contrast", keywords: ["hairlines", "quiet text"] },
        { id: "setting-appearance-timestamps", label: "Timestamps", keywords: ["12-hour", "24-hour", "clock", "time"] },
        { id: "setting-appearance-panel-animations", label: "Panel animations", keywords: ["motion", "animation", "sidebar", "dock"] },
        { id: "setting-appearance-interface-font", label: "Interface font", keywords: ["font", "font size", "typeface"] },
        { id: "setting-appearance-prompt-font", label: "Prompt font", keywords: ["font", "composer", "monospace"] },
        { id: "setting-appearance-code-font", label: "Code font", keywords: ["font", "monospace", "diff"] },
      ],
      keywords: ["theme", "dark", "light", "density", "compact", "contrast", "font", "font size", "typeface", "monospace", "terminal", "ghostty", "vs code", "colors", "colours", "timestamps", "12-hour", "24-hour", "animation", "motion", "panels"],
      Component: (props: SettingsPageProps) => <AppearancePage {...props} preferences={plugin.preferences} editor={editor} terminalFont={terminalFont} />,
    });
    // The title bar is always there, so the editor outlives the Settings page it was opened from.
    plugin.registerRegion({
      id: "appearance.theme-editor",
      placement: "title-bar",
      profiles: ["desktop", "web"],
      Component: ({ actions }: RegionProps) => <ThemeEditorPanel store={editor} host={plugin.host} preferences={plugin.preferences} notify={actions.notify} />,
    });
    plugin.registerCommand({
      id: "appearance.open",
      label: "Open Appearance settings",
      group: "Appearance",
      access: "read",
      run: (app) => app.openSettings(APPEARANCE_SETTINGS_PAGE),
    });
    plugin.registerCommand({
      id: "appearance.new-theme",
      label: "New theme…",
      group: "Appearance",
      access: "write",
      run: () => editor.open(draftFromWindow(document.documentElement.dataset.theme === "light" ? "light" : "dark")),
    });
    plugin.registerCommand({
      id: "appearance.toggle-theme-editor",
      label: "Toggle theme editor",
      group: "Appearance",
      access: "write",
      run: () => {
        if (editor.getSnapshot().draft) editor.close();
        else editor.open(draftFromWindow(document.documentElement.dataset.theme === "light" ? "light" : "dark"));
      },
    });
    // T3 Code's theme chords; Runtime Controls binds its "appearance.cycle" twin, `mod+alt+shift+a`.
    plugin.registerKeybinding({ keys: "mod+alt+a", commandId: "appearance.open" });
    plugin.registerKeybinding({ keys: "mod+alt+shift+t", commandId: "appearance.toggle-theme-editor" });

    return () => {
      stopTerminalFont();
      stopFollowing();
      editor.close();
      applier.dispose();
    };
  },
};

export default appearanceExtension;
