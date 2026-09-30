import type { PanelContribution } from "../extension-system";

/** Fixed tools first, then open tools in registry order. The front tool wins when space runs out. */
export function stageToolLayout(panels: readonly PanelContribution[], opened: ReadonlySet<string>, shown: ReadonlySet<string>, slots = Infinity) {
  const candidates = [...panels.filter((panel) => panel.stageButton), ...panels.filter((panel) => !panel.stageButton && opened.has(panel.id))];
  const needsOverflow = candidates.length < panels.length || candidates.length > slots;
  const count = Math.max(0, slots - (needsOverflow ? 1 : 0));
  const priority = [...candidates.filter((panel) => shown.has(panel.id)), ...candidates.filter((panel) => !shown.has(panel.id))];
  const selected = new Set(priority.slice(0, count).map((panel) => panel.id));
  return { buttons: candidates.filter((panel) => selected.has(panel.id)), rest: panels.filter((panel) => !selected.has(panel.id)) };
}
