import { describe, expect, it } from "vitest";
import { bridgeNewSessionCommand, PI_BRIDGE_SUPPORTS_IMAGE_INPUT } from "./tau-session-bridge.js";
import { createNewThreadRequestId } from "../../src/shared/contracts.js";

describe("Tau Pi bridge capability", () => {
  it("declares that the bridge cannot send image prompt input", () => {
    expect(PI_BRIDGE_SUPPORTS_IMAGE_INPUT).toBe(false);
  });

  it("routes session creation through the registered command boundary", () => {
    expect(bridgeNewSessionCommand()).toBe("/tau-bridge-new");
    expect(bridgeNewSessionCommand("hello / world")).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify("hello / world"), "utf8").toString("base64url")}`,
    );
    expect(bridgeNewSessionCommand("hello", createNewThreadRequestId("request-1"))).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify({ initialPrompt: "hello", requestId: "request-1" }), "utf8").toString("base64url")}`,
    );
  });
});
