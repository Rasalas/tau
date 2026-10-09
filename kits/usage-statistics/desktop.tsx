import { useEffect, useSyncExternalStore } from "react";
import { BarChart3 } from "lucide-react";
import { getClientStorage, SettingRow, SettingsSection, Switch, useClientEnvironment, type DesktopExtension } from "tau";
import { UsageStatistics } from "./statistics.js";

export function StatisticsSettings({ statistics }: { statistics: UsageStatistics }) {
  const { enabled, id, error } = useSyncExternalStore(statistics.subscribe, statistics.getSnapshot);
  const { release } = useClientEnvironment();
  return <div className="settings-page">
    <SettingsSection title="This device">
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
    </SettingsSection>
  </div>;
}

export function StatisticsActivity({ statistics }: { statistics: UsageStatistics }) {
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
  return null;
}

const extension: DesktopExtension = {
  id: "tau.usage-statistics", name: "Usage statistics",
  activate(context) {
    const statistics = new UsageStatistics(getClientStorage());
    context.events.on("prompt-accepted", () => statistics.record("human_prompt_accepted"));
    context.registerRegion({ id: "usage-statistics.activity", placement: "composer-above", profiles: ["desktop"], Component: () => <StatisticsActivity statistics={statistics} /> });
    context.registerSettingsPage({
      id: "usage-statistics.settings", label: "Usage statistics", Icon: BarChart3, group: "general", order: 55, profiles: ["desktop"],
      description: "Choose whether this device helps count active Tau installations.", keywords: ["privacy", "analytics", "telemetry", "Matomo"],
      rows: [{ id: "setting-share-usage-statistics", label: "Share usage statistics", keywords: ["consent", "privacy", "active installations"] }],
      Component: () => <StatisticsSettings statistics={statistics} />,
    });
    return statistics.dispose;
  },
};

export default extension;
