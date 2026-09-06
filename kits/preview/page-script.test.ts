// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  isPreviewRef,
  pageCall,
  previewClick,
  previewCondition,
  previewFind,
  previewScroll,
  previewSnapshot,
  previewType,
} from "./page-script.js";

const FIXTURE = `
  <h1>Preview fixture</h1>
  <p>A paragraph the agent should read.</p>
  <button id="toggle" aria-label="Toggle text">Toggle</button>
  <span id="out">before</span>
  <form id="form">
    <label for="name">Your name</label>
    <input id="name" name="name" value="" placeholder="type a name" />
    <input type="checkbox" id="agree" checked />
    <button type="submit">Send</button>
  </form>
  <a href="/docs">Docs</a>
  <div style="display: none"><button id="invisible">Hidden</button></div>
  <div id="scroller" style="overflow: auto"></div>
`;

beforeEach(() => {
  document.title = "Fixture";
  document.body.innerHTML = FIXTURE;
  document.querySelector("#toggle")!.addEventListener("click", () => {
    document.querySelector("#out")!.textContent = "after";
  });
});

describe("preview snapshot", () => {
  it("names roles, values and headings, and refs everything actionable", () => {
    const tree = previewSnapshot(8_000);
    expect(tree.split("\n")[0]).toContain("Fixture");
    expect(tree).toContain('heading "Preview fixture"');
    expect(tree).toContain('text "A paragraph the agent should read."');
    expect(tree).toContain('button "Toggle text" [ref=e');
    // The label wins over the placeholder, the way an accessible name is resolved.
    expect(tree).toContain('textbox "Your name" [ref=e');
    expect(tree).not.toContain('textbox "type a name"');
    expect(tree).toContain("checkbox");
    expect(tree).toContain("checked");
    expect(tree).toContain('link "Docs" [ref=e');
    // Nothing inside a display:none subtree is offered to the model.
    expect(tree).not.toContain("Hidden");
  });

  it("renumbers refs on every snapshot and shows current field values", () => {
    const first = previewSnapshot(8_000);
    const firstRef = /button "Toggle text" \[ref=(e\d+)\]/u.exec(first)?.[1];
    expect(firstRef && isPreviewRef(firstRef)).toBe(true);
    document.querySelector<HTMLElement>("h1")!.remove();
    const second = previewSnapshot(8_000);
    const secondRef = /button "Toggle text" \[ref=(e\d+)\]/u.exec(second)?.[1];
    expect(secondRef).not.toBe(firstRef);
    // The old ref may be reused, but never for the element it named before.
    expect(previewFind({ ref: firstRef! })?.id).not.toBe("toggle");
    previewType(previewFind, { selector: "#name" }, "Ada", false);
    expect(previewSnapshot(8_000)).toContain('value="Ada"');
  });

  it("truncates a tree that exceeds the cap", () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_value, index) => `<button>Item ${index}</button>`).join("");
    const tree = previewSnapshot(500);
    expect(tree).toContain("… snapshot truncated");
    expect(tree.length).toBeLessThan(700);
  });
});

describe("preview element resolution", () => {
  it("finds elements by ref, selector and visible text", () => {
    previewSnapshot(8_000);
    const ref = /button "Toggle text" \[ref=(e\d+)\]/u.exec(previewSnapshot(8_000))![1]!;
    expect(previewFind({ ref })?.id).toBe("toggle");
    expect(previewFind({ selector: "#name" })?.id).toBe("name");
    expect(previewFind({ text: "Docs" })?.tagName).toBe("A");
    expect(previewFind({ text: "Toggle text" })?.id).toBe("toggle");
    expect(previewFind({ ref: "e999" })).toBeNull();
    expect(previewFind({ selector: "((" })).toBeNull();
    expect(previewFind({ text: "nothing here" })).toBeNull();
  });
});

describe("preview actions", () => {
  it("clicks what the page reacts to", () => {
    expect(previewClick(previewFind, { selector: "#toggle" })).toMatchObject({ ok: true });
    expect(document.querySelector("#out")!.textContent).toBe("after");
    expect(previewClick(previewFind, { selector: "#gone" })).toEqual({ ok: false, error: "No element matched." });
  });

  it("types through the prototype setter so a controlled input notices", () => {
    const seen: string[] = [];
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.addEventListener("input", (event) => seen.push((event.target as HTMLInputElement).value));
    const submitted: string[] = [];
    document.querySelector("#form")!.addEventListener("submit", (event) => { event.preventDefault(); submitted.push(field.value); });
    expect(previewType(previewFind, { selector: "#name" }, "hello", true)).toMatchObject({ ok: true });
    expect(field.value).toBe("hello");
    expect(seen).toEqual(["hello"]);
    expect(submitted).toEqual(["hello"]);
  });

  it("scrolls an element and the page", () => {
    const scroller = document.querySelector<HTMLElement>("#scroller")!;
    expect(previewScroll(previewFind, { selector: "#scroller" }, 0, 120)).toMatchObject({ ok: true });
    expect(scroller.scrollTop).toBe(120);
    expect(previewScroll(previewFind, { selector: "#missing" }, 0, 120)).toMatchObject({ ok: false });
    const scrolled: number[] = [];
    window.scrollBy = ((dx: number, dy: number) => { scrolled.push(dx, dy); }) as typeof window.scrollBy;
    expect(previewScroll(previewFind, undefined, 0, 200)).toMatchObject({ ok: true });
    expect(scrolled).toEqual([0, 200]);
  });

  it("answers what preview_wait_for polls for", () => {
    expect(previewCondition("A paragraph", undefined)).toBe(true);
    expect(previewCondition("not on the page", undefined)).toBe(false);
    expect(previewCondition(undefined, "#form")).toBe(true);
    expect(previewCondition(undefined, "#absent")).toBe(false);
    expect(previewCondition("A paragraph", "#absent")).toBe(false);
  });
});

describe("page calls", () => {
  it("sends the function and its arguments as source the page can run", () => {
    const source = pageCall(previewClick, previewFind, { ref: "e1" });
    expect(source.startsWith("(function previewClick")).toBe(true);
    expect(source).toContain('{"ref":"e1"}');
    // eslint-disable-next-line no-eval -- the page would do exactly this.
    expect(eval(source)).toMatchObject({ ok: false });
  });
});
