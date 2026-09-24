import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLucideIcon, icons } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { decodeIconSet, encodeIconSet } from "./src/renderer/icon-set-codec";
import { iconSetModule, readLucideIcons } from "./vite.icon-set";

const render = (icon: ComponentType<{ className?: string }>) => renderToStaticMarkup(createElement(icon, { className: "extra" }));

describe("packIconSet", () => {
  it("decodes to lucide's icons, name for name and markup for markup", () => {
    // React's development build warns about the keyless list; production does not.
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const packed = decodeIconSet(encodeIconSet(readLucideIcons()), createLucideIcon);
    const lucide = icons as Record<string, ComponentType<{ className?: string }>>;

    expect(Object.keys(packed)).toEqual(Object.keys(lucide).sort((left, right) => (left < right ? -1 : 1)));
    for (const [name, icon] of Object.entries(packed)) expect(render(icon), name).toBe(render(lucide[name]!));
    expect(Object.isFrozen(packed)).toBe(true);
    expect(Object.prototype.toString.call(packed)).toBe("[object Module]");
    warn.mockRestore();
  });

  it("keeps every value exactly, including an element without attributes", () => {
    const set = {
      "two-shapes": [["path", { d: "M5 12h14" }], ["circle", { cx: "12", cy: "12", r: "10", fill: "currentColor" }]],
      bare: [["g", {}]],
    } as const;
    const created: [string, unknown][] = [];
    decodeIconSet(encodeIconSet(structuredClone(set) as never), (name, elements) => {
      created.push([name, elements]);
      return () => null;
    });
    expect(created).toEqual(Object.entries(set));
  });

  it("refuses a value that holds a separator", () => {
    expect(() => encodeIconSet({ odd: [["path", { d: "M0 0|h1" }]] })).toThrow(/odd/u);
  });

  it("builds a module that exports the decoded set", () => {
    const code = iconSetModule({ dot: [["circle", { r: "1" }]] });
    expect(code).toContain('import { createLucideIcon } from "lucide-react";');
    expect(code).toContain('export const icons = decodeIconSet("circle/r#dot#01", createLucideIcon);');
  });
});
