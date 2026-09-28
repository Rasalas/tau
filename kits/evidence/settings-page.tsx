import { Select, SettingRow, SettingsSection, Switch, useSetting, type SettingHandle } from "tau";
import {
  DEFAULT_SETTINGS,
  EVIDENCE_EXTENSION_ID as ID,
  RETENTION_CHOICES,
  SETTING_KEYS,
  THREAD_MEGABYTE_CHOICES,
} from "./protocol.js";

const option = (key: string) => `options.${ID}.${key}`;
const value = (key: string) => `values.${ID}.${key}`;
const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);
const readChoice = (choices: readonly number[]) => (raw: unknown) => {
  const number = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return choices.includes(number) ? number : undefined;
};

function Choice({ label, setting, choices, unit }: { label: string; setting: SettingHandle<number>; choices: readonly number[]; unit: (value: number) => string }) {
  return (
    <Select label={label} width="sm" value={String(setting.value)} options={choices.map((choice) => ({ value: String(choice), label: unit(choice) }))}
      onChange={(next) => setting.set(Number(next))} />
  );
}

const days = (count: number) => `${String(count)} days`;
const megabytes = (count: number) => `${String(count)} MB`;

/** The page's rows, for the Settings search. */
export const EVIDENCE_SETTINGS_ROWS = [
  { id: "setting-evidence-preview", label: "Pictures of the Preview", keywords: ["screenshots", "capture", "browser"] },
  { id: "setting-evidence-screen", label: "Pictures of the window the agent drives", keywords: ["screenshots", "computer use", "capture", "window"] },
  { id: "setting-evidence-retention", label: "Keep pictures for", keywords: ["retention", "days", "delete", "storage"] },
  { id: "setting-evidence-space", label: "Space per thread", keywords: ["megabytes", "disk", "storage", "limit"] },
];

/**
 * Settings → Evidence: which surfaces a turn is pictured from (a project may
 * differ) and how much this machine keeps, with what is never taken.
 */
export function EvidenceSettingsPage() {
  const preview = useSetting<boolean>(option(SETTING_KEYS.preview), { defaultValue: DEFAULT_SETTINGS.preview, scope: "both", read: readBoolean });
  const screen = useSetting<boolean>(option(SETTING_KEYS.screen), { defaultValue: DEFAULT_SETTINGS.screen, scope: "both", read: readBoolean });
  const retention = useSetting<number>(value(SETTING_KEYS.retentionDays), { defaultValue: DEFAULT_SETTINGS.retentionDays, read: readChoice(RETENTION_CHOICES), write: String, format: days });
  const space = useSetting<number>(value(SETTING_KEYS.threadMegabytes), { defaultValue: DEFAULT_SETTINGS.threadMegabytes, read: readChoice(THREAD_MEGABYTE_CHOICES), write: String, format: megabytes });
  return (
    <div className="settings-page evidence-settings">
      <h3>Evidence</h3>
      <p className="lede">Nothing is taken while a password field has the keyboard in the Preview or while a thread is handed over to you.</p>
      <SettingsSection title="Capture">
        <SettingRow
          id="setting-evidence-preview"
          title="Pictures of the Preview"
          description="The Preview's page while a turn runs. A project can have its own."
          help="When the turn starts and ends, after each thing the agent does there, and every ten seconds when the page changed."
          setting={preview}
          control={<Switch label="Pictures of the Preview" checked={preview.value} onChange={preview.set} />}
        />
        <SettingRow
          id="setting-evidence-screen"
          title="Pictures of the window the agent drives"
          description="The screenshots computer use takes of the one window it works in. A project can have its own."
          setting={screen}
          control={<Switch label="Pictures of the window the agent drives" checked={screen.value} onChange={screen.set} />}
        />
      </SettingsSection>
      <SettingsSection title="Storage">
        <SettingRow
          id="setting-evidence-retention"
          title="Keep pictures for"
          description="Older turns lose their pictures."
          help="Deleting a thread for good deletes its pictures; a thread in the trash keeps them."
          setting={retention}
          control={<Choice label="Keep pictures for" setting={retention} choices={RETENTION_CHOICES} unit={days} />}
        />
        <SettingRow
          id="setting-evidence-space"
          title="Space per thread"
          description="Past this, a thread's oldest turns lose their pictures first."
          help="A turn keeps at most 60 pictures."
          setting={space}
          control={<Choice label="Space per thread" setting={space} choices={THREAD_MEGABYTE_CHOICES} unit={megabytes} />}
        />
      </SettingsSection>
    </div>
  );
}
