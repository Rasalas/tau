import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ProviderIconStack, type RegionProps } from "tau";
import { juicebarGroups, type JuicebarChoices, type JuicebarGroup, type JuicebarLevel } from "./juicebars.js";
import { tone, titleOf, useRunEnded } from "./juicebars-view.js";
import { providerMark } from "./limits.js";
import type { LimitsFeed } from "./limits-feed.js";
import { USAGE_PAGE } from "./protocol.js";

/** The account's worst bar decides its number's colour: spent, then low, then an old reading. */
function worst(entry: JuicebarGroup): { left: number; level?: JuicebarLevel } {
  const left = Math.min(...entry.bars.map((bar) => bar.left));
  const levels = entry.bars.map((bar) => bar.level);
  const level = (["fail", "warn"] as const).find((candidate) => levels.includes(candidate)) ?? (levels.every((each) => each === "stale") ? "stale" : undefined);
  return { left, ...(level ? { level } : {}) };
}

/**
 * The juicebars on top of a phone's thread list (K106): the bars and choice
 * of the desktop sidebar's foot, every account once across the paired hosts,
 * each with its mark and what its lowest shown window has left. A tap opens
 * Usage at its limits, where each plan chooses its bars. Nothing while no
 * plan has a window to show.
 */
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
      {groups.map((entry) => {
        const { left, level } = worst(entry);
        return (
          <span key={entry.group.key} className="usage-juicestrip-group" data-level={level} style={tone(entry)}>
            <ProviderIconStack {...providerMark(entry.group)} hint={false} />
            <span>
              {entry.bars.map((bar) => <i key={bar.window.id} className="usage-juicebar" data-level={bar.level} style={{ "--usage-left": `${bar.left}%` } as CSSProperties} />)}
            </span>
            <b>{left}%</b>
          </span>
        );
      })}
    </button>
  );
}
