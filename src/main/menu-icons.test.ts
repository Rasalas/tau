import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, icons } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { MENU_ICONS } from "./menu-icon-set.js";
import { iconLines, menuIconBitmap, menuIconImage } from "./menu-icons.js";

const inner = (markup: string) => markup.replace(/^<svg[^>]*>/u, "").replace(/<\/svg>$/u, "");
const alpha = (bitmap: Buffer, size: number, x: number, y: number) => bitmap[(y * size + x) * 4 + 3];

describe("menu icons", () => {
  it("are lucide's icons, name for name and shape for shape", () => {
    const lucide = icons as Record<string, ComponentType>;
    for (const [name, node] of Object.entries(MENU_ICONS)) {
      expect(lucide[name], name).toBeDefined();
      expect(inner(renderToStaticMarkup(createElement(Icon, { iconNode: node.map(([tag, attributes], key) => [tag, { ...attributes, key }]) as never }))), name)
        .toBe(inner(renderToStaticMarkup(createElement(lucide[name]!))));
    }
  });

  it("draws every icon without a path it cannot read", () => {
    for (const name of Object.keys(MENU_ICONS)) {
      const bitmap = menuIconBitmap(name, 16)!;
      expect(bitmap.length).toBe(16 * 16 * 4);
      expect(bitmap.some((value, index) => index % 4 === 3 && value > 0), name).toBe(true);
    }
  });

  it("strokes 2 units wide, on the grid, in the colour asked for", () => {
    // Hash: horizontal strokes at y 9 and 15 from x 4 to 20; at 24 px a unit is a pixel.
    const bitmap = menuIconBitmap("Hash", 24, [0x10, 0x20, 0x30])!;
    expect(alpha(bitmap, 24, 12, 8)).toBe(255);
    expect(alpha(bitmap, 24, 12, 9)).toBe(255);
    expect(alpha(bitmap, 24, 12, 12)).toBe(0);
    expect(alpha(bitmap, 24, 1, 9)).toBe(0);
    const offset = (8 * 24 + 12) * 4;
    expect([...bitmap.subarray(offset, offset + 4)]).toEqual([0x30, 0x20, 0x10, 255]);
  });

  it("follows arcs and rounded corners", () => {
    const [half] = iconLines([["path", { d: "M0 5a5 5 0 0 1 10 0" }]]);
    for (const [x, y] of half!) expect(Math.hypot(x - 5, y - 5)).toBeCloseTo(5, 5);
    expect(half!.at(-1)![0]).toBeCloseTo(10, 5);
    const [corner] = iconLines([["rect", { x: "2", y: "2", width: "10", height: "10", rx: "2" }]]);
    expect(corner!.every(([x, y]) => x >= 2 - 1e-9 && x <= 12 + 1e-9 && y >= 2 - 1e-9 && y <= 12 + 1e-9)).toBe(true);
    expect(corner!.some(([x, y]) => x === 2 && y === 2)).toBe(false);
  });

  it("knows no icon it was not given", () => {
    expect(menuIconBitmap("NoSuchIcon", 16)).toBeUndefined();
    expect(menuIconBitmap("constructor", 16)).toBeUndefined();
  });

  it("makes a 16-point template image with both scales", () => {
    const image = { addRepresentation: vi.fn(), setTemplateImage: vi.fn() };
    const createFromBitmap = vi.fn(() => image as never);
    expect(menuIconImage({ createFromBitmap }, "Pencil")).toBe(image);
    expect(createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), { width: 32, height: 32, scaleFactor: 2 });
    expect(image.addRepresentation).toHaveBeenCalledWith(expect.objectContaining({ scaleFactor: 1, width: 16, height: 16 }));
    expect(image.setTemplateImage).toHaveBeenCalledWith(true);
    expect(menuIconImage({ createFromBitmap }, "NoSuchIcon")).toBeUndefined();
  });
});
