import { useEffect, useSyncExternalStore } from "react";
import { getClientStorage, SettingRow, Switch, useClientEnvironment, type DesktopExtension, type RegionProps, type WorkbenchActions } from "tau";
import { UsageStatistics } from "./statistics.js";

/** General's Privacy card: the one choice about this device, and what taking part sends. */
export function StatisticsSettings({ statistics }: { statistics: UsageStatistics }) {
  const { enabled, id, error } = useSyncExternalStore(statistics.subscribe, statistics.getSnapshot);
  const { release } = useClientEnvironment();
  return <>
      <SettingRow id="setting-share-usage-statistics" title="Share usage statistics"
        description="Help count active Tau desktop installations. Off until you choose to participate."
        help="A random device ID, activity type, app version, platform and release channel go to Torben Buck's self-hosted Matomo. The server timestamps each report. Prompts, files, projects and account identities are not included. IP addresses are fully masked in Matomo; the server still receives the connection's IP and browser headers."
        wholeMachine control={<Switch label="Share usage statistics" checked={enabled} disabled={!release} onChange={statistics.setEnabled} />} />
      {!release ? <p className="settings-group-note">Reporting is available in installed desktop releases. Development and test instances do not send statistics.</p> : null}
      {error ? <p className="settings-group-note" role="alert">{error}</p> : null}
      <p className="settings-group-note">Participating sends a random device ID, daily activity, app version, platform and release channel to Torben Buck's self-hosted Matomo. Prompt text, files, project names and account identities stay out of these reports.</p>
      <p className="settings-group-note">This choice stays on this device. Turning it off stops new reports and cancels pending requests.</p>
      {id ? <p className="settings-group-note">Statistics ID: <code>{id}</code>. To request deletion of earlier reports, send this ID to <a href="mailto:info@tbuck.de">info@tbuck.de</a>. Turning reporting off does not delete earlier reports.</p> : null}
      <p className="settings-group-note"><a href="https://tbuck.de/privacy/tau/" target="_blank" rel="noreferrer">Privacy policy</a></p>
  </>;
}

/** Asked once per window until this device chose; closed unanswered, the next window asks again. */
export function askToShare(statistics: UsageStatistics, actions: Pick<WorkbenchActions, "toast" | "openSettings">): void {
  if (!actions.toast || !statistics.claimQuestion()) return;
  actions.toast({
    id: "usage-statistics:ask",
    type: "question",
    title: "Share usage statistics?",
    // Details opens the full list of what is sent.
    description: "Counts this installation with a random ID and active days; never prompts or files.",
    timeoutMs: 0,
    actions: [
      { label: "Details", opens: true, keepOpen: true, run: () => actions.openSettings("general#setting-share-usage-statistics") },
      { label: "Don't share", run: () => statistics.setEnabled(false) },
      // The prompt that brought the question was accepted before the choice; it counts once shared.
      { label: "Share", run: () => { statistics.setEnabled(true); statistics.record("human_prompt_accepted"); } },
    ],
  });
}

export function StatisticsActivity({ statistics, actions, onPrompt }: {
  statistics: UsageStatistics;
  actions?: Pick<WorkbenchActions, "toast" | "openSettings">;
  onPrompt?: (listener: () => void) => () => void;
}) {
  const { release } = useClientEnvironment();
  useEffect(() => {
    const stop = statistics.start(release);
    const activity = (event: Event) => {
      if (event.isTrusted && document.visibilityState === "visible" && document.hasFocus()) statistics.record("workbench_used");
    };
    document.addEventListener("pointerdown", activity, true);
    document.addEventListener("keydown", activity, true);
    window.addEventListener("storage", statistics.refresh);
    return () => {
      document.removeEventListener("pointerdown", activity, true);
      document.removeEventListener("keydown", activity, true);
      window.removeEventListener("storage", statistics.refresh);
      stop();
    };
  }, [release, statistics]);
  useEffect(() => actions && onPrompt?.(() => askToShare(statistics, actions)), [actions, onPrompt, statistics]);
  return null;
}

const extension: DesktopExtension = {
  id: "tau.usage-statistics", name: "Usage statistics",
  activate(context) {
    const statistics = new UsageStatistics(getClientStorage());
    context.events.on("prompt-accepted", () => statistics.record("human_prompt_accepted"));
    const onPrompt = (listener: () => void) => context.events.on("prompt-accepted", listener);
    context.registerRegion({ id: "usage-statistics.activity", placement: "composer-above", profiles: ["desktop"], Component: ({ actions }: RegionProps) => <StatisticsActivity statistics={statistics} actions={actions} onPrompt={onPrompt} /> });
    // General's Privacy card (API 1.61.0); the page it had before opens General.
    context.registerSettingsSection({
      id: "usage-statistics.privacy", page: "general", card: "privacy", order: 10, profiles: ["desktop"], replaces: ["usage-statistics.settings"],
      rows: [{ id: "setting-share-usage-statistics", label: "Share usage statistics", keywords: ["privacy", "consent", "analytics", "telemetry", "Matomo", "active installations"] }],
      Component: () => <StatisticsSettings statistics={statistics} />,
    });
    return statistics.dispose;
  },
};

export default extension;
