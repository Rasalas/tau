import type { IconNode } from "lucide-react";
import type { ComponentType } from "react";

type IconFactory = (name: string, elements: IconNode) => ComponentType & { displayName?: string };

/** An icon's older names, by the icon's file name. */
export type IconAliases = Record<string, readonly string[]>;

export interface DecodedIconSet {
  /** Frozen namespace keyed by each component's `displayName`, like lucide's `icons`. */
  icons: Record<string, ComponentType>;
  /** Older names lucide still exports, each bound to its icon's component. */
  aliases: Record<string, ComponentType>;
}

// Sections are split by "#", icons by "|", elements by ";", attribute values by "/"; an icon's names by ",".
const SEPARATORS = /[#|;/]/u;
const NAME_SEPARATORS = /[#|;/,]/u;

function fail(name: string): never {
  throw new Error(`icon ${name} cannot be packed`);
}

/**
 * Packs icon element lists into one string: the distinct tag and attribute-name
 * combinations, the icon names each with its older names, then per icon and
 * element the combination's index and the attribute values. Names and elements
 * apart compress better. An icon in `bundled` keeps its names but no elements:
 * the decoder gets its component from the bundle.
 */
export function encodeIconSet(icons: Record<string, IconNode>, aliases: IconAliases = {}, bundled: ReadonlySet<string> = new Set()): string {
  const shapes: string[] = [];
  const names = Object.keys(icons).map((name) => {
    const older = aliases[name] ?? [];
    if ([name, ...older].some((entry) => NAME_SEPARATORS.test(entry))) fail(name);
    return [name, ...older].join(",");
  });
  const bodies = Object.entries(icons).map(([name, elements]) => {
    if (bundled.has(name)) return "";
    // An empty list stands for a bundled icon.
    if (elements.length === 0) fail(name);
    return elements.map(([tag, attributes]) => {
      const shape = [tag, ...Object.keys(attributes)].join("/");
      let index = shapes.indexOf(shape);
      if (index < 0) index = shapes.push(shape) - 1;
      const values = Object.values(attributes);
      if (index >= 36 || values.some((value) => SEPARATORS.test(value))) fail(name);
      return index.toString(36) + values.join("/");
    }).join(";");
  });
  return [shapes.join(";"), names.join("|"), bodies.join("|")].join("#");
}

/** The inverse of `encodeIconSet`; `bundled` holds the bundled icons' components in the set's order. */
export function decodeIconSet(data: string, create: IconFactory, bundled: readonly ComponentType[] = []): DecodedIconSet {
  const [header = "", names = "", bodies = ""] = data.split("#");
  const shapes = header.split(";").map((shape) => shape.split("/"));
  const icons: Record<string, ComponentType> = {};
  const aliases: Record<string, ComponentType> = {};
  const elementLists = bodies.split("|");
  const element = (packed: string): IconNode[number] => {
    const [tag = "", ...attributes] = shapes[Number.parseInt(packed[0]!, 36)]!;
    const values = packed.slice(1).split("/");
    return [tag as IconNode[number][0], Object.fromEntries(attributes.map((attribute, index) => [attribute, values[index]!]))];
  };
  let next = 0;
  names.split("|").forEach((entry, icon) => {
    const [name = "", ...older] = entry.split(",");
    const list = elementLists[icon];
    const component = list ? create(name, list.split(";").map(element)) : bundled[next++]!;
    icons[component.displayName ?? name] = component;
    for (const alias of older) aliases[alias] = component;
  });
  // Like the ES namespace it replaces: code-unit order, no prototype, tagged "Module".
  const namespace = Object.create(null) as Record<string, ComponentType>;
  for (const name of Object.keys(icons).sort((left, right) => (left < right ? -1 : 1))) namespace[name] = icons[name]!;
  return { icons: Object.freeze(Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" })), aliases };
}
