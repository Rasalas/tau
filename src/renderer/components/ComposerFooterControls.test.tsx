// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerFooterControls, type FooterBlock } from "./ComposerFooterControls";

// jsdom lays nothing out: a labelled chip is 100 px, its icon 13 px, the overflow trigger 29 px, and the row as wide as `available`.
let available = 400;
const rect = (width: number) => ({ width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const iconOnly = this.closest("[data-icon-only]") !== null;
    if (this.dataset.composerOverflow !== undefined) return rect(29);
    if (this.dataset.composerBlock !== undefined || this.classList.contains("runtime-chip")) return rect(iconOnly ? 13 : 100);
    return rect(0);
  });
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(13));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("composer-chips") ? available : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const chip = (label: string, shortcut: string) => (
  <button type="button" className="runtime-chip" data-composer-shortcut={shortcut}><svg />{label}</button>
);
const blocks: FooterBlock[] = [
  { id: "effort", node: chip("Effort", "composer.effort") },
  { id: "access", node: chip("Access", "composer.mode") },
];

function Footer({ revision }: { revision: string }) {
  return <ComposerFooterControls revision={revision} leading={<button type="button" className="runtime-chip">Model</button>} blocks={blocks} />;
}

const block = (id: string) => document.querySelector<HTMLElement>(`.composer-chips > [data-composer-block="${id}"]`);

describe("ComposerFooterControls", () => {
  it("keeps every label while the row has room", () => {
    available = 400;
    render(<Footer revision="a" />);
    expect(block("effort")?.dataset.iconOnly).toBeUndefined();
    expect(block("access")?.dataset.iconOnly).toBeUndefined();
    expect(screen.queryByLabelText("More composer controls")).toBeNull();
  });

  it("drops the last block's label first, then the next one's", () => {
    available = 400;
    const view = render(<Footer revision="a" />);
    available = 250;
    view.rerender(<Footer revision="b" />);
    expect(block("effort")?.dataset.iconOnly).toBeUndefined();
    expect(block("access")?.dataset.iconOnly).toBe("");
    available = 150;
    view.rerender(<Footer revision="c" />);
    expect(block("effort")?.dataset.iconOnly).toBe("");
    expect(block("access")?.dataset.iconOnly).toBe("");
  });

  it("then moves the last block into the overflow menu, whose trigger answers to its shortcut", () => {
    available = 400;
    const view = render(<Footer revision="a" />);
    available = 145;
    view.rerender(<Footer revision="b" />);
    expect(block("access")).toBeNull();
    const trigger = screen.getByLabelText("More composer controls");
    expect(document.querySelector('[data-composer-shortcut~="composer.mode"]')).toBe(trigger);
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", { name: "More composer controls" });
    expect(popover.textContent).toContain("Access");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "More composer controls" })).toBeNull();
  });

  it("brings the blocks back with their labels once the row is wide again", () => {
    available = 400;
    const view = render(<Footer revision="a" />);
    available = 100;
    view.rerender(<Footer revision="b" />);
    expect(block("effort")).toBeNull();
    expect(block("access")).toBeNull();
    available = 400;
    view.rerender(<Footer revision="c" />);
    expect(block("effort")?.dataset.iconOnly).toBeUndefined();
    expect(block("access")?.dataset.iconOnly).toBeUndefined();
    expect(screen.queryByLabelText("More composer controls")).toBeNull();
  });
});
