import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { TRANSCRIPT_DETAIL_LEVELS, isTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import { allAvailableThemes, getUserTheme } from "../theme";
import { usePreferences } from "../renderer-services-context";
import type { SendShortcut } from "../components/composer-send-keys";
import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { composerFold } from "../components/composer-fold";
import { QUIT_CONFIRMATIONS, isQuitConfirmation, type QuitConfirmation } from "../../shared/window-shell";
import { isMacPlatform } from "../keybindings";
import { useHostCapabilities } from "../use-host-capabilities";
import type { SettingsCardId, SettingsSectionProps } from "../extension-system";
import { SegmentedControl, Select, Switch } from "./controls";
import { SettingRow, SettingsCard, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const SEND_SHORTCUTS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: "enter", label: "Return" },
  { value: "mod-enter-multiline", label: "⌘Return once there are several lines" },
  { value: "mod-enter", label: "⌘Return" },
];

const DETAIL_LABELS: Record<TranscriptDetail, string> = { focused: "Focused", detailed: "Detailed", everything: "Everything" };
const QUIT_LABELS: Record<QuitConfirmation, string> = { hold: "Hold", "double-press": "Press twice", off: "At once" };
const THEME_LABELS: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

/** A row in its card, among the rows kits add there: lower `order` first. */
type Placed = { order: number; node: ReactNode };

export type GeneralSection = { id: string; card?: SettingsCardId | undefined; order?: number | undefined; Component: ComponentType<SettingsSectionProps> };

/**
 * Settings → General (design 2i): cards in two columns. Appearance, Notify me
 * when, New threads and Threads gather core's rows and the rows kits add with
 * `registerSettingsSection({ page: "general", card })`; Tau's own composer and
 * window settings follow in cards of the same kind.
 */
export function GeneralPage({ themeHere, sections = [], onNotify = () => undefined }: {
  /** No Appearance page to choose the theme on (safe mode): every theme is offered here. */
  themeHere: boolean;
  sections?: readonly GeneralSection[];
  onNotify?(message: string): void;
}) {
  const preferences = usePreferences();
  const { sendShortcut } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const composerFolds = useSyncExternalStore(composerFold.subscribe, composerFold.get);
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";

  const detail = useSetting<TranscriptDetail>("transcriptDetail", {
    defaultValue: CONFIG_DEFAULTS.transcriptDetail as TranscriptDetail, read: (raw) => (isTranscriptDetail(raw) ? raw : undefined),
    format: (value) => DETAIL_LABELS[value], offline: (value) => preferences.setTranscriptDetail(value),
  });
  const theme = useSetting<string>("theme", {
    defaultValue: CONFIG_DEFAULTS.theme as string, read: (raw) => (typeof raw === "string" && raw ? raw : undefined),
    format: (value) => getUserTheme(value)?.name ?? THEME_LABELS[value] ?? value, offline: (value) => preferences.setTheme(value),
  });
  const showCosts = useSetting<boolean>("showCosts", { defaultValue: CONFIG_DEFAULTS.showCosts as boolean, read: readBoolean, offline: (value) => preferences.setShowCosts(value) });
  const vimMode = useSetting<boolean>("vimMode", {
    defaultValue: CONFIG_DEFAULTS.vimMode as boolean, read: readBoolean, format: (value) => (value ? "Vim" : "Standard"), offline: (value) => preferences.setVimMode(value),
  });
  const hostBackground = useSetting<boolean>("hostBackground", { defaultValue: CONFIG_DEFAULTS.hostBackground as boolean, read: readBoolean, offline: (value) => preferences.setHostBackground(value) });
  const continueAfterRestart = useSetting<boolean>("threads.continueAfterRestart", {
    defaultValue: CONFIG_DEFAULTS["threads.continueAfterRestart"] as boolean, read: readBoolean, offline: (value) => preferences.setContinueThreadsAfterRestart(value),
  });
  // CONFIG_DEFAULTS' value, written out: reading it here would keep the entry in the start-up chunk.
  const watchFiles = useSetting<boolean>("extensions.watch", { defaultValue: true, read: readBoolean });
  // The quit chord reads this machine's config; a host elsewhere would store a choice nothing here applies.
  const { localFiles: hostIsThisMachine } = useHostCapabilities();
  const quitShortcut = useSetting<QuitConfirmation>("confirm.quit", {
    defaultValue: CONFIG_DEFAULTS["confirm.quit"] as QuitConfirmation, read: (raw) => (isQuitConfirmation(raw) ? raw : undefined), format: (value) => QUIT_LABELS[value],
  });
  const quitWhileRunning = useSetting<boolean>("confirm.quitWhileRunning", {
    defaultValue: CONFIG_DEFAULTS["confirm.quitWhileRunning"] as boolean, read: readBoolean, offline: (value) => preferences.setConfirmQuitWhileRunning(value),
  });

  // Light, Dark, System as the design orders them; a theme of the user's own, chosen before, stays a choice too.
  const themes = ["light", "dark", "system", ...(themeHere ? allAvailableThemes() : [theme.value]).filter((id) => getUserTheme(id))];
  const themeOptions = themes.map((id) => ({ value: id, label: getUserTheme(id)?.name ?? THEME_LABELS[id] ?? id }));
  const own: Partial<Record<SettingsCardId, Placed[]>> = {
    appearance: [
      {
        order: 10,
        node: <SettingRow
          key="theme"
          id={settingAnchor("Theme")}
          title="Theme"
          setting={theme}
          control={<SegmentedControl label="Theme" value={theme.value} options={themeOptions} onChange={theme.set} />}
        />,
      },
      {
        order: 30,
        node: <SettingRow key="costs" id={settingAnchor("Show costs")} title="Show costs" description="in rows, headers and reviews" setting={showCosts}
          control={<Switch label="Show costs" checked={showCosts.value} onChange={showCosts.set} />} />,
      },
    ],
  };
  const card = (id: SettingsCardId, title: string) => {
    const rows = [
      ...(own[id] ?? []),
      ...sections.filter((section) => section.card === id).map(({ id: key, order = 100, Component }) => ({ order, node: <Component key={key} onNotify={onNotify} onChanged={() => undefined} /> })),
    ].sort((left, right) => left.order - right.order);
    return rows.length ? <SettingsCard title={title}>{rows.map((row) => row.node)}</SettingsCard> : null;
  };

  return (
    <div className="settings-page settings-cards">
      {card("appearance", "Appearance")}
      {card("notify", "Notify me when")}
      {card("new-threads", "New threads")}
      {card("threads", "Threads")}
      <SettingsCard title="Composer">
        <SettingRow
          id={settingAnchor("Transcript detail")}
          title="Transcript detail"
          description="of a finished turn"
          help={`Focused reads a settled turn as one line; Detailed opens every group and shows thinking; Everything adds full tool output and timestamps. ⇧${mod}T cycles them for the thread on screen.`}
          setting={detail}
          control={<SegmentedControl label="Transcript detail" value={detail.value} options={TRANSCRIPT_DETAIL_LEVELS.map((level) => ({ value: level, label: DETAIL_LABELS[level] }))} onChange={detail.set} />}
        />
        <SettingRow
          id={settingAnchor("Composer editing mode")}
          title="Composer editing mode"
          help="Standard has Readline and Emacs shortcuts; Vim edits the composer with Normal and Insert modes."
          setting={vimMode}
          control={<SegmentedControl label="Composer editing mode" value={vimMode.value ? "vim" : "standard"} options={[{ value: "standard", label: "Standard" }, { value: "vim", label: "Vim" }]} onChange={(value) => vimMode.set(value === "vim")} />}
        />
        <SettingRow
          id={settingAnchor("Send with")}
          title="Send with"
          wholeMachine
          help={`While a turn runs, the send key queues a follow-up and ${mod}Return steers the turn (${mod}⇧Return when ${mod}Return sends).`}
          control={<Select label="Send with" width="md" value={sendShortcut} options={SEND_SHORTCUTS.map((entry) => ({ value: entry.value, label: entry.label.replace("⌘", mod) }))} onChange={(value) => preferences.setSendShortcut(value)} />}
        />
        <SettingRow
          id={settingAnchor("Fold the composer while scrolling")}
          title="Fold the composer while scrolling"
          wholeMachine
          help="Scrolling back folds an idle one-line composer to its text; typing, a click or reaching the end opens it again."
          control={<Switch label="Fold the composer while scrolling" checked={composerFolds} onChange={composerFold.set} />}
        />
      </SettingsCard>
      <SettingsCard title="Window">
        <SettingRow
          id={settingAnchor("Keep the host running in the background")}
          title="Keep the host running in the background"
          description="threads keep working after you quit"
          setting={hostBackground}
          control={<Switch label="Keep the host running in the background" checked={hostBackground.value} onChange={hostBackground.set} />}
        />
        <SettingRow
          id={settingAnchor("Continue threads after restarts")}
          title="Continue threads after restarts"
          help="Pick a thread back up where a restart cut its turn short. Off, the thread is repaired and marked instead."
          setting={continueAfterRestart}
          control={<Switch label="Continue threads after restarts" checked={continueAfterRestart.value} onChange={continueAfterRestart.set} />}
        />
        <SettingRow
          id={settingAnchor("Reload files when they change")}
          title="Reload files when they change"
          help="An edited package, theme, keybindings.json or config file applies at once. Off, edits apply at the next start."
          setting={watchFiles}
          control={<Switch label="Reload files when they change" checked={watchFiles.value} onChange={watchFiles.set} />}
        />
        {hostIsThisMachine ? <>
          <SettingRow
            id={settingAnchor("Quit shortcut")}
            title="Quit shortcut"
            help="Quit in the menu always quits at once."
            setting={quitShortcut}
            control={<SegmentedControl label="Quit shortcut" value={quitShortcut.value} options={QUIT_CONFIRMATIONS.map((mode) => ({ value: mode, label: QUIT_LABELS[mode] }))} onChange={quitShortcut.set} />}
          />
          <SettingRow
            id={settingAnchor("Ask before quitting while threads work")}
            title="Ask before quitting while threads work"
            help="Quitting stops the threads that are working, unless the host keeps running in the background."
            setting={quitWhileRunning}
            control={<Switch label="Ask before quitting while threads work" checked={quitWhileRunning.value} onChange={quitWhileRunning.set} />}
          />
        </> : null}
      </SettingsCard>
      {sections.filter((section) => !section.card).map(({ id, Component }) => <Component key={id} onNotify={onNotify} onChanged={() => undefined} />)}
    </div>
  );
}
