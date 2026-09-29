import { Icon, LucideProvider, createLucideIcon, useLucideContext } from "lucide-react";
import { aliases, icons } from "./icon-set";

/**
 * The names and values of `import("lucide-react")`, built at run time. The
 * namespace import made the icon chunk export some 6,000 names, a fifth of
 * its gzip size; every icon here is also `<name>Icon` and `Lucide<name>`.
 */
export function sharedIconModule(): Record<string, unknown> {
  const names: Record<string, unknown> = { Icon, LucideProvider, createLucideIcon, icons, useLucideContext };
  const add = (name: string, value: unknown) => {
    names[name] = value;
    names[`${name}Icon`] = value;
    names[`Lucide${name}`] = value;
  };
  for (const [name, value] of Object.entries(icons)) add(name, value);
  for (const [name, value] of Object.entries(aliases)) add(name, value);
  // A module namespace lists its names in code-unit order.
  const sorted = Object.keys(names).sort((left, right) => (left < right ? -1 : 1));
  return Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, Object.fromEntries(sorted.map((name) => [name, names[name]]))));
}
