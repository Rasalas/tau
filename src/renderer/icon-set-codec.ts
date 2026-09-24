import type { IconNode } from "lucide-react";
import type { ComponentType } from "react";

type IconFactory = (name: string, elements: IconNode) => ComponentType & { displayName?: string };

// Sections are split by "#", icons by "|", elements by ";", attribute values by "/".
const SEPARATORS = /[#|;/]/u;

/**
 * Packs icon element lists into one string: the distinct tag and attribute-name
 * combinations, the icon names, then per icon and element the combination's
 * index and the attribute values. Names and elements apart compress better.
 */
export function encodeIconSet(icons: Record<string, IconNode>): string {
  const shapes: string[] = [];
  const bodies = Object.entries(icons).map(([name, elements]) => {
    if (SEPARATORS.test(name)) throw new Error(`icon ${name} cannot be packed`);
    return elements.map(([tag, attributes]) => {
      const shape = [tag, ...Object.keys(attributes)].join("/");
      let index = shapes.indexOf(shape);
      if (index < 0) index = shapes.push(shape) - 1;
      const values = Object.values(attributes);
      if (index >= 36 || values.some((value) => SEPARATORS.test(value))) throw new Error(`icon ${name} cannot be packed`);
      return index.toString(36) + values.join("/");
    }).join(";");
  });
  return [shapes.join(";"), Object.keys(icons).join("|"), bodies.join("|")].join("#");
}

/** The inverse of `encodeIconSet`, as a frozen namespace keyed by each component's `displayName`. */
export function decodeIconSet(data: string, create: IconFactory): Record<string, ComponentType> {
  const [header = "", names = "", bodies = ""] = data.split("#");
  const shapes = header.split(";").map((shape) => shape.split("/"));
  const icons: Record<string, ComponentType> = {};
  const elementLists = bodies.split("|");
  const element = (packed: string): IconNode[number] => {
    const [tag = "", ...attributes] = shapes[Number.parseInt(packed[0]!, 36)]!;
    const values = packed.slice(1).split("/");
    return [tag as IconNode[number][0], Object.fromEntries(attributes.map((attribute, index) => [attribute, values[index]!]))];
  };
  names.split("|").forEach((name, icon) => {
    const list = elementLists[icon];
    const component = create(name, list ? list.split(";").map(element) : []);
    icons[component.displayName ?? name] = component;
  });
  // Like the ES namespace it replaces: code-unit order, no prototype, tagged "Module".
  const namespace = Object.create(null) as Record<string, ComponentType>;
  for (const name of Object.keys(icons).sort((left, right) => (left < right ? -1 : 1))) namespace[name] = icons[name]!;
  return Object.freeze(Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" }));
}
