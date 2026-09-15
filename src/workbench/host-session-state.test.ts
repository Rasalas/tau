import { describe, expect, it } from "vitest";
import { HostSessionState } from "./host-session-state";

describe("HostSessionState", () => {
  it("does not trust a cached session before the host confirms one", () => {
    const state = new HostSessionState();

    expect(state.sessionIdFor("cached-session")).toBeUndefined();
    expect(state.sessionIdFor()).toBeUndefined();
  });

  it("returns explicit session ids after a live snapshot is accepted", () => {
    const state = new HostSessionState();

    state.markApplied();

    expect(state.sessionIdFor("live-session")).toBe("live-session");
    expect(state.sessionIdFor()).toBeUndefined();
  });

  it("keeps the confirmation monotonic", () => {
    const state = new HostSessionState();

    state.markApplied();
    state.markApplied();

    expect(state.sessionIdFor("live-session")).toBe("live-session");
  });
});
