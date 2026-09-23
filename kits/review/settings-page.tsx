import { useEffect, useState } from "react";
import { SettingRow, SettingsSection, useSetting, type HostExtensionClient, type SettingHandle } from "tau";
import { REVIEW_HOST_EXTENSION_ID as ID } from "./protocol.js";
import { COLLAPSED_OPTION, COLORS_KEY, SPLIT_OPTION, WHITESPACE_OPTION, WRAP_OPTION, type DiffColorScheme } from "./diff-settings.js";
import { SourceControlSettings } from "./source-settings.js";
import { INSTRUCTIONS_OPTION, TEMPLATE_OPTION } from "./writing.js";

const value = (key: string) => `values.${ID}.${key}`;
const option = (key: string) => `options.${ID}.${key}`;
const readString = (raw: unknown) => (typeof raw === "string" ? raw : undefined);
const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

const FORMATS = [
  { value: "conventional", label: "Conventional Commits" },
  { value: "gitmoji", label: "Gitmoji" },
  { value: "plain", label: "Plain subject" },
] as const;
const COLORS: ReadonlyArray<{ value: DiffColorScheme; label: string }> = [
  { value: "red-green", label: "Red & green" },
  { value: "blue-orange", label: "Blue & orange" },
];

function Toggle({ label, setting }: { label: string; setting: SettingHandle<boolean> }) {
  return (
    <button type="button" className={`switch ${setting.value ? "on" : ""}`} role="switch" aria-checked={setting.value} aria-label={label} disabled={!setting.writable} onClick={() => setting.set(!setting.value)}>
      <i />
    </button>
  );
}

function Choice({ label, setting, choices, swatches = false }: { label: string; setting: SettingHandle<string>; choices: ReadonlyArray<{ value: string; label: string }>; swatches?: boolean }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button key={choice.value} type="button" disabled={!setting.writable} className={setting.value === choice.value ? "active" : ""} aria-pressed={setting.value === choice.value} onClick={() => setting.set(choice.value)}>
          {swatches ? <span className={`review-color-swatch ${choice.value}`} aria-hidden="true"><i /><i /></span> : null}
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** Several lines of the user's own words; committed when the field loses focus. */
function Instructions({ setting }: { setting: SettingHandle<string> }) {
  const [draft, setDraft] = useState(setting.value);
  useEffect(() => setDraft(setting.value), [setting.value]);
  const commit = () => {
    const next = draft.trim();
    if (next === setting.value) return;
    if (next) setting.set(next);
    else setting.reset();
  };
  return <textarea className="settings-input review-instructions" rows={4} aria-label="Your instructions" disabled={!setting.writable}
    placeholder="Write in English. Mention the issue number when the branch names one." value={draft}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit} />;
}

/** The page bound to the kit's host half, which answers for the Git hosts. */
export function createReviewSettingsPage(host: HostExtensionClient) {
  return function ReviewSettings() { return <ReviewSettingsPage host={host} />; };
}

/**
 * Settings → Review: how commit messages and request descriptions are written
 * (T3 Code's writing settings), how diffs are drawn and which Git hosts this
 * machine reaches. The model that writes them stays on Review Kit's own page,
 * beside the extension's switch.
 */
export function ReviewSettingsPage({ host }: { host?: HostExtensionClient } = {}) {
  const propose = useSetting<boolean>(option("propose-message"), { defaultValue: true, read: readBoolean });
  const format = useSetting<string>(value("commit-style"), { defaultValue: "conventional", scope: "both", read: readString, format: (next) => FORMATS.find((entry) => entry.value === next)?.label ?? next });
  const instructions = useSetting<string>(value(INSTRUCTIONS_OPTION), { defaultValue: "", scope: "both", read: readString, format: (next) => (next ? `${next.slice(0, 40)}${next.length > 40 ? "…" : ""}` : "None") });
  const template = useSetting<boolean>(option(TEMPLATE_OPTION), { defaultValue: true, scope: "both", read: readBoolean });
  const colors = useSetting<string>(value(COLORS_KEY), { defaultValue: "red-green", read: readString, format: (next) => COLORS.find((entry) => entry.value === next)?.label ?? next });
  const wrap = useSetting<boolean>(option(WRAP_OPTION), { defaultValue: true, read: readBoolean });
  const split = useSetting<boolean>(option(SPLIT_OPTION), { defaultValue: false, read: readBoolean });
  const whitespace = useSetting<boolean>(option(WHITESPACE_OPTION), { defaultValue: false, read: readBoolean });
  const collapsed = useSetting<boolean>(option(COLLAPSED_OPTION), { defaultValue: false, read: readBoolean });

  return (
    <div className="settings-page review-settings-page">
      <h3>Review</h3>
      <SettingsSection title="Commit messages and pull requests">
        <SettingRow id="setting-review-propose" title="Write a commit message when review opens" description="The model proposes one from the diff; you can always edit it." setting={propose}
          control={<Toggle label="Write a commit message when review opens" setting={propose} />} />
        <SettingRow id="setting-review-format" title="Commit message format" setting={format}
          control={<Choice label="Commit message format" setting={format} choices={FORMATS} />} />
        <SettingRow id="setting-review-instructions" title="Your instructions" description="Added to every commit message and pull or merge request the model writes; where they differ from the format, yours win. A project can have its own." setting={instructions}
          control={<Instructions setting={instructions} />} />
        <SettingRow id="setting-review-template" title="Follow the request template" description="Fill in the repository's pull or merge request template instead of writing a description from scratch." setting={template}
          control={<Toggle label="Follow the request template" setting={template} />} />
      </SettingsSection>
      <SettingsSection title="Diffs">
        <SettingRow id="setting-review-colors" title="Colours" description="Additions and removals, including change counts. Blue and orange read apart for most kinds of colour blindness." setting={colors}
          control={<Choice label="Diff colours" setting={colors} choices={COLORS} swatches />} />
        <SettingRow id="setting-review-wrap" title="Wrap long lines" description="Off keeps each line on one row and scrolls the diff sideways. The review's toolbar switches it too." setting={wrap}
          control={<Toggle label="Wrap long lines" setting={wrap} />} />
        <SettingRow id="setting-review-split" title="Split view" setting={split} control={<Toggle label="Split view" setting={split} />} />
        <SettingRow id="setting-review-whitespace" title="Hide whitespace changes" setting={whitespace} control={<Toggle label="Hide whitespace changes" setting={whitespace} />} />
        <SettingRow id="setting-review-collapsed" title="Files start collapsed" setting={collapsed} control={<Toggle label="Files start collapsed" setting={collapsed} />} />
      </SettingsSection>
      {host ? <SourceControlSettings host={host} /> : null}
    </div>
  );
}
