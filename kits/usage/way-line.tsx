import { useSyncExternalStore } from "react";
import type { UiModel } from "tau";
import type { JuicebarChoices } from "./juicebar-choices.js";
import { juicebarGroups } from "./juicebars.js";
import type { LimitsFeed } from "./limits-feed.js";
import type { UsageLimitsSummary } from "./protocol.js";
import { PI_BACKEND } from "./protocol.js";

/** An instance of a runtime (`codex@work`) belongs to its family's account. */
const family = (runtime: string): string => runtime.split("@")[0]!;

/**
 * What the plan behind a way has left, for "Runs with" in the model picker:
 * the windows the sidebar's bars draw, "5-hour 42% left, Weekly 65% left".
 * Pi's accounts are per provider; another runtime's is its own.
 */
export function planLeft(limits: UsageLimitsSummary | undefined, choices: Readonly<Record<string, boolean>>, runtime: string, model: Pick<UiModel, "provider">, now: number): string | undefined {
  const group = juicebarGroups(limits, choices, now).find((entry) => entry.group.members.some((account) => account.runtime === PI_BACKEND
    ? runtime === PI_BACKEND && account.id === `pi:${model.provider}`
    : family(account.runtime) === family(runtime)));
  if (!group) return undefined;
  return group.bars.map((bar) => `${bar.window.label} ${bar.state.kind === "expired" ? "reset" : `${bar.left}% left`}`).join(", ");
}

/** The picker's line after the model's facts; empty until the limits are read, or where the way has no plan. */
export function createWayLine(feed: LimitsFeed, choices: JuicebarChoices) {
  return function WayLine({ model, runtime }: { model: UiModel; runtime: string }) {
    const limits = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
    const chosen = useSyncExternalStore(choices.subscribe, choices.getSnapshot);
    const text = planLeft(limits, chosen, runtime, model, Date.now());
    return text ? <> · {text}</> : null;
  };
}
