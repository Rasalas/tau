// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiSession } from "tau";
import { useRailDrag } from "./rail-drag.js";
import type { ThreadRailOrganizer, ThreadRailSection } from "./protocol.js";

class FakeTransfer {
  private readonly data = new Map<string, string>();
  get types() { return [...this.data.keys()]; }
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ""; }
}
class FakeDragEvent extends Event {
  readonly dataTransfer: FakeTransfer | null;
  constructor(type: string, init: { dataTransfer?: FakeTransfer } & EventInit) { super(type, init); this.dataTransfer = init.dataTransfer ?? null; }
}

const thread = { id: "t1", path: "/s/t1.jsonl", title: "Fix login", modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 1 } as UiSession;
const sections: ThreadRailSection[] = [{ id: "active", threads: [thread] }];
const organizer = { dropLabel: vi.fn(() => "Move here"), drop: vi.fn() } as unknown as ThreadRailOrganizer;

function Rail() {
  const { drag, onPointerDown } = useRailDrag(organizer, sections);
  return (
    <nav onPointerDown={onPointerDown}>
      <div data-rail-thread="t1" data-rail-section="active">row</div>
      {drag?.label ? <output>{drag.label}</output> : null}
    </nav>
  );
}

const pointer = (type: string, x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })); });
let under: Element | null = null;

beforeEach(() => {
  vi.stubGlobal("DataTransfer", FakeTransfer);
  vi.stubGlobal("DragEvent", FakeDragEvent);
  document.elementFromPoint = () => under;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function composer(accepts: boolean) {
  const frame = document.createElement("div");
  document.body.append(frame);
  const dropped: unknown[] = [];
  frame.addEventListener("dragover", (event) => { if (accepts && (event as FakeDragEvent).dataTransfer?.types.includes("application/x-tau-thread+json")) event.preventDefault(); });
  frame.addEventListener("drop", (event) => { dropped.push(JSON.parse((event as FakeDragEvent).dataTransfer!.getData("application/x-tau-thread+json"))); });
  return { frame, dropped };
}

function press() {
  render(<Rail />);
  const row = screen.getByText("row");
  act(() => { row.dispatchEvent(new MouseEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, bubbles: true })); });
  return row;
}

describe("dragging a thread out of the rail", () => {
  it("offers the thread to a composer it is let go over, and moves nothing in the rail", () => {
    const { frame, dropped } = composer(true);
    const row = press();
    under = frame;
    pointer("pointermove", 400, 300);
    expect(screen.getByRole("status").textContent).toBe("Add as context");
    pointer("pointerup", 400, 300);
    expect(dropped).toEqual([{ threadId: "t1", title: "Fix login" }]);
    expect(organizer.drop).not.toHaveBeenCalled();
    expect(row).toBeTruthy();
  });

  it("keeps sorting while the pointer is over the rail", () => {
    const { dropped } = composer(true);
    const row = press();
    under = row;
    pointer("pointermove", 20, 20);
    pointer("pointerup", 20, 20);
    expect(dropped).toEqual([]);
    expect(organizer.drop).toHaveBeenCalledWith("t1", { sectionId: "active" });
  });

  it("offers nothing to something that does not take a thread", () => {
    const { frame, dropped } = composer(false);
    press();
    under = frame;
    pointer("pointermove", 400, 300);
    expect(screen.queryByRole("status")).toBeNull();
    pointer("pointerup", 400, 300);
    expect(dropped).toEqual([]);
  });

  it("drags on where a browser cannot build a transfer", () => {
    vi.stubGlobal("DataTransfer", class { constructor() { throw new TypeError("Illegal constructor"); } });
    const { frame, dropped } = composer(true);
    press();
    under = frame;
    pointer("pointermove", 400, 300);
    pointer("pointerup", 400, 300);
    expect(dropped).toEqual([]);
  });
});
