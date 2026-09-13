// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderAnsi } from "./ansi.js";

describe("renderAnsi", () => {
  it("returns plain text unchanged when there are no escape codes", () => {
    const result = renderAnsi("hello world");
    expect(result).toBe("hello world");
  });

  it("handles empty or falsy strings gracefully", () => {
    expect(renderAnsi("")).toBe("");
  });

  it("renders color sequences to spans with matching CSS classes", () => {
    const { container } = render(<>{renderAnsi("\u001b[32mSUCCESS\u001b[0m")}</>);
    const span = container.querySelector(".ansi-green");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("SUCCESS");
  });

  it("handles mixed styling like bold and color", () => {
    const { container } = render(<>{renderAnsi("\u001b[1;31mERROR\u001b[0m: file not found")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("ansi-bold");
    expect(span?.className).toContain("ansi-red");
    expect(span?.textContent).toBe("ERROR");
    expect(container.textContent).toBe("ERROR: file not found");
  });

  it("handles dim, italic, and underline styling", () => {
    const { container } = render(<>{renderAnsi("\u001b[2;3;4mstyled\u001b[0m")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("ansi-dim");
    expect(span?.className).toContain("ansi-italic");
    expect(span?.className).toContain("ansi-underline");
    expect(span?.textContent).toBe("styled");
  });

  it("handles bright colors", () => {
    const { container } = render(<>{renderAnsi("\u001b[94mBRIGHT BLUE\u001b[0m")}</>);
    const span = container.querySelector(".ansi-bright-blue");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("BRIGHT BLUE");
  });

  it("handles background colors", () => {
    const { container } = render(<>{renderAnsi("\u001b[41;37mALERT\u001b[0m")}</>);
    const span = container.querySelector("span");
    expect(span?.className).toContain("ansi-bg-red");
    expect(span?.className).toContain("ansi-white");
    expect(span?.textContent).toBe("ALERT");
  });

  it("resets colors independently with 39 and 49", () => {
    const { container } = render(<>{renderAnsi("\u001b[31;42mRED_ON_GREEN\u001b[39mDEFAULT_ON_GREEN\u001b[49mCLEAN")}</>);
    const spans = container.querySelectorAll("span");
    expect(spans[0]?.className).toBe("ansi-red ansi-bg-green");
    expect(spans[0]?.textContent).toBe("RED_ON_GREEN");
    expect(spans[1]?.className).toBe("ansi-bg-green");
    expect(spans[1]?.textContent).toBe("DEFAULT_ON_GREEN");
    expect(container.textContent).toBe("RED_ON_GREENDEFAULT_ON_GREENCLEAN");
  });
});
