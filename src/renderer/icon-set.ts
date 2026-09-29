// Production builds replace this module with a packed copy of the set (`vite.icon-set.ts`).
import type { ComponentType } from "react";
import * as lucide from "lucide-react";
import { icons } from "lucide-react";

export { icons };

/** Older names lucide still exports, each bound to its icon's component. */
export const aliases: Record<string, ComponentType> = (() => {
  const own = new Map<unknown, string>(Object.entries(icons).map(([name, icon]) => [icon, name]));
  const older: Record<string, ComponentType> = {};
  for (const [name, value] of Object.entries(lucide)) {
    const icon = own.get(value);
    if (icon !== undefined && name !== icon && !name.startsWith("Lucide") && !name.endsWith("Icon")) older[name] = value as ComponentType;
  }
  return older;
})();
