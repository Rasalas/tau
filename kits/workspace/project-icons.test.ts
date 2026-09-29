import { describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { emojiImage, firstEmoji, monogramImage, monogramText, projectIconKey, publishProjectIcons, readProjectIcon, writeProjectIcon } from "./project-icons.js";

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

  it("hands core every chosen picture by workspace id or path, again only when one changes, and withdraws them", () => {
    const preferences = new PreferencesStore();
    const rocket = emojiImage("🚀");
    writeProjectIcon(preferences, { workspaceId: "ws1_shop", path: "/shop" }, { kind: "emoji", emoji: "🚀", image: rocket });
    preferences.setValue("tau.workspace", "project-icon:/bad", "{broken");
    const publish = vi.fn();
    const stop = publishProjectIcons(preferences, publish);
    expect(publish).toHaveBeenLastCalledWith({ ws1_shop: rocket });
    preferences.setValue("tau.workspace", "other-setting", "x");
    expect(publish).toHaveBeenCalledTimes(1);
    writeProjectIcon(preferences, { path: "/tau" }, { kind: "monogram", text: "T", hue: 85, image: monogramImage("T", 85) });
    expect(publish).toHaveBeenLastCalledWith({ ws1_shop: rocket, "/tau": monogramImage("T", 85) });
    writeProjectIcon(preferences, { workspaceId: "ws1_shop", path: "/shop" }, undefined);
    expect(publish).toHaveBeenLastCalledWith({ "/tau": monogramImage("T", 85) });
    stop();
    expect(publish).toHaveBeenLastCalledWith(undefined);
    writeProjectIcon(preferences, { path: "/late" }, { kind: "emoji", emoji: "🚀", image: rocket });
    expect(publish).toHaveBeenCalledTimes(4);
  });
});
