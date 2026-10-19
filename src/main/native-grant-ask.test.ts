import { describe, expect, it, vi } from "vitest";
import { nativeGrantAsk, scriptedGrantAnswer } from "./native-grant-ask.js";

const prompt = { type: "warning" as const, title: "Allow extension", message: "Allow Hello?", detail: "", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0 };
const test = { TAU_TEST_INSTANCE: "1", TAU_TEST_GRANT_ANSWER: "allow" };

describe("scriptedGrantAnswer", () => {
  it("answers only in an unpackaged test instance with an answer set", () => {
    expect(scriptedGrantAnswer(false, test)).toBe("allow");
    expect(scriptedGrantAnswer(false, { ...test, TAU_TEST_GRANT_ANSWER: "deny" })).toBe("deny");
  });

  it("is off in a packaged app, without the test-instance mark, and for an unknown answer", () => {
    expect(scriptedGrantAnswer(true, test)).toBeUndefined();
    expect(scriptedGrantAnswer(false, { TAU_TEST_GRANT_ANSWER: "allow" })).toBeUndefined();
    expect(scriptedGrantAnswer(false, { ...test, TAU_TEST_GRANT_ANSWER: "yes" })).toBeUndefined();
    expect(scriptedGrantAnswer(false, { TAU_TEST_INSTANCE: "1" })).toBeUndefined();
  });
});

describe("nativeGrantAsk", () => {
  it("shows the real dialog in a packaged app even when the test variables are set", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    expect(await nativeGrantAsk({ app: { isPackaged: true }, dialog: { showMessageBox } }, test)(prompt)).toEqual({ response: 0 });
    expect(showMessageBox).toHaveBeenCalledWith({ ...prompt, noLink: true });
  });

  it("answers for a test instance without opening a dialog", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const electron = { app: { isPackaged: false }, dialog: { showMessageBox } };
    expect(await nativeGrantAsk(electron, test)(prompt)).toEqual({ response: 1 });
    expect(await nativeGrantAsk(electron, { ...test, TAU_TEST_GRANT_ANSWER: "deny" })(prompt)).toEqual({ response: 0 });
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
