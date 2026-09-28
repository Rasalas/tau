import type { TurnStat } from "./protocol.js";

export function diffStatLabel(stat: TurnStat): string {
  return `+${stat.added} −${stat.removed}`;
}
