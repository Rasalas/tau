import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { type RegionProps } from "tau";
import type { JuicebarChoices } from "./juicebar-choices.js";
import { juicebarGroups } from "./juicebars.js";
import { tone, titleOf, useRunEnded } from "./juicebars-view.js";
import type { LimitsFeed } from "./limits-feed.js";
import { USAGE_PAGE } from "./protocol.js";

/** Compact plan bars beside a phone's thread-list title. A tap opens Usage. */
export function JuicebarStrip({ actions, feed, choices }: Pick<RegionProps, "actions"> & { feed: LimitsFeed; choices: JuicebarChoices }) {
  const limits = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const chosen = useSyncExternalStore(choices.subscribe, choices.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  useRunEnded(feed);
  const groups = juicebarGroups(limits, chosen, now);
  if (groups.length === 0) return null;
  const label = `Plan limits, ${groups.map((entry) => `${titleOf(entry)}: ${entry.bars.map((bar) => `${bar.window.label} ${bar.state.kind === "expired" ? "reset" : `${bar.left}% left`}`).join(", ")}`).join("; ")}. Opens Usage.`;
  return (
    <button type="button" className="usage-juicestrip" aria-label={label} onClick={() => actions.openPage?.(USAGE_PAGE, { section: "limits" })}>
      {groups.map((entry) => (
        <span key={entry.group.key} className="usage-juicebar-group" style={tone(entry)}>
          {entry.bars.map((bar) => <i key={bar.window.id} className="usage-juicebar" data-level={bar.level} style={{ "--usage-left": `${bar.left}%` } as CSSProperties} />)}
        </span>
      ))}
    </button>
  );
}
