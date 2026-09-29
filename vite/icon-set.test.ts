import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLucideIcon, icons } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { decodeIconSet, encodeIconSet } from "../src/renderer/icon-set-codec";
import { aliases as sourceAliases } from "../src/renderer/icon-set";
import { iconSetModule, readLucideAliases, readLucideIcons } from "./icon-set";

const render = (icon: ComponentType<{ className?: string }>) => renderToStaticMarkup(createElement(icon, { className: "extra" }));

describe("packIconSet", () => {
  it("decodes to lucide's icons, name for name and markup for markup", () => {
    // React's development build warns about the keyless list; production does not.
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lucideIcons = readLucideIcons();
    const { icons: packed, aliases } = decodeIconSet(encodeIconSet(lucideIcons, readLucideAliases(lucideIcons)), createLucideIcon);
    const lucide = icons as Record<string, ComponentType<{ className?: string }>>;

    expect(Object.keys(packed)).toEqual(Object.keys(lucide).sort((left, right) => (left < right ? -1 : 1)));
    for (const [name, icon] of Object.entries(packed)) expect(render(icon), name).toBe(render(lucide[name]!));
    expect(Object.isFrozen(packed)).toBe(true);
    expect(Object.prototype.toString.call(packed)).toBe("[object Module]");
    // The older names, each drawing its icon, as the source module derives them from lucide's entry.
    expect(Object.keys(aliases).sort()).toEqual(Object.keys(sourceAliases).sort());
    for (const [name, icon] of Object.entries(aliases)) expect(render(icon), name).toBe(render(sourceAliases[name] as ComponentType<{ className?: string }>));
    warn.mockRestore();
  });

  it("keeps every value exactly, including an element without attributes", () => {
    const set = {
      "two-shapes": [["path", { d: "M5 12h14" }], ["circle", { cx: "12", cy: "12", r: "10", fill: "currentColor" }]],
      bare: [["g", {}]],
    } as const;
    const created: [string, unknown][] = [];
    const { aliases } = decodeIconSet(encodeIconSet(structuredClone(set) as never, { bare: ["Empty", "Blank"] }), (name, elements) => {
      created.push([name, elements]);
      return () => null;
    });
    expect(created).toEqual(Object.entries(set));
    expect(Object.keys(aliases)).toEqual(["Empty", "Blank"]);
  });

  it("refuses a value that holds a separator", () => {
    expect(() => encodeIconSet({ odd: [["path", { d: "M0 0|h1" }]] })).toThrow(/odd/u);
  });

  it("builds a module that exports the decoded set", () => {
    const code = iconSetModule({ dot: [["circle", { r: "1" }]] }, { dot: ["Point"] });
    expect(code).toContain('import { createLucideIcon } from "lucide-react";');
    expect(code).toContain('export const { icons, aliases } = decodeIconSet("circle/r#dot,Point#01", createLucideIcon);');
  });
});
