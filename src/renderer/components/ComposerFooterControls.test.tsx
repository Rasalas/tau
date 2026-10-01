// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerFooterControls, type FooterBlock } from "./ComposerFooterControls";

// jsdom lays nothing out: a labelled chip is 100 px, its icon 13 px, the overflow trigger 29 px, no gaps, and the row as wide as `available`.
let available = 400;
const rect = (width: number) => ({ width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const iconOnly = this.closest("[data-icon-only]") !== null;
    if (this.dataset.composerOverflow !== undefined) return rect(29);
    // Only a chip with an icon shrinks to it; a text-only one keeps its label.
    if (this.dataset.composerBlock !== undefined || this.classList.contains("runtime-chip")) return rect(iconOnly && this.querySelector("svg") ? 13 : 100);
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

  it("keeps the menu trigger for its own entries, and folds the lowest rank into it first", () => {
    available = 700;
    const ranked: FooterBlock[] = [
      { id: "reasoning", rank: 3, node: <button type="button" className="runtime-chip">Medium</button> },
      { id: "kit", node: chip("Kit", "kit.open") },
      { id: "context", end: true, rank: 2, node: <button type="button" className="runtime-chip">Ring</button>, menuNode: <button type="button">Compact context</button> },
      { id: "attach", end: true, rank: 1, node: <button type="button" className="runtime-chip">Clip</button>, menuNode: <button type="button">Attach files</button> },
    ];
    const Row = ({ revision }: { revision: string }) => (
      <ComposerFooterControls revision={revision} leading={<button type="button" className="runtime-chip">Model</button>} blocks={ranked} menu={<button type="button">Access</button>} menuShortcuts={["composer.mode"]} />
    );
    const view = render(<Row revision="a" />);
    // Row order: model, reasoning, kit, the menu, then the end blocks.
    const row = document.querySelector(".composer-chips")!;
    expect([...row.children].map((child) => (child as HTMLElement).dataset.composerBlock ?? ((child as HTMLElement).dataset.composerOverflow !== undefined ? "menu" : "lead")))
      .toEqual(["lead", "reasoning", "kit", "menu", "context", "attach"]);
    const trigger = screen.getByLabelText("More composer controls");
    expect(trigger.dataset.composerShortcut).toBe("composer.mode");

    // Model 100, menu 29 and reasoning 100 stay; the kit goes first, then attach, then context.
    available = 250;
    view.rerender(<Row revision="b" />);
    expect(block("kit")).toBeNull();
    expect(block("attach")).toBeNull();
    expect(block("context")).toBeNull();
    expect(block("reasoning")).not.toBeNull();
    expect(trigger.dataset.composerShortcut).toBe("composer.mode kit.open");
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Kit", "Compact context", "Attach files", "Access"]);
  });

  it("never folds a pinned block, however narrow the row gets", () => {
    available = 400;
    const pinned: FooterBlock[] = [
      { id: "reasoning", pinned: true, node: <button type="button" className="runtime-chip">High · 1M</button> },
      { id: "kit", node: chip("Kit", "kit.open") },
    ];
    const Row = ({ revision }: { revision: string }) => <ComposerFooterControls revision={revision} leading={<button type="button" className="runtime-chip">Model</button>} blocks={pinned} />;
    const view = render(<Row revision="a" />);
    available = 60;
    view.rerender(<Row revision="b" />);
    expect(block("reasoning")).not.toBeNull();
    expect(block("kit")).toBeNull();
    expect(screen.getByLabelText("More composer controls")).toBeTruthy();
  });

  it("keeps a menu-only block in the menu at any width, before the menu's own entries", () => {
    available = 900;
    render(<ComposerFooterControls revision="a" leading={null} blocks={[
      { id: "reasoning", node: <button type="button" className="runtime-chip">Medium</button> },
      { id: "attach", menuOnly: true, node: <button type="button">Attach files</button> },
    ]} />);
    expect(block("attach")).toBeNull();
    fireEvent.click(screen.getByLabelText("More composer controls"));
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Attach files"]);
  });

  it("never reduces a text-only chip to nothing", () => {
    available = 400;
    const view = render(<ComposerFooterControls revision="a" leading={null} blocks={[{ id: "reasoning", node: <button type="button" className="runtime-chip">Medium</button> }]} />);
    available = 110;
    view.rerender(<ComposerFooterControls revision="b" leading={null} blocks={[{ id: "reasoning", node: <button type="button" className="runtime-chip">Medium</button> }]} />);
    expect(block("reasoning")?.textContent).toBe("Medium");
  });
});
