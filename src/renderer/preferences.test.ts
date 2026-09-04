// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "./preferences";

let preferences: PreferencesStore;

beforeEach(() => {
  preferences = new PreferencesStore();
});

describe("settled threads", () => {
  it("can be idempotently returned to active when work resumes", () => {
    preferences.toggleSettled("thread");
    expect(preferences.isSettled("thread")).toBe(true);
    preferences.unsettle("thread");
    preferences.unsettle("thread");
    expect(preferences.isSettled("thread")).toBe(false);
  });
});
