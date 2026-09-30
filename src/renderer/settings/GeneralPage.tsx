import { useSyncExternalStore } from "react";
import { TRANSCRIPT_DETAIL_LEVELS, isTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import { allAvailableThemes, getUserTheme } from "../theme";
import { usePreferences } from "../renderer-services-context";
import type { SendShortcut } from "../components/composer-send-keys";
import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { composerFold } from "../components/composer-fold";
import { QUIT_CONFIRMATIONS, isQuitConfirmation, type QuitConfirmation } from "../../shared/window-shell";
import { isMacPlatform } from "../keybindings";
import { useHostCapabilities } from "../use-host-capabilities";
import { SegmentedControl, Select, Switch } from "./controls";
import { SettingRow, SettingsSection, useSetting } from "./settings-layout";
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

/**
 * Settings → General: how the workbench behaves, whatever thread is open.
 * Core's, so safe mode has it; the defaults of a new thread are on Models.
 */
export function GeneralPage({ themeHere }: {
  /** No Appearance page to choose the theme on (safe mode): the choice stays here. */
  themeHere: boolean;
}) {
  const preferences = usePreferences();
  const { sendShortcut } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const composerFolds = useSyncExternalStore(composerFold.subscribe, composerFold.get);
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";

  const detail = useSetting<TranscriptDetail>("transcriptDetail", {
    defaultValue: CONFIG_DEFAULTS.transcriptDetail as TranscriptDetail, scope: "both", read: (raw) => (isTranscriptDetail(raw) ? raw : undefined),
    format: (value) => DETAIL_LABELS[value], offline: (value) => preferences.setTranscriptDetail(value),
  });
  const theme = useSetting<string>("theme", {
    defaultValue: CONFIG_DEFAULTS.theme as string, read: (raw) => (typeof raw === "string" && raw ? raw : undefined),
    format: (value) => getUserTheme(value)?.name ?? THEME_LABELS[value] ?? value, offline: (value) => preferences.setTheme(value),
  });
  const showCosts = useSetting<boolean>("showCosts", { defaultValue: CONFIG_DEFAULTS.showCosts as boolean, scope: "both", read: readBoolean, offline: (value) => preferences.setShowCosts(value) });
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

  return (
    <div className="settings-page">
      <SettingsSection title="Conversation">
        <SettingRow
          id={settingAnchor("Transcript detail")}
          title="Transcript detail"
          description="How much of a finished turn the transcript shows."
          help={`Focused reads a settled turn as one line; Detailed opens every group and shows thinking; Everything adds full tool output and timestamps. ⇧${mod}T cycles them for the thread on screen.`}
          setting={detail}
          control={<SegmentedControl label="Transcript detail" value={detail.value} options={TRANSCRIPT_DETAIL_LEVELS.map((level) => ({ value: level, label: DETAIL_LABELS[level] }))} onChange={detail.set} />}
        />
        <SettingRow
          id={settingAnchor("Show costs")}
          title="Show costs"
          description="What each thread has spent, in the composer and the thread list's hover card."
          setting={showCosts}
          control={<Switch label="Show costs" checked={showCosts.value} onChange={showCosts.set} />}
        />
        <SettingRow
          id={settingAnchor("Composer editing mode")}
          title="Composer editing mode"
          description="Standard has Readline and Emacs shortcuts; Vim edits the composer with Normal and Insert modes."
          setting={vimMode}
          control={<SegmentedControl label="Composer editing mode" value={vimMode.value ? "vim" : "standard"} options={[{ value: "standard", label: "Standard" }, { value: "vim", label: "Vim" }]} onChange={(value) => vimMode.set(value === "vim")} />}
        />
        <SettingRow
          id={settingAnchor("Send with")}
          title="Send with"
          description="The key that sends a message. This window's own choice."
          help={`While a turn runs, the send key queues a follow-up and ${mod}Return steers the turn (${mod}⇧Return when ${mod}Return sends).`}
          control={<Select label="Send with" width="md" value={sendShortcut} options={SEND_SHORTCUTS.map((entry) => ({ value: entry.value, label: entry.label.replace("⌘", mod) }))} onChange={(value) => preferences.setSendShortcut(value)} />}
        />
        <SettingRow
          id={settingAnchor("Fold the composer while scrolling")}
          title="Fold the composer while scrolling"
          description="Scrolling back folds an idle one-line composer to its text; typing, a click or reaching the end opens it again. This window's own choice."
          control={<Switch label="Fold the composer while scrolling" checked={composerFolds} onChange={composerFold.set} />}
        />
      </SettingsSection>

      {themeHere ? (
        <SettingsSection title="Appearance">
          <SettingRow
            id={settingAnchor("Theme")}
            title="Theme"
            description={<>System follows this machine's light or dark setting. Themes are <code>.css</code> or <code>.json</code> files in <code>~/.tau/themes/</code>.</>}
            setting={theme}
            control={<Select label="Theme" value={theme.value} options={allAvailableThemes().map((id) => ({ value: id, label: getUserTheme(id)?.name ?? THEME_LABELS[id] ?? id }))} onChange={theme.set} />}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Background and restarts">
        <SettingRow
          id={settingAnchor("Keep the host running in the background")}
          title="Keep the host running in the background"
          description="Threads keep working after you quit Tau, and the next start picks them up again."
          setting={hostBackground}
          control={<Switch label="Keep the host running in the background" checked={hostBackground.value} onChange={hostBackground.set} />}
        />
        <SettingRow
          id={settingAnchor("Continue threads after restarts")}
          title="Continue threads after restarts"
          description="Pick a thread back up where a restart cut its turn short. Off, the thread is repaired and marked instead."
          setting={continueAfterRestart}
          control={<Switch label="Continue threads after restarts" checked={continueAfterRestart.value} onChange={continueAfterRestart.set} />}
        />
        <SettingRow
          id={settingAnchor("Reload files when they change")}
          title="Reload files when they change"
          description="An edited package, theme, keybindings.json or config file applies at once. Off, edits apply at the next start."
          setting={watchFiles}
          control={<Switch label="Reload files when they change" checked={watchFiles.value} onChange={watchFiles.set} />}
        />
      </SettingsSection>

      {hostIsThisMachine ? (
        <SettingsSection title="Quitting">
          <SettingRow
            id={settingAnchor("Quit shortcut")}
            title="Quit shortcut"
            description={`How ${mod}Q quits: held for a moment, pressed twice, or at once. Quit in the menu always quits at once.`}
            setting={quitShortcut}
            control={<SegmentedControl label="Quit shortcut" value={quitShortcut.value} options={QUIT_CONFIRMATIONS.map((mode) => ({ value: mode, label: QUIT_LABELS[mode] }))} onChange={quitShortcut.set} />}
          />
          <SettingRow
            id={settingAnchor("Ask before quitting while threads work")}
            title="Ask before quitting while threads work"
            description="Quitting stops the threads that are working, unless the host keeps running in the background."
            setting={quitWhileRunning}
            control={<Switch label="Ask before quitting while threads work" checked={quitWhileRunning.value} onChange={quitWhileRunning.set} />}
          />
        </SettingsSection>
      ) : null}

    </div>
  );
}
