import { describe, expect, it } from "vitest";
import { emojiImage, firstEmoji, monogramImage, monogramText, projectIconKey, readProjectIcon, writeProjectIcon } from "./project-icons.js";

const svg = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

describe("project icons", () => {
  it("keys a choice by the project's workspace id, else its path", () => {
    expect(projectIconKey({ workspaceId: "ws-1", path: "/p" })).toBe("project-icon:ws-1");
    expect(projectIconKey({ path: "/p" })).toBe("project-icon:/p");
  });

  it("draws an emoji and a monogram as SVG pictures, escaping what they draw", () => {
    expect(emojiImage("🚀")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u);
    expect(svg(emojiImage("🚀"))).toContain(">🚀</text>");
    const drawn = svg(monogramImage("<A", 215));
    expect(drawn).toContain("hsl(215 42% 36%)");
    expect(drawn).toContain("&#60;A");
  });

  it("takes one or two letters or digits for a monogram, and the first emoji typed", () => {
    expect(monogramText(" ta ")).toBe("TA");
    expect(monogramText("tau")).toBeUndefined();
    expect(monogramText("-")).toBeUndefined();
    expect(firstEmoji("my 🦀 and 🚀")).toBe("🦀");
    expect(firstEmoji("none")).toBeUndefined();
  });

  it("stores a choice in the kit's values, reads back only pictures, and clears", () => {
    const values = new Map<string, string>();
    const preferences = {
      value: (_id: string, key: string) => values.get(key),
      setValue: (_id: string, key: string, value: string) => { values.set(key, value); },
    };
    const project = { path: "/p" };
    writeProjectIcon(preferences, project, { kind: "emoji", emoji: "🚀", image: emojiImage("🚀") });
    expect(readProjectIcon(preferences, project)?.kind).toBe("emoji");
    values.set("project-icon:/p", JSON.stringify({ kind: "image", image: "javascript:alert(1)" }));
    expect(readProjectIcon(preferences, project)).toBeUndefined();
    values.set("project-icon:/p", "{broken");
    expect(readProjectIcon(preferences, project)).toBeUndefined();
    writeProjectIcon(preferences, project, undefined);
    expect(readProjectIcon(preferences, project)).toBeUndefined();
  });
});
