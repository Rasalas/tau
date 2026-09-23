import { describe, expect, it } from "vitest";
import { boundedText, compact, imageBounds, matchWindow, outline, readElementTree, type AccessibleElement } from "./accessibility.js";

type Fake = Partial<Omit<AccessibleElement, "children">> & { kids?: Fake[]; throwing?: boolean };

function element(fake: Fake): AccessibleElement {
  return {
    role: fake.role ?? "group",
    name: fake.name ?? null,
    value: fake.value ?? null,
    description: fake.description ?? null,
    get bounds() {
      if (fake.throwing) throw new Error("gone");
      return fake.bounds ?? null;
    },
    actions: fake.actions ?? ["focus", "show_menu"],
    enabled: fake.enabled ?? true,
    focused: fake.focused ?? false,
    selected: fake.selected ?? false,
    editable: fake.editable ?? false,
    expanded: fake.expanded ?? null,
    checked: fake.checked ?? null,
    active: fake.active ?? false,
    children: async () => (fake.kids ?? []).map(element),
  };
}

/** The test window E18 was checked against, as Chromium reports it: a 1280×704 window at (3840, 735). */
const WINDOW = { x: 3840, y: 735, width: 1280, height: 704 };
const IMAGE = { width: 2560, height: 1408 };
const testWindow = () => element({
  role: "window", name: "E18 test window", bounds: WINDOW, actions: ["activate", "close"],
  kids: [{
    role: "group", name: "E18 test window", bounds: { x: 3840, y: 767, width: 1280, height: 672 },
    kids: [{ role: "group", kids: [{ role: "group", kids: [{
      role: "web_area", name: "E18 test window", bounds: { x: 3840, y: 767, width: 1280, height: 672 },
      kids: [
        { role: "heading", name: "E18 test window", bounds: { x: 3872, y: 819, width: 211, height: 37 }, kids: [{ role: "static_text", value: "E18 test window", bounds: { x: 3872, y: 819, width: 211, height: 37 } }] },
        { role: "text_field", value: "hello from E18", editable: true, focused: true, actions: ["press", "focus", "set_value"], bounds: { x: 3904, y: 907, width: 154, height: 22 } },
        { role: "button", name: "Press me", actions: ["press", "show_menu", "scroll_to_visible", "focus"], bounds: { x: 4061, y: 907, width: 73, height: 22 } },
        { role: "check_box", name: "Off-screen", checked: "on", enabled: false, bounds: { x: 9000, y: 9000, width: 10, height: 10 } },
      ],
    }] }] }],
  }],
});

describe("reading a window's accessibility tree", () => {
  it("keeps roles, labels, state and actions, with bounds in the picture's pixels", async () => {
    const tree = await readElementTree(testWindow(), WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY });

    expect(tree.truncated).toBe(false);
    expect(tree.root).toMatchObject({ role: "window", name: "E18 test window", bounds: { x: 0, y: 0, ...IMAGE } });
    // The unnamed wrapper groups gave way; the heading's repeated text went.
    const web = tree.root.children[0]!.children[0]!;
    expect(web.role).toBe("web_area");
    const [heading, field, button, box] = web.children;
    expect(heading).toEqual({ role: "heading", name: "E18 test window", bounds: { x: 64, y: 168, width: 422, height: 74 }, children: [] });
    expect(field).toMatchObject({ role: "text_field", value: "hello from E18", state: { editable: true, focused: true }, actions: ["press", "set_value"] });
    expect(button).toMatchObject({ role: "button", name: "Press me", actions: ["press"], bounds: { x: 442, y: 344, width: 146, height: 44 } });
    // Outside the window: no bounds, but the element and its state stay.
    expect(box).toEqual({ role: "check_box", name: "Off-screen", state: { checked: "on", disabled: true }, children: [] });
    expect(tree.nodes).toBe(7);
  });

  it("stops at the node, character or time limit and says it was cut short", async () => {
    const few = await readElementTree(testWindow(), WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY, maxNodes: 3 });
    expect(few.truncated).toBe(true);

    let clock = 0;
    const slow = await readElementTree(testWindow(), WINDOW, IMAGE, { deadline: 2, now: () => clock++ });
    expect(slow.truncated).toBe(true);
    expect(slow.root.role).toBe("window");

    const short = await readElementTree(testWindow(), WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY, maxChars: 150 });
    expect(short.truncated).toBe(true);
    expect(JSON.stringify(short.root).length).toBeLessThan(400);
  });

  it("survives an element whose getters throw or whose children cannot be read", async () => {
    const broken = element({ role: "window", name: "W", kids: [{ role: "button", name: "B", throwing: true }] });
    const failing = { ...element({ role: "window", name: "W" }), children: async () => { throw new Error("app hung"); } };

    expect((await readElementTree(broken, WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY })).root.children).toEqual([{ role: "button", name: "B", children: [] }]);
    expect(await readElementTree(failing, WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY })).toMatchObject({ truncated: true, root: { role: "window" } });
  });

  it("maps screen rectangles into the picture and drops those outside it", () => {
    expect(imageBounds({ x: 3840, y: 735, width: 640, height: 352 }, WINDOW, IMAGE)).toEqual({ x: 0, y: 0, width: 1280, height: 704 });
    expect(imageBounds({ x: 3800, y: 700, width: 100, height: 100 }, WINDOW, IMAGE)).toEqual({ x: 0, y: 0, width: 120, height: 130 });
    expect(imageBounds({ x: 0, y: 0, width: 10, height: 10 }, WINDOW, IMAGE)).toBeUndefined();
    expect(imageBounds({ x: Number.NaN, y: 0, width: 10, height: 10 }, WINDOW, IMAGE)).toBeUndefined();
  });

  it("cuts long texts without splitting a character and drops NULs", () => {
    expect(boundedText("  a\0b  ", 10)).toBe("ab");
    expect(boundedText("x😀", 2)).toBe("x");
    expect(boundedText("   ", 5)).toBeUndefined();
    expect(boundedText(42, 5)).toBeUndefined();
  });

  it("drops silent wrappers but keeps a root that says nothing", () => {
    expect(compact({ role: "group", children: [{ role: "group", children: [] }] })).toEqual([{ role: "group", children: [] }]);
  });
});

describe("finding the window among an app's windows", () => {
  const windows = [{ name: "Inbox", active: false }, { name: "Draft", active: true }, { name: "Draft", active: false }];

  it("takes the one with the title, the active one of several, or the only one", () => {
    expect(matchWindow(windows, "Inbox")).toBe(windows[0]);
    expect(matchWindow(windows, "Draft")).toBe(windows[1]);
    expect(matchWindow(windows, "")).toBe(windows[1]);
    expect(matchWindow([{ name: "Solo", active: false }], "Other")).toEqual({ name: "Solo", active: false });
    expect(matchWindow([{ name: "A", active: false }, { name: "B", active: false }], "")).toBeUndefined();
  });
});

describe("the outline the chip's popover shows", () => {
  it("indents roles with their labels and stops at the line limit", async () => {
    const tree = await readElementTree(testWindow(), WINDOW, IMAGE, { deadline: Number.POSITIVE_INFINITY });
    expect(outline(tree.root)).toEqual([
      "window “E18 test window”",
      "  group “E18 test window”",
      "    web area “E18 test window”",
      "      heading “E18 test window”",
      "      text field “hello from E18”",
      "      button “Press me”",
      "      check box “Off-screen”",
    ]);
    expect(outline(tree.root, 2)).toHaveLength(2);
  });
});
