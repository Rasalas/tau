import { describe, expect, it } from "vitest";
import { PI_BRIDGE_SUPPORTS_IMAGE_INPUT } from "./tau-session-bridge.js";

describe("Tau Pi bridge capability", () => {
  it("declares that the bridge cannot send image prompt input", () => {
    expect(PI_BRIDGE_SUPPORTS_IMAGE_INPUT).toBe(false);
  });
});
