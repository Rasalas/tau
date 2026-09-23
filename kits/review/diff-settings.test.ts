// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { currentDiffWordWrap, trackDiffSettings } from "./diff-settings.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

describe("diff display settings", () => {
  it("marks <html> for blue and orange and mirrors the wrap while the kit is active", () => {
    const { preferences } = createKitHarness();
    const root = document.createElement("html");
    const stop = trackDiffSettings(preferences, root);
    expect(root.dataset.diffColors).toBeUndefined();
    expect(currentDiffWordWrap()).toBe(true);

    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "diff-colors", "blue-orange");
    preferences.setOption(REVIEW_HOST_EXTENSION_ID, "diff-word-wrap", false);
    expect(root.dataset.diffColors).toBe("blue-orange");
    expect(currentDiffWordWrap()).toBe(false);

    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "diff-colors", "red-green");
    expect(root.dataset.diffColors).toBeUndefined();
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "diff-colors", "blue-orange");
    stop();
    expect(root.dataset.diffColors).toBeUndefined();
    expect(currentDiffWordWrap()).toBe(true);
  });
});
