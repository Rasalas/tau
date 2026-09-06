import { PanelRight } from "lucide-react";
import type { ComponentType } from "react";

/** What a contribution passes as its icon: any component taking a pixel size. */
export type PanelIconComponent = ComponentType<{ size?: number }>;

/**
 * The glyph of a panel or a settings page. The contribution brings its own
 * component — `lucide-react` is a shared module, so a package draws from the
 * same set the workbench does — and core only decides the size and what an
 * icon-less contribution gets.
 */
export function PanelIcon({ Icon, size = 15 }: { Icon?: PanelIconComponent; size?: number }) {
  const Component = Icon ?? PanelRight;
  return <Component size={size} />;
}
