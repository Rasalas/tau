import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom lays nothing out, so the rules that keep the rows apart are read from the stylesheet.
const css = readFileSync(join(import.meta.dirname, "review-layout.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";

describe("Review side panel in a narrow stage", () => {
  it("lets the changed-files row wrap instead of letting its text spill over the next row", () => {
    const meta = rule(".review-sidebar-meta");
    expect(meta).toMatch(/flex-wrap: wrap/u);
    expect(meta).toMatch(/min-height: 27px/u);
    expect(meta).not.toMatch(/(?<!-)height: 27px/u);
    expect(rule(".review-sidebar-meta strong")).toMatch(/white-space: nowrap/u);
  });

  it("lets the staging row wrap and keeps Stage all on one line", () => {
    expect(rule(".review-staging")).toMatch(/flex-wrap: wrap/u);
    expect(rule(".review-staging > span")).toMatch(/white-space: nowrap/u);
    expect(rule(".review-staging .text-button")).toMatch(/white-space: nowrap/u);
  });
});
