import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { usePreferences } from "../renderer-services-context";
import { SegmentedControl, Switch } from "./controls";
import { SectionCard, type CardSection, type PlacedRow } from "./SectionCard";
import { SettingsPageSections } from "./page-sections";
import { SettingRow, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type WakeDelivery = "steer" | "queue";
const WAKE_LABELS: Record<WakeDelivery, string> = { steer: "Steer", queue: "Queue" };

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

/**
 * Settings → Threads: where a new thread starts, what the rail keeps in view,
 * what it asks first, and how a thread behaves while it runs and once it is
 * long. Cards of the rows kits add with `registerSettingsSection({ page:
 * "threads", card })` (and, for New threads and Threads, `page: "general"`),
 * and core's own: whether a restart continues a thread and how a wake reaches
 * a running turn.
 */
export function ThreadsPage({ sections = [], onNotify = () => undefined }: {
  sections?: readonly CardSection[];
  onNotify?(message: string, level?: "info" | "warning" | "error"): void;
}) {
  const preferences = usePreferences();
  const continueAfterRestart = useSetting<boolean>("threads.continueAfterRestart", {
    defaultValue: CONFIG_DEFAULTS["threads.continueAfterRestart"] as boolean, read: readBoolean, offline: (value) => preferences.setContinueThreadsAfterRestart(value),
  });
  const wakeDelivery = useSetting<WakeDelivery>("threads.wakeDelivery", {
    defaultValue: CONFIG_DEFAULTS["threads.wakeDelivery"] as WakeDelivery, read: (raw) => (raw === "steer" || raw === "queue" ? raw : undefined), format: (value) => WAKE_LABELS[value],
  });
  const own: PlacedRow[] = [
    {
      order: 50,
      node: <SettingRow
        key="continue"
        id={settingAnchor("Continue threads after restarts")}
        title="Continue threads after restarts"
        help="Pick a thread back up where a restart cut its turn short. Off, the thread is repaired and marked instead."
        setting={continueAfterRestart}
        control={<Switch label="Continue threads after restarts" checked={continueAfterRestart.value} onChange={continueAfterRestart.set} />}
      />,
    },
    {
      order: 60,
      node: <SettingRow
        key="wakes"
        id={settingAnchor("Wakes during a turn")}
        title="Wakes during a turn"
        help="A PR update or another wake arriving while the thread works. Steer sends it into the running turn; Queue waits for the turn, and its arrow still steers it in."
        setting={wakeDelivery}
        control={<SegmentedControl<WakeDelivery> label="Wakes during a turn" value={wakeDelivery.value} options={(["steer", "queue"] as const).map((value) => ({ value, label: WAKE_LABELS[value] }))} onChange={wakeDelivery.set} />}
      />,
    },
  ];
  return (
    <div className="settings-page settings-cards">
      <SectionCard title="New threads" card="new-threads" sections={sections} onNotify={onNotify} />
      <SectionCard title="Rail" card="rail" sections={sections} onNotify={onNotify} />
      <SectionCard title="Ask first" card="ask-first" sections={sections} onNotify={onNotify} />
      <SectionCard title="While a thread runs" card="running" own={own} sections={sections} onNotify={onNotify} />
      <SectionCard title="Long threads" card="long-threads" wide sections={sections} onNotify={onNotify} />
      {/* Where a package still fills the older card, it stays. */}
      <SectionCard title="Existing threads" card="threads" sections={sections} onNotify={onNotify} />
      <SettingsPageSections page="threads" onNotify={onNotify} />
    </div>
  );
}
