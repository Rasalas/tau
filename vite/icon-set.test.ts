import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Check, createLucideIcon, icons } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { decodeIconSet, encodeIconSet } from "../src/renderer/icon-set-codec";
import { aliases as sourceAliases } from "../src/renderer/icon-set";
import { iconSetModule, readLucideAliases, readLucideIcons, readSourceIconFiles } from "./icon-set";

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

  it("takes bundled icons from their own modules, names and older names kept", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lucideIcons = readLucideIcons();
    const { icons: packed, aliases } = decodeIconSet(encodeIconSet(lucideIcons, readLucideAliases(lucideIcons), new Set(["check", "x"])), createLucideIcon, [Check, icons.X]);
    expect(packed.Check).toBe(Check);
    expect(packed.X).toBe(icons.X);
    expect(render(packed.CheckCheck!)).toBe(render(icons.CheckCheck));
    expect(Object.keys(packed)).toHaveLength(Object.keys(icons).length);
    expect(Object.keys(aliases).sort()).toEqual(Object.keys(sourceAliases).sort());
    warn.mockRestore();
  });

  it("refuses an unbundled icon without elements, which would read as bundled", () => {
    expect(() => encodeIconSet({ empty: [] })).toThrow(/empty/u);
    expect(encodeIconSet({ empty: [] }, {}, new Set(["empty"]))).toBe("#empty#");
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
    const code = iconSetModule({ dot: [["circle", { r: "1" }]] }, { dot: ["Point"] }, new Set());
    expect(code).toContain('import { createLucideIcon } from "lucide-react";');
    expect(code).toContain('export const { icons, aliases } = decodeIconSet("circle/r#dot,Point#01", createLucideIcon, []);');
  });

  it("imports the bundled icons by their own names, in the set's order", () => {
    const code = iconSetModule({ x: [["path", { d: "M18 6 6 18" }]], check: [["path", { d: "M20 6 9 17l-5-5" }]], dot: [["circle", { r: "1" }]] }, {}, new Set(["check", "x"]));
    expect(code).toContain('import { createLucideIcon, X, Check } from "lucide-react";');
    expect(code).toContain('decodeIconSet("circle/r#x|check|dot#||01", createLucideIcon, [X, Check]);');
  });
});

describe("readSourceIconFiles", () => {
  it("reads named lucide imports from sources, tests and type-only names left out", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-icons-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.tsx"), 'import { Check, type LucideIcon, Icon } from "lucide-react";\nimport type { LucideProps } from "lucide-react";');
    writeFileSync(join(root, "nested", "b.ts"), 'import {\n  ArrowLeft as Back,\n  XIcon,\n} from "lucide-react";');
    writeFileSync(join(root, "a.test.tsx"), 'import { Plus } from "lucide-react";');
    try {
      expect(readSourceIconFiles([root])).toEqual(new Set(["check", "arrow-left", "x"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
