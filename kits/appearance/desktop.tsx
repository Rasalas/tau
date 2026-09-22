import { Palette } from "lucide-react";
import type { DesktopExtension, RegionProps, SettingsPageProps } from "tau";
import { userThemes } from "tau";
import { AppearanceApplier, readAppearance } from "./apply.js";
import { ThemeEditorPanel, ThemeEditorStore, draftFromWindow } from "./editor.js";
import { AppearancePage } from "./page.js";
import { APPEARANCE_EXTENSION_ID, APPEARANCE_SETTINGS_PAGE } from "./protocol.js";

/**
 * The desktop half of `tau.appearance`: Settings → Appearance, the theme
 * editor floating over the window, and what applies the values — density,
 * contrast, a theme per scheme, the prompt and code faces.
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

    plugin.registerSettingsPage({
      id: APPEARANCE_SETTINGS_PAGE,
      label: "Appearance",
      Icon: Palette,
      order: 5,
      profiles: ["desktop", "web", "compact"],
      scope: "both",
      keywords: ["theme", "dark", "light", "density", "compact", "contrast", "font", "font size", "typeface", "monospace", "vs code", "colors", "colours"],
      Component: (props: SettingsPageProps) => <AppearancePage {...props} preferences={plugin.preferences} editor={editor} />,
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
      run: (app) => app.openSettings(APPEARANCE_SETTINGS_PAGE),
    });
    plugin.registerCommand({
      id: "appearance.new-theme",
      label: "New theme…",
      group: "Appearance",
      run: () => editor.open(draftFromWindow(document.documentElement.dataset.theme === "light" ? "light" : "dark")),
    });

    return () => {
      stopFollowing();
      editor.close();
      applier.dispose();
    };
  },
};

export default appearanceExtension;
