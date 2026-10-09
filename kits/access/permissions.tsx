import { useSyncExternalStore } from "react";
import { FileText, Globe, Pencil, SquareTerminal } from "lucide-react";
import { hostIsReadOnly, SegmentedControl, SettingsSection, type PreferencesStore, type SettingsSectionProps } from "tau";
import type { AccessLevel } from "./protocol.js";
import { ACCESS_HOST_EXTENSION_ID, ACCESS_LEVEL_KEY, DEFAULT_ACCESS_LEVEL, isAccessLevel } from "./protocol.js";

/** The id the Runtimes page's Permissions button opens (core's `RUNTIME_PERMISSIONS_ROW`). */
export const PERMISSIONS_ROW = "runtime-permissions";

/** The levels as Settings and the composer's menu name them. */
export const LEVEL_CHOICES: ReadonlyArray<{ value: AccessLevel; label: string }> = [
  { value: "read-only", label: "Read only" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full access" },
];

/** What the gate does at each level (`gate.ts`): reads always pass, edits and commands are what it stops. */
export const PERMISSION_CARDS: ReadonlyArray<{ id: string; title: string; Icon: typeof FileText; says: Record<AccessLevel, string> }> = [
  { id: "read", title: "Read files", Icon: FileText, says: { "read-only": "Always allowed", ask: "Always allowed", auto: "Always allowed", full: "Always allowed" } },
  { id: "edit", title: "Edit files", Icon: Pencil, says: { "read-only": "Never: an edit is blocked", ask: "Asks every time", auto: "Reviewed: the runtime's reviewer decides, or it asks", full: "Allowed without asking" } },
  { id: "run", title: "Run commands", Icon: SquareTerminal, says: { "read-only": "Never: a command is blocked", ask: "Asks every time", auto: "Reviewed: the runtime's reviewer decides, or it asks", full: "Allowed without asking" } },
  { id: "network", title: "Reach the network", Icon: Globe, says: { "read-only": "No command runs to reach it", ask: "A command that reaches it asks first", auto: "The runtime's reviewer decides, or it asks first", full: "Allowed without asking" } },
];

/** One line for a level, from the Edit files card: what edits and commands meet at it. */
export function levelSummary(level: AccessLevel): string {
  const says = PERMISSION_CARDS.find((card) => card.id === "edit")!.says[level].split(":")[0]!;
  return `Edit files, run commands: ${says.toLowerCase()}`;
}

function storedLevel(preferences: PreferencesStore): AccessLevel {
  const value = preferences.value(ACCESS_HOST_EXTENSION_ID, ACCESS_LEVEL_KEY);
  return isAccessLevel(value) ? value : DEFAULT_ACCESS_LEVEL;
}

/** Settings → Runtimes: what a runtime may do before it asks, at the level chosen here or in the composer. */
export function createPermissionsSection(preferences: PreferencesStore, choose: (level: string) => void) {
  return function AccessPermissions(_props: SettingsSectionProps) {
    const read = () => storedLevel(preferences);
    const level = useSyncExternalStore(preferences.subscribe, read, read);
    return (
      <SettingsSection
        title="Before a runtime may…"
        id={PERMISSIONS_ROW}
        plain
        headerAction={<SegmentedControl label="Access level" value={level} options={LEVEL_CHOICES} disabled={hostIsReadOnly()} onChange={choose} />}
      >
        <ul className="access-permissions" aria-label={`At ${LEVEL_CHOICES.find((choice) => choice.value === level)?.label ?? level}`}>
          {PERMISSION_CARDS.map(({ id, title, Icon, says }) => (
            <li key={id} data-permission={id}>
              <h3><Icon size={14} aria-hidden />{title}</h3>
              <p>{says[level]}</p>
            </li>
          ))}
        </ul>
        <p className="access-permissions-note">Pi asks through Tau for every tool; the other runtimes turn the level into their own approvals and sandbox. At Auto, Claude Code and Codex let their own reviewer approve routine actions; the other runtimes ask, as at Ask.</p>
      </SettingsSection>
    );
  };
}
