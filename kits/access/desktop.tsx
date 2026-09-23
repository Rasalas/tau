import { useState, useSyncExternalStore } from "react";
import { ChevronDown, Lock, LockOpen } from "lucide-react";
import { HostUnavailableError, Menu, type ComposerControlProps, type DesktopExtension, type HostExtensionClient, type PreferencesStore } from "tau";
import type { AccessLevel } from "./protocol.js";
import { ACCESS_HOST_EXTENSION_ID, ACCESS_LEVELS, DEFAULT_ACCESS_LEVEL, isAccessLevel } from "./protocol.js";

const LEVEL_KEY = "level";

function storedLevel(preferences: PreferencesStore): AccessLevel {
  const value = preferences.value(ACCESS_HOST_EXTENSION_ID, LEVEL_KEY);
  return isAccessLevel(value) ? value : DEFAULT_ACCESS_LEVEL;
}

/** The chip and menu that used to be hard-wired into the composer. */
function createControl(preferences: PreferencesStore) {
  return function AccessControl({ snapshot }: ComposerControlProps) {
    const readLevel = () => storedLevel(preferences);
    const level = useSyncExternalStore(preferences.subscribe, readLevel, readLevel);
    const [open, setOpen] = useState(false);
    const noInteractiveApprovals = snapshot?.runtimeCapabilities?.interactiveApprovals === false;
    const label = ACCESS_LEVELS.find((entry) => entry.id === level)?.label ?? level;
    return (
      <span className="menu-anchor composer-runtime-menu-anchor">
        <button className="runtime-chip" data-composer-shortcut="composer.mode" onClick={() => setOpen((current) => !current)}>
          {level === "full" ? <LockOpen size={13} /> : <Lock size={13} />}
          {label}
          <ChevronDown size={12} className="chev" />
        </button>
        {open ? (
          <Menu
            placement="above"
            heading="Access"
            items={ACCESS_LEVELS.map((entry) => ({
              id: entry.id,
              label: entry.label,
              selected: entry.id === level,
              disabled: noInteractiveApprovals && entry.id === "ask",
              description: noInteractiveApprovals && entry.id === "ask"
                ? "This runtime cannot stop for an approval; choose read-only or full access."
                : undefined,
            }))}
            onSelect={(id) => preferences.setValue(ACCESS_HOST_EXTENSION_ID, LEVEL_KEY, id)}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
}

/**
 * Keeps the host gate at the level the person chose. The preference is the
 * source of truth; the host is told on activation and after every change.
 */
function syncLevel(host: HostExtensionClient, preferences: PreferencesStore): () => void {
  let pushed: AccessLevel | undefined;
  const push = () => {
    const level = storedLevel(preferences);
    if (level === pushed) return;
    pushed = level;
    void host.invoke("set-level", { level }).catch((error: unknown) => {
      pushed = undefined;
      if (error instanceof HostUnavailableError) return;
      console.warn("Access Kit could not apply the access level", error);
    });
  };
  push();
  return preferences.subscribe(push);
}

export const accessKitExtension: DesktopExtension = {
  id: ACCESS_HOST_EXTENSION_ID,
  name: "Access Kit",
  activate(plugin) {
    plugin.registerComposerControl({ id: "access.level", order: 30, profiles: ["desktop", "web", "compact"], Component: createControl(plugin.preferences) });
    // T3 Code's `composer.mode` opens the access menu, its runtime mode.
    plugin.registerCommand({ id: "composer.mode", label: "Choose the access level", group: "Composer", run: (app) => {
      const control = document.querySelector<HTMLElement>('[data-composer-shortcut="composer.mode"]');
      if (control) control.click();
      else app.notify("The composer shows no access control here.");
    } });
    plugin.registerKeybinding({ keys: "mod+shift+a", commandId: "composer.mode", when: "!terminalFocus" });
    for (const entry of ACCESS_LEVELS) {
      plugin.registerCommand({
        id: `access.${entry.id}`,
        label: `Access: ${entry.label}`,
        group: "Runtime",
        run: () => { plugin.preferences.setValue(ACCESS_HOST_EXTENSION_ID, LEVEL_KEY, entry.id); },
      });
    }
    return syncLevel(plugin.host, plugin.preferences);
  },
};

export default accessKitExtension;
