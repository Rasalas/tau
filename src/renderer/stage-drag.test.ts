// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { insertionSlot, stageDropAt, STAGE_TAB_DRAG } from "./stage-drag";

const tabs = [
  { id: "a", left: 0, width: 100 },
  { id: "b", left: 102, width: 100 },
];

describe("insertionSlot", () => {
  it("lands in front of the first tab whose middle lies right of the pointer", () => {
    expect(insertionSlot(tabs, 10)).toBe("a");
    expect(insertionSlot(tabs, 70)).toBe("b");
    expect(insertionSlot(tabs, 153)).toBeUndefined();
    expect(insertionSlot(tabs, 400)).toBeUndefined();
  });
});

describe("stageDropAt", () => {
  function over(html: string, selector: string, carries = true, x = 0) {
    document.body.innerHTML = html;
    const target = document.querySelector(selector)!;
    const event = new Event("dragover", { bubbles: true }) as DragEvent;
    Object.defineProperties(event, {
      dataTransfer: { value: { types: carries ? [STAGE_TAB_DRAG] : ["Files"] } },
      clientX: { value: x },
      target: { value: target },
    });
    return event;
  }
  const layout = `<section class="stage"><div class="stage-strip"><div class="stage-tabs-frame"><div class="stage-tabs"><div class="stage-tab" data-tab-id="a"></div></div></div><div class="stage-strip-actions"><button id="tool"></button></div></div><div id="body"></div></section>`;

  it("reorders over the strip's tabs and never splits there", () => {
    expect(stageDropAt(over(layout, ".stage-tab"), 2)).toEqual({ kind: "reorder", beforeId: undefined });
    expect(stageDropAt(over(layout, ".stage-tabs-frame"), 2)).toEqual({ kind: "reorder", beforeId: undefined });
  });

  it("splits below the strip, but takes no drop on the strip's own buttons", () => {
    expect(stageDropAt(over(layout, "#body"), 2)).toEqual({ kind: "split" });
    expect(stageDropAt(over(layout, "#tool"), 2)).toBeUndefined();
  });

  it("ignores other drags and a strip with a single tab", () => {
    expect(stageDropAt(over(layout, "#body", false), 2)).toBeUndefined();
    expect(stageDropAt(over(layout, "#body"), 1)).toBeUndefined();
  });
});
