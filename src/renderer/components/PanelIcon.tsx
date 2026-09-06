import { Activity, Files, GitCompare, Globe, PanelRight } from "lucide-react";

/** Panels name an icon; unknown names fall back rather than rendering a stray glyph. */
const ICONS = { files: Files, changes: GitCompare, signals: Activity, preview: Globe } as const;

export function PanelIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Component = ICONS[name as keyof typeof ICONS] ?? PanelRight;
  return <Component size={size} />;
}
