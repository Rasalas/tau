import { useSyncExternalStore } from "react";
import { Lock, LockOpen, Settings2, Sparkles } from "lucide-react";
import { ComposerMenuItem, ComposerMenuSection, HostUnavailableError, hostIsReadOnly, tooltipProps, useWorkbenchShell, type ComposerControlProps, type DesktopExtension, type HostExtensionClient, type PreferencesStore } from "tau";
import type { AccessLevel } from "./protocol.js";
import { ACCESS_HOST_EXTENSION_ID, ACCESS_LEVEL_KEY as LEVEL_KEY, ACCESS_LEVELS, DEFAULT_ACCESS_LEVEL, isAccessLevel } from "./protocol.js";
import { createPermissionsSection, LEVEL_CHOICES, levelSummary, PERMISSIONS_ROW } from "./permissions.js";

function storedLevel(preferences: PreferencesStore): AccessLevel {
  const value = preferences.value(ACCESS_HOST_EXTENSION_ID, LEVEL_KEY);
  return isAccessLevel(value) ? value : DEFAULT_ACCESS_LEVEL;
}

function levelIcon(level: AccessLevel, size: number) {
  return level === "full" ? <LockOpen size={size} aria-hidden="true" /> : level === "auto" ? <Sparkles size={size} aria-hidden="true" /> : <Lock size={size} aria-hidden="true" />;
}

/** The level as the Access section of the composer's "…" menu. */
function createControl(preferences: PreferencesStore, choose: (level: string) => void) {
  return function AccessControl({ snapshot, actions }: ComposerControlProps) {
    const readLevel = () => storedLevel(preferences);
    const level = useSyncExternalStore(preferences.subscribe, readLevel, readLevel);
    const noInteractiveApprovals = snapshot?.runtimeCapabilities?.interactiveApprovals === false;
    return (
      <ComposerMenuSection heading="Access">
        {LEVEL_CHOICES.map((entry) => (
          <ComposerMenuItem
            key={entry.value}
            icon={levelIcon(entry.value, 13)}
            label={entry.label}
            detail={levelSummary(entry.value)}
            selected={entry.value === level}
            disabled={noInteractiveApprovals && (entry.value === "ask" || entry.value === "auto")}
            disabledReason="This runtime cannot stop for an approval; choose read-only or full access."
            onSelect={() => choose(entry.value)}
          />
        ))}
        {actions ? <ComposerMenuItem icon={<Settings2 size={13} />} label="Details in Settings → Runtimes" onSelect={() => actions.openSettings(`runtimes#${PERMISSIONS_ROW}`)} /> : null}
      </ComposerMenuSection>
    );
  };
}

const STATUS_LABELS: Record<AccessLevel, string> = { "read-only": "Read only", ask: "Ask before edits", auto: "Auto review", full: "Full access" };

/** The level in force, at every level: full access is the default, so it needs saying most. */
function createAccessStatus(preferences: PreferencesStore) {
  return function AccessStatus() {
    const { registry } = useWorkbenchShell();
    const readLevel = () => storedLevel(preferences);
    const level = useSyncExternalStore(preferences.subscribe, readLevel, readLevel);
    const label = STATUS_LABELS[level];
    return (
      <button
        type="button"
        className={`runtime-chip composer-access-status${level === "full" ? " access-full" : ""}`}
        aria-label={`Access: ${label}`}
        // The footer row measures this chip and, once it is short of room, hides its label (styles.css).
        data-composer-collapsible=""
        {...tooltipProps(`Access: ${label}. ${levelSummary(level)}`, { shortcut: registry.keybindingLabel("composer.mode") })}
        onClick={(event) => {
          event.currentTarget.closest(".composer-chips")?.querySelector<HTMLElement>('[data-composer-menu]')?.click();
        }}
      >
        {levelIcon(level, 16)}
        <span className="composer-access-label">{label}</span>
      </button>
    );
  };
}

/**
 * The person's choice on this client: stored, and told to the host at once so
 * the next turn runs at it. Nothing is sent on load; the host reads its level
 * from its own config, which the stored value lands in too.
 */
function chooser(host: HostExtensionClient, preferences: PreferencesStore): (level: string) => void {
  return (level) => {
    if (!isAccessLevel(level)) return;
    preferences.setValue(ACCESS_HOST_EXTENSION_ID, LEVEL_KEY, level);
    // Sent even when this client shows that level already: its copy may be older than the host's.
    // The host refuses a Read-only device's level; the owner's clients set it.
    if (hostIsReadOnly()) return;
    void host.invoke("set-level", { level }).catch((error: unknown) => {
      if (error instanceof HostUnavailableError) return;
      console.warn("The Access extension could not apply the access level", error);
    });
  };
}

export const accessKitExtension: DesktopExtension = {
  id: ACCESS_HOST_EXTENSION_ID,
  name: "Access",
  activate(plugin) {
    const choose = chooser(plugin.host, plugin.preferences);
    plugin.registerComposerControl({ id: "access.level", placement: "menu", shortcuts: ["composer.mode"], order: 30, profiles: ["desktop", "web", "compact"], Component: createControl(plugin.preferences, choose) });
    plugin.registerComposerControl({ id: "access.status", placement: "lead", order: 30, profiles: ["desktop", "web", "compact"], Component: createAccessStatus(plugin.preferences) });
    plugin.registerSettingsSection({
      id: "access.permissions",
      page: "runtimes",
      profiles: ["desktop", "web", "compact"],
      rows: [{ id: PERMISSIONS_ROW, label: "Before a runtime may…", keywords: ["access level", "permissions", "approvals", "read only", "ask before edits", "auto", "auto review", "full access"] }],
      Component: createPermissionsSection(plugin.preferences, choose),
    });
    // `composer.mode` opens the menu that holds the access level, its runtime mode.
    plugin.registerCommand({ id: "composer.mode", label: "Choose the access level", group: "Composer", access: "write", run: (app) => {
      const control = document.querySelector<HTMLElement>('[data-composer-shortcut~="composer.mode"]');
      if (control) control.click();
      else app.notify("The composer shows no access control here.");
    } });
    plugin.registerKeybinding({ keys: "mod+shift+a", commandId: "composer.mode", when: "!terminalFocus" });
    for (const entry of ACCESS_LEVELS) {
      plugin.registerCommand({
        id: `access.${entry.id}`,
        label: `Access: ${entry.label}`,
        group: "Runtime",
        access: "write",
        run: () => choose(entry.id),
      });
    }
  },
};

export default accessKitExtension;
