import { useSyncExternalStore } from "react";
import { SegmentedControl, SettingRow, SettingsSection, SettingsState, Switch, useSetting, useWorkbenchShell, type PreferencesStore } from "tau";
import { COMPACT_AT_CHOICES, COMPACT_AT_KEY, DEFAULT_COMPACT_AT, OFF_KEY, readCompactAt, RESUME_COMPACTION_EXTENSION_ID, type CompactAt } from "./protocol.js";
import { readList } from "./rule.js";

type Preferences = Pick<PreferencesStore, "subscribe" | "getSnapshot" | "value" | "setValue">;

/** What the Settings search finds on the page; each id is a row's anchor. */
export const RESUME_COMPACTION_ROWS = [
  { id: "setting-resume-compaction-runtimes", label: "Offer to compact old threads", keywords: ["compact", "context", "resume", "prompt cache", "don't ask again", "full history", "compact and send"] },
];

export function readOff(preferences: Preferences): string[] {
  return readList(preferences.value(RESUME_COMPACTION_EXTENSION_ID, OFF_KEY));
}

export function setOff(preferences: Preferences, runtime: string, off: boolean): void {
  const current = readOff(preferences).filter((entry) => entry !== runtime);
  preferences.setValue(RESUME_COMPACTION_EXTENSION_ID, OFF_KEY, JSON.stringify(off ? [...current, runtime] : current));
}

/** The runtimes the user turned the offer off for, each with a switch to turn it back on. */
export function createSettingsPage(preferences: Preferences) {
  return function ResumeCompactionSettings() {
    useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const backends = useWorkbenchShell().snapshot?.runtimeBackends ?? [];
    const off = readOff(preferences);
    const label = (runtime: string) => backends.find((backend) => backend.kind === runtime)?.label ?? runtime;
    return (
      <div className="settings-page resume-compaction-settings">
        <h3>Resume compaction</h3>
        <SettingsSection title="Offer to compact old threads" id="setting-resume-compaction-runtimes">
          {off.length === 0 ? (
            <SettingsState
              kind="empty"
              title="Offered on every runtime"
              description={"Choose “Always send with full history” beside the send button, or “Don’t ask again” when a runtime asks whether to compact, and it shows here to turn the offer back on."}
            />
          ) : off.map((runtime) => (
            <SettingRow
              key={runtime}
              title={label(runtime)}
              description="Turned off with “Always send with full history” or “Don’t ask again”."
              control={<Switch label={`Offer to compact ${label(runtime)} threads`} checked={false} onChange={(next) => setOff(preferences, runtime, !next)} />}
            />
          ))}
        </SettingsSection>
      </div>
    );
  };
}

/** General's Threads card (design 2i); only Pi threads follow it, which the row says. */
export function CompactAtRow() {
  const compactAt = useSetting<CompactAt>(`values.${RESUME_COMPACTION_EXTENSION_ID}.${COMPACT_AT_KEY}`, { defaultValue: DEFAULT_COMPACT_AT, scope: "both", read: readCompactAt });
  return (
    <SettingRow
      id="setting-compact-context"
      title="Compact context"
      description="when it passes · Pi threads"
      setting={compactAt}
      control={<SegmentedControl label="Compact context" value={compactAt.value} options={COMPACT_AT_CHOICES.map((value) => ({ value, label: value === "never" ? "Never" : `${value}%` }))} onChange={compactAt.set} />}
    />
  );
}
