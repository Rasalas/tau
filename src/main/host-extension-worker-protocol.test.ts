import { describe, expect, it } from "vitest";
import { reviveError, serializeError } from "./host-extension-worker-protocol.js";

describe("worker error diagnostics", () => {
  it("keeps a contextual error's cause across the worker boundary", () => {
    const cause = Object.assign(new Error("storage unavailable"), { code: "EIO" });
    const error = new Error("Could not list conversations", { cause });
    expect(reviveError(serializeError(error))).toMatchObject({
      message: error.message, stack: error.stack,
      cause: { message: cause.message, stack: cause.stack, code: "EIO" },
    });
  });

  it("bounds a circular cause chain", () => {
    const error = new Error("circular");
    error.cause = error;
    expect(() => JSON.stringify(serializeError(error))).not.toThrow();
  });
});
