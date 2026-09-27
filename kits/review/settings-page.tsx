import { SegmentedControl, Select, SettingRow, SettingsSection, Switch, TextField, useSetting, type HostExtensionClient, type SettingHandle, type SettingsPageProps } from "tau";
import { REVIEW_HOST_EXTENSION_ID as ID } from "./protocol.js";
import { COLLAPSED_OPTION, COLORS_KEY, SPLIT_OPTION, WHITESPACE_OPTION, WRAP_OPTION, type DiffColorScheme } from "./diff-settings.js";
import { SourceControlSettings } from "./source-settings.js";
import { INSTRUCTIONS_OPTION, TEMPLATE_OPTION } from "./writing.js";
import { DELETE_BRANCH_OPTION } from "./merge-controls.js";
import { PROACTIVE_OPTION } from "./proactive-panels.js";
import { STRIP_OPTION } from "./pull-request-strip-logic.js";

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

function Swatch({ scheme }: { scheme: DiffColorScheme }) {
  return <span className={`review-color-swatch ${scheme}`} aria-hidden="true"><i /><i /></span>;
}

/** The page's rows, for the Settings search. */
export const REVIEW_SETTINGS_ROWS = [
  { id: "setting-review-propose", label: "Write a commit message when review opens", keywords: ["commit message", "propose", "model"] },
  { id: "setting-review-format", label: "Commit message format", keywords: ["conventional commits", "gitmoji", "plain"] },
  { id: "setting-review-instructions", label: "Your instructions", keywords: ["commit message", "pull request", "description", "prompt"] },
  { id: "setting-review-template", label: "Follow the request template", keywords: ["pull request template", "merge request", "description"] },
  { id: "setting-review-delete-branch", label: "Delete the branch after merging", keywords: ["merge", "branch", "cleanup"] },
  { id: "setting-review-proactive", label: "Proactive panels", keywords: ["open pull request", "changes panel", "automatic"] },
  { id: "setting-review-strip", label: "Show the pull request above the composer", keywords: ["strip", "composer", "pull request state"] },
  { id: "setting-review-colors", label: "Diff colours", keywords: ["colors", "red", "green", "blue", "orange", "colour blindness"] },
  { id: "setting-review-wrap", label: "Wrap long lines", keywords: ["diff", "wrap"] },
  { id: "setting-review-split", label: "Split view", keywords: ["diff", "side by side"] },
  { id: "setting-review-whitespace", label: "Hide whitespace changes", keywords: ["diff", "whitespace"] },
  { id: "setting-review-collapsed", label: "Files start collapsed", keywords: ["diff", "collapse"] },
  { id: "setting-review-git-hosts", label: "Git hosts", keywords: ["github", "gitlab", "forgejo", "bitbucket", "azure devops", "signed in"] },
  { id: "setting-review-servers", label: "Self-hosted servers", keywords: ["self-hosted", "gitea", "forgejo", "provider", "host"] },
];

/** The page bound to the kit's host half, which answers for the Git hosts. */
export function createReviewSettingsPage(host: HostExtensionClient) {
  return function ReviewSettings({ onNotify }: SettingsPageProps) { return <ReviewSettingsPage host={host} onNotify={onNotify} />; };
}

/**
 * Settings → Review: how commit messages and request descriptions are written
 * (T3 Code's writing settings), how diffs are drawn and which Git hosts this
 * machine reaches. The model that writes them stays on Review Kit's own page,
 * beside the extension's switch.
 */
export function ReviewSettingsPage({ host, onNotify = () => undefined }: { host?: HostExtensionClient; onNotify?(message: string): void } = {}) {
  const propose = useSetting<boolean>(option("propose-message"), { defaultValue: true, read: readBoolean });
  const format = useSetting<string>(value("commit-style"), { defaultValue: "conventional", scope: "both", read: readString, format: (next) => FORMATS.find((entry) => entry.value === next)?.label ?? next });
  const instructions = useSetting<string>(value(INSTRUCTIONS_OPTION), { defaultValue: "", scope: "both", read: readString, format: (next) => (next ? `${next.slice(0, 40)}${next.length > 40 ? "…" : ""}` : "None") });
  const template = useSetting<boolean>(option(TEMPLATE_OPTION), { defaultValue: true, scope: "both", read: readBoolean });
  const colors = useSetting<string>(value(COLORS_KEY), { defaultValue: "red-green", read: readString, format: (next) => COLORS.find((entry) => entry.value === next)?.label ?? next });
  const wrap = useSetting<boolean>(option(WRAP_OPTION), { defaultValue: true, read: readBoolean });
  const split = useSetting<boolean>(option(SPLIT_OPTION), { defaultValue: false, read: readBoolean });
  const whitespace = useSetting<boolean>(option(WHITESPACE_OPTION), { defaultValue: false, read: readBoolean });
  const collapsed = useSetting<boolean>(option(COLLAPSED_OPTION), { defaultValue: false, read: readBoolean });
  const deleteBranch = useSetting<boolean>(option(DELETE_BRANCH_OPTION), { defaultValue: false, scope: "both", read: readBoolean });
  const proactive = useSetting<boolean>(option(PROACTIVE_OPTION), { defaultValue: false, read: readBoolean });
  const strip = useSetting<boolean>(option(STRIP_OPTION), { defaultValue: true, read: readBoolean });

  const toggle = (label: string, setting: SettingHandle<boolean>) => <Switch label={label} checked={setting.value} onChange={setting.set} />;

  return (
    <div className="settings-page review-settings-page">
      <h3>Review</h3>
      <SettingsSection title="Commit messages and pull requests">
        <SettingRow id="setting-review-propose" title="Write a commit message when review opens" description="The model proposes one from the diff; you can always edit it." setting={propose}
          control={toggle("Write a commit message when review opens", propose)} />
        <SettingRow id="setting-review-format" title="Commit message format" setting={format}
          control={<Select label="Commit message format" value={format.value} options={FORMATS} onChange={format.set} />} />
        <SettingRow id="setting-review-instructions" title="Your instructions" description="Added to every commit message and pull or merge request the model writes. A project can have its own."
          help="Where they differ from the format, yours win. ⌘Return or leaving the box saves them." setting={instructions}
          control={<TextField label="Your instructions" rows={4} placeholder="Write in English. Mention the issue number when the branch names one." value={instructions.value}
            onCommit={(draft) => {
              const next = draft.trim();
              if (next === instructions.value) return;
              if (next) instructions.set(next);
              else instructions.reset();
            }} />} />
        <SettingRow id="setting-review-template" title="Follow the request template" description="Fill in the repository's pull or merge request template instead of writing a description from scratch." setting={template}
          control={toggle("Follow the request template", template)} />
      </SettingsSection>
      <SettingsSection title="Merging and panels">
        <SettingRow id="setting-review-delete-branch" title="Delete the branch after merging" description="A merge's confirmation starts with this ticked."
          help="GitHub keeps a branch another open request is based on, and the default branch." setting={deleteBranch}
          control={toggle("Delete the branch after merging", deleteBranch)} />
        <SettingRow id="setting-review-proactive" title="Proactive panels" description="Open a pull request when the thread links a new one, else the Changes panel after a large turn."
          help="A large turn changed at least 3 files or 50 lines." setting={proactive}
          control={toggle("Proactive panels", proactive)} />
        <SettingRow id="setting-review-strip" title="Show the pull request above the composer" description="The thread's pull or merge request, or the one it links, with its state."
          help="Its × hides it in that thread until the request or its state changes." setting={strip}
          control={toggle("Show the pull request above the composer", strip)} />
      </SettingsSection>
      <SettingsSection title="Diffs">
        <SettingRow id="setting-review-colors" title="Diff colours" description="Additions and removals, including change counts. Blue and orange read apart for most kinds of colour blindness." setting={colors}
          control={<SegmentedControl label="Diff colours" value={colors.value} options={COLORS.map((choice) => ({ ...choice, icon: <Swatch scheme={choice.value} /> }))} onChange={colors.set} />} />
        <SettingRow id="setting-review-wrap" title="Wrap long lines" description="Off keeps each line on one row and scrolls the diff sideways. The review's toolbar switches it too." setting={wrap}
          control={toggle("Wrap long lines", wrap)} />
        <SettingRow id="setting-review-split" title="Split view" setting={split} control={toggle("Split view", split)} />
        <SettingRow id="setting-review-whitespace" title="Hide whitespace changes" setting={whitespace} control={toggle("Hide whitespace changes", whitespace)} />
        <SettingRow id="setting-review-collapsed" title="Files start collapsed" setting={collapsed} control={toggle("Files start collapsed", collapsed)} />
      </SettingsSection>
      {host ? <SourceControlSettings host={host} onNotify={onNotify} /> : null}
    </div>
  );
}
