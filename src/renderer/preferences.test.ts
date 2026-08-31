// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { preferences } from "./preferences";

beforeEach(() => {
  for (const id of [...preferences.getSnapshot().settledThreadIds]) preferences.unsettle(id);
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
