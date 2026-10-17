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

  it("keeps password controls actionable without returning their values or copies", () => {
    const secret = "TAU_SYNTHETIC_SECRET_1729";
    document.body.innerHTML = `
      <label for="password">Password</label>
      <input id="password" type="password">
      <button aria-label="Continue with ${secret}">Continue</button>
      <p>Repeated: ${secret}</p>
      <input aria-label="Account" value="Ada">
    `;
    const field = document.querySelector<HTMLInputElement>("#password")!;
    field.value = secret;

    const tree = previewSnapshot(8_000);

    expect(tree).not.toContain(secret);
    expect(tree).toContain('textbox "Password" [ref=e');
    expect(tree).toContain('button "Continue with [redacted]"');
    expect(tree).toContain('text "Repeated: [redacted]"');
    expect(tree).toContain('textbox "Account"');
    expect(tree).toContain('value="Ada"');
    expect(previewFind({ ref: field.getAttribute("data-tau-ref")! })).toBe(field);
    expect(field.value).toBe(secret);
  });

  it("redacts before clipping, including whitespace-normalized and overlapping passwords", () => {
    const longSecret = "TAU_SECRET_".repeat(10);
    document.body.innerHTML = `
      <input id="long" type="password"><input id="overlap" type="password">
      <input id="spaced" type="password" hidden>
      <h1>${longSecret}</h1>
      <p>line one   line two</p>
    `;
    document.querySelector<HTMLInputElement>("#long")!.value = longSecret;
    document.querySelector<HTMLInputElement>("#overlap")!.value = "TAU_SECRET_";
    document.querySelector<HTMLInputElement>("#spaced")!.value = "line one\tline two";

    const tree = previewSnapshot(8_000);

    expect(tree).not.toContain("TAU_SECRET_");
    expect(tree).not.toContain("line one");
    expect(tree).toContain('heading "[redacted]"');
    expect(tree).toContain('text "[redacted]"');
  });

  it("redacts secrets copied into the page title and URL", () => {
    const secret = "TAU_SYNTHETIC_SECRET_1729";
    document.title = `Sign in ${secret}`;
    document.body.innerHTML = `<input type="password" value="${secret}">`;
    const previousUrl = window.location.href;
    window.history.replaceState(null, "", `?echo=${secret}`);
    try {
      expect(previewSnapshot(8_000)).not.toContain(secret);
    } finally {
      window.history.replaceState(null, "", previousUrl);
    }
  });

  it("treats password characters literally and redacts URL-encoded copies", () => {
    const secret = "p.a+$[s](s)? /雪";
    document.body.innerHTML = '<input type="PASSWORD"><p></p>';
    document.querySelector<HTMLInputElement>("input")!.value = secret;
    const encoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
    document.querySelector("p")!.textContent = `${secret} ${encoded} ${formEncoded}`;

    const tree = previewSnapshot(8_000);

    expect(tree).not.toContain(secret);
    expect(tree).not.toContain(encoded);
    expect(tree).not.toContain(formEncoded);
    expect(tree).toContain('text "[redacted] [redacted] [redacted]"');
  });

  it("redacts intersecting copies rather than leaving either password's tail", () => {
    document.body.innerHTML = `
      <input type="password" value="first-prefix">
      <input type="password" value="prefix-SECOND_SECRET_TAIL">
      <p>first-prefix-SECOND_SECRET_TAIL</p>
    `;

    const tree = previewSnapshot(8_000);

    expect(tree).not.toContain("first-prefix");
    expect(tree).not.toContain("SECOND_SECRET_TAIL");
    expect(tree).toContain('text "[redacted]"');
  });

  it.each([
    ["p/a", "p%2fa"],
    ["password", "%70assword"],
    ["a b", "a+b"],
  ])("redacts equivalent URL encodings of %s", (secret, encoded) => {
    document.body.innerHTML = '<input type="password">';
    document.querySelector<HTMLInputElement>("input")!.value = secret;
    const previousUrl = window.location.href;
    window.history.replaceState(null, "", `?echo=${encoded}`);
    try {
      const tree = previewSnapshot(8_000);
      expect(tree).not.toContain(encoded);
      expect(tree).toContain("[redacted URL]");
    } finally {
      window.history.replaceState(null, "", previousUrl);
    }
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
