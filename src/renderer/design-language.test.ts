import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom lays nothing out and applies no stylesheet, so the rules are read from the files.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const STYLES = read("./styles.css");
const WORKSPACE = read("../../kits/workspace/styles.css");
const RELOAD_CURTAIN = read("./components/reload-curtain.css");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

describe("the workbench design language", () => {
  it("fills the composer and leaves it without an edge or a shadow", () => {
    const frame = rule(STYLES, ".composer-frame");
    expect(frame).toMatch(/background: var\(--field\)/u);
    expect(frame).toMatch(/border: 1px solid transparent/u);
    expect(frame).not.toMatch(/box-shadow/u);
    expect(rule(STYLES, ".composer-frame:focus-within")).toMatch(/border-color: transparent/u);
  });

  it("sends with a round button in the accent", () => {
    const send = rule(STYLES, ".send-button");
    expect(send).toMatch(/border-radius: 50%/u);
    expect(send).toMatch(/background: var\(--acid\)/u);
    expect(send).toMatch(/color: var\(--acid-ink\)/u);
    // With nothing to send it rests, still in the accent; stop beside it is quiet, never a second filled button.
    expect(rule(STYLES, ".send-button:disabled")).toMatch(/background: color-mix\(in srgb, var\(--acid\)/u);
    expect(rule(STYLES, ".send-button.stop")).toMatch(/background: transparent/u);
  });

  it("keeps the model quiet until hovered", () => {
    const pill = rule(STYLES, ".runtime-chip.composer-model-chip");
    expect(pill).toMatch(/background: transparent/u);
    expect(rule(STYLES, ".runtime-chip.composer-model-chip:hover")).toMatch(/background: var\(--raised\)/u);
    expect(pill).toMatch(/border-radius: 6px/u);
  });

  it("tints the user's own message with the accent", () => {
    const bubble = rule(STYLES, ".message.user .message-text");
    expect(bubble).toMatch(/background: var\(--user-bubble\)/u);
    expect(bubble).toMatch(/color: var\(--user-bubble-ink\)/u);
  });

  it("gives the rail a filled search field and a plus beside it", () => {
    expect(rule(WORKSPACE, ".thread-search")).toMatch(/background: var\(--stage\)/u);
    expect(rule(WORKSPACE, ".thread-search-row > .sidebar-action.new-thread")).toMatch(/background: var\(--stage\)/u);
    expect(rule(WORKSPACE, ".session-rail")).not.toMatch(/border/u);
  });

  it("draws every card dialog without an edge, its answers in a bar with pill actions (1v)", () => {
    expect(rule(STYLES, ".confirm-dialog")).not.toMatch(/border:/u);
    expect(rule(STYLES, ".confirm-dialog > footer, .confirm-dialog > form > footer")).toMatch(/margin: 4px -18px -18px/u);
    expect(rule(STYLES, '.confirm-dialog footer :is(.primary, .danger, [data-variant="primary"], [data-variant="danger"])')).toMatch(/border-radius: 99px/u);
  });

  it("keeps the tool steps' fold and only restyles the box they open into", () => {
    const detail = rule(STYLES, ".tool-activity-detail");
    expect(detail).toMatch(/background: var\(--code-bg\)/u);
    expect(detail).toMatch(/border: 1px solid transparent/u);
  });

  it("draws Tau's splash in the mark's lime, never in the accent", () => {
    const start = RELOAD_CURTAIN.indexOf(".reload-curtain {");
    const curtain = RELOAD_CURTAIN.slice(start, RELOAD_CURTAIN.indexOf("@keyframes reload-orbit", start));
    expect(curtain).toMatch(/var\(--brand\)/u);
    expect(curtain).not.toMatch(/var\(--acid/u);
  });
});

describe("a run in flight is blue (K70)", () => {
  it.each([
    [STYLES, ".spinner", "--info"],
    [read("./components/thread-tree.css"), ".thread-tree-node > small", "--info-ink"],
    [read("../../kits/terminal/styles.css"), ".terminal-row-status", "--info-ink"],
    [read("../../kits/remote-work/styles.css"), ".remote-work-step.running", "--info-ink"],
    [WORKSPACE, ".turn-changes-live", "--info"],
  ])("%#: %s", (css, selector, token) => {
    const declarations = rule(css, selector);
    expect(declarations).toContain(`var(${token})`);
    expect(declarations).not.toContain("var(--working)");
  });

  it("shows a sub-agent that waits on the user in the question's amber", () => {
    expect(rule(STYLES, ".activity-disclosure.attention > button")).toMatch(/color: var\(--warn\)/u);
  });
});

describe("one content frame for the conversation", () => {
  const REVIEW = read("../../kits/review/styles.css");

  it("sets its width and inset once, on the column, from the column's own width", () => {
    const column = rule(STYLES, ".conversation-column");
    expect(column).toMatch(/--content-max: 780px/u);
    expect(column).toMatch(/--content-inset: clamp\(12px, \(100% - 560px\) \* 1000, 32px\)/u);
    expect(column).toMatch(/--composer-inset: max\(var\(--content-inset\), calc\(\(100% - var\(--content-max\)\) \/ 2\)\)/u);
    // No window-width rule decides the conversation's inset any more.
    expect(STYLES).not.toMatch(/@media[^{]*\{\s*\.conversation-column \{ --composer-inset/u);
  });

  it("gives transcript, composer and the docked cards that frame instead of a width of their own", () => {
    for (const selector of [".transcript-inner", ".composer-surface", ".extension-prompt", ".prompt-arrival-note"]) {
      expect(rule(STYLES, selector), selector).toMatch(/max-width: var\(--content-max\)/u);
    }
    expect(rule(STYLES, ".composer-zone")).toMatch(/padding: 14px var\(--content-inset\) 16px/u);
    expect(STYLES).toMatch(/scrollbar-gutter: stable both-edges/u);
    // Touch draws no bar and reserves none, or the transcript would sit 8 px inside the composer on a phone.
    expect(STYLES).toMatch(/@media \(pointer: coarse\) \{[^}]*--scrollbar-lane: 0px;[^}]*\}\s*\.conversation-column \.transcript \{ scrollbar-gutter: auto; scrollbar-width: none; \}/u);
  });

  it("lets the pull request strip fill the region's frame, inset once", () => {
    const strip = rule(REVIEW, ".review-pr-strip");
    expect(strip).toMatch(/width: 100%/u);
    expect(strip).toMatch(/max-width: var\(--content-max, 780px\)/u);
    expect(REVIEW).not.toMatch(/calc\(100% - 64px\)/u);
  });
});

describe("a goal's pill keeps the run's colours", () => {
  it("is blue only while it runs, amber when it waits on the user, green only when confirmed", () => {
    expect(rule(STYLES, ".control-pill.goal-pill.running > svg")).toMatch(/var\(--info\)/u);
    expect(rule(STYLES, ".control-pill.goal-pill.waiting")).toMatch(/var\(--warn\)/u);
    expect(rule(STYLES, ".control-pill.goal-pill.done > svg")).toMatch(/var\(--done\)/u);
  });
});
