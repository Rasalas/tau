// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_DOCK_PROPERTY, COMPOSER_RESERVE_PROPERTY, ComposerReserve, composerReserve, resolveComposerReserve } from "./ComposerReserve";

describe("the room the transcript keeps for the dock", () => {
  it("follows the unfolded dock, as the composer grows with its draft or a pill comes", () => {
    let state = resolveComposerReserve({ reserve: -1, unfoldedHost: 0 }, { dock: 128.4, host: 128.4, folded: false });
    expect(state).toEqual({ reserve: 129, unfoldedHost: 129 });
    state = resolveComposerReserve(state, { dock: 150, host: 150, folded: false });
    expect(state.reserve).toBe(150);
    state = resolveComposerReserve(state, { dock: 190, host: 150, folded: false });
    expect(state.reserve).toBe(190);
  });

  it("keeps the unfolded height while the composer is folded, so unfolding moves nothing", () => {
    const open = resolveComposerReserve({ reserve: -1, unfoldedHost: 0 }, { dock: 128, host: 128, folded: false });
    const folded = resolveComposerReserve(open, { dock: 76, host: 76, folded: true });
    expect(folded.reserve).toBe(128);
    // A pill that comes while it is folded still counts.
    const withPill = resolveComposerReserve(folded, { dock: 116, host: 76, folded: true });
    expect(withPill.reserve).toBe(168);
    expect(resolveComposerReserve(withPill, { dock: 168, host: 128, folded: false }).reserve).toBe(168);
  });
});

describe("ComposerReserve", () => {
  let observers: Array<() => void> = [];
  const heights = new Map<Element, number>();

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: () => void) { observers.push(() => this.callback()); }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return { height: heights.get(this) ?? 0 } as DOMRect;
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); heights.clear(); });

  function mount() {
    const view = render(<main className="conversation-column">
      <div className="conversation-thread"><ComposerReserve /></div>
      <div className="conversation-composer-host"><footer className="composer-zone" /></div>
    </main>);
    const column = view.container.querySelector<HTMLElement>(".conversation-column")!;
    return {
      column,
      probe: view.container.querySelector(".composer-reserve-probe")!,
      host: view.container.querySelector(".conversation-composer-host")!,
      zone: view.container.querySelector(".composer-zone")!,
      reserve: () => column.style.getPropertyValue(COMPOSER_RESERVE_PROPERTY),
      resize: () => act(() => { for (const observer of observers) observer(); }),
      view,
    };
  }

  it("publishes the dock's height on the column, and holds it through a fold and back", () => {
    const setDock = (dock: number, host: number, target: ReturnType<typeof mount>) => {
      heights.set(target.probe, dock);
      heights.set(target.host, host);
    };
    const dock = mount();
    setDock(128, 128, dock);
    dock.resize();
    expect(dock.reserve()).toBe("128px");
    expect(composerReserve(dock.column)).toBe(128);
    expect(dock.column.style.getPropertyValue(COMPOSER_DOCK_PROPERTY)).toBe("128px");

    dock.zone.classList.add("collapsed");
    setDock(76, 76, dock);
    dock.resize();
    expect(dock.reserve()).toBe("128px");
    // The visual mask follows the actual dock, even when the end reservation stays unfolded.
    expect(dock.column.style.getPropertyValue(COMPOSER_DOCK_PROPERTY)).toBe("76px");

    dock.zone.classList.remove("collapsed");
    setDock(128, 128, dock);
    dock.resize();
    expect(dock.reserve()).toBe("128px");

    // A second line in the draft: the reserve grows with it.
    setDock(150, 150, dock);
    dock.resize();
    expect(dock.reserve()).toBe("150px");

    dock.view.unmount();
    expect(dock.column.style.getPropertyValue(COMPOSER_RESERVE_PROPERTY)).toBe("");
    expect(dock.column.style.getPropertyValue(COMPOSER_DOCK_PROPERTY)).toBe("");
  });
});

describe("the thread's layout", () => {
  async function stylesheet() {
    return (await readFile(resolve(__dirname, "../styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
  }
  function ruleFor(css: string, selector: string): string {
    const found: string[] = [];
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (selectors!.split(/,(?![^(]*\))/u).some((entry) => entry.trim() === selector)) found.push(body!);
    }
    return found.join(";");
  }
  const THREAD = ".conversation-column:not(.conversation-start)";

  // K51: the transcript spans every row the composer's fold can change, so its height never follows the fold.
  it("runs the transcript on under every row of the dock", async () => {
    const css = await stylesheet();
    const rows = /grid-template-rows:([^;]+);/u.exec(ruleFor(css, THREAD))![1]!;
    const lines = [...rows.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]!.trim().split(/\s+/u));
    const line = (name: string) => lines.findIndex((names) => names.includes(name));
    expect(ruleFor(css, `${THREAD} .transcript-viewport`)).toMatch(/grid-row: transcript \/ dock-end;/u);
    expect(ruleFor(css, `${THREAD} .composer-reserve-probe`)).toMatch(/grid-row: controls \/ dock-end;/u);
    for (const [selector, name] of [
      [".region-composer-controls", "controls"],
      [".region-transcript-footer", "footer"],
      [".region-composer-above", "above"],
      [".conversation-composer-host", "composer"],
    ] as const) {
      expect(ruleFor(css, `${THREAD} ${selector}`)).toMatch(new RegExp(`grid-row: ${name} / span 1;`, "u"));
      expect(line(name)).toBeGreaterThan(line("transcript"));
      expect(line(name)).toBeLessThan(line("dock-end"));
    }
    // Each in the one column: an item with only a row would land in a new column beside the transcript.
    const column = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .find(([, selectors, body]) => selectors!.trim().startsWith(`${THREAD} :is(`) && /grid-column: 1 \/ -1;/u.test(body!))?.[1] ?? "";
    for (const item of [".transcript-viewport", ".composer-reserve-probe", ".region-composer-controls", ".region-transcript-footer", ".region-composer-above", ".conversation-composer-host", ".status-line"]) {
      expect(column).toContain(item);
    }
    expect(line("transcript")).toBeGreaterThanOrEqual(0);
    expect(rows).toMatch(/\[transcript\] minmax\(0, 1fr\)/u);
  });

  it("keeps the reserve free at the transcript's end", async () => {
    const css = await stylesheet();
    expect(ruleFor(css, ".transcript-inner::after")).toMatch(/height: var\(--composer-reserve, 0px\);/u);
  });
});
