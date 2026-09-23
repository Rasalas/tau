import { SettingRow, SettingsSection, useSetting, type SettingHandle } from "tau";
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

function Toggle({ label, setting }: { label: string; setting: SettingHandle<boolean> }) {
  return (
    <button type="button" className={`switch ${setting.value ? "on" : ""}`} role="switch" aria-checked={setting.value} aria-label={label} disabled={!setting.writable} onClick={() => setting.set(!setting.value)}>
      <i />
    </button>
  );
}

function Choice({ label, setting, choices, unit }: { label: string; setting: SettingHandle<number>; choices: readonly number[]; unit: (value: number) => string }) {
  return (
    <select className="settings-select" aria-label={label} disabled={!setting.writable} value={String(setting.value)} onChange={(event) => setting.set(Number(event.target.value))}>
      {choices.map((choice) => <option key={choice} value={choice}>{unit(choice)}</option>)}
    </select>
  );
}

const days = (count: number) => `${String(count)} days`;
const megabytes = (count: number) => `${String(count)} MB`;

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
      <SettingsSection title="Capture">
        <SettingRow
          id="setting-evidence-preview"
          title="Pictures of the Preview"
          description="While a turn runs, the Preview's page when it starts and ends, after each thing the agent does there, and every ten seconds when it changed. A project can have its own."
          setting={preview}
          control={<Toggle label="Pictures of the Preview" setting={preview} />}
        />
        <SettingRow
          id="setting-evidence-screen"
          title="Pictures of the window the agent drives"
          description="The screenshots computer use takes of the one window it works in. A project can have its own."
          setting={screen}
          control={<Toggle label="Pictures of the window the agent drives" setting={screen} />}
        />
      </SettingsSection>
      <SettingsSection title="Storage">
        <SettingRow id="setting-evidence-retention" title="Keep pictures for" description="Older turns lose their pictures. Deleting a thread for good deletes its pictures; a thread in the trash keeps them." setting={retention}
          control={<Choice label="Keep pictures for" setting={retention} choices={RETENTION_CHOICES} unit={days} />} />
        <SettingRow id="setting-evidence-space" title="Space per thread" description="Past this, a thread's oldest turns lose their pictures first. A turn keeps at most 60." setting={space}
          control={<Choice label="Space per thread" setting={space} choices={THREAD_MEGABYTE_CHOICES} unit={megabytes} />} />
      </SettingsSection>
      <p className="settings-note evidence-privacy">
        Tau never pictures the whole screen: only the Preview's page and the one window the agent drives. Nothing is taken while a
        password field has the keyboard in the Preview or while a thread is handed over to you. Pictures stay on this machine until
        you save or send them.
      </p>
    </div>
  );
}
