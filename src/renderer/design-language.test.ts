import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom lays nothing out and applies no stylesheet, so the rules are read from the files.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const STYLES = read("./styles.css");
const WORKSPACE = read("../../kits/workspace/styles.css");

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

  it("draws the model as a filled pill", () => {
    const pill = rule(STYLES, ".runtime-chip.composer-model-chip");
    expect(pill).toMatch(/background: var\(--raised\)/u);
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

  it("keeps the tool steps' fold and only restyles the box they open into", () => {
    const detail = rule(STYLES, ".tool-activity-detail");
    expect(detail).toMatch(/background: var\(--code-bg\)/u);
    expect(detail).toMatch(/border: 1px solid transparent/u);
  });

  it("draws Tau's splash in the mark's lime, never in the accent", () => {
    const start = STYLES.indexOf(".reload-curtain {");
    const curtain = STYLES.slice(start, STYLES.indexOf("@keyframes reload-orbit", start));
    expect(curtain).toMatch(/var\(--brand\)/u);
    expect(curtain).not.toMatch(/var\(--acid/u);
  });
});

describe("a run in flight is blue (K70)", () => {
  it.each([
    [STYLES, ".spinner", "--info"],
    [STYLES, ".thread-tree-node > small", "--info-ink"],
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
