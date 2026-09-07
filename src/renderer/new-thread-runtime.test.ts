import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { chosenNewThreadRuntime, effectiveNewThreadRuntime } from "./new-thread-runtime";

const snapshot = {
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }],
  defaultBackendKind: "acme",
} as HostSnapshot;

describe("the runtime of a new thread", () => {
  it("is the client's choice when the host offers it", () => {
    expect(chosenNewThreadRuntime("acme", snapshot)).toBe("acme");
    expect(effectiveNewThreadRuntime("pi", snapshot)).toBe("pi");
  });

  it("falls back to the host's default when the choice is not installed or absent", () => {
    expect(chosenNewThreadRuntime("gone", snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime("gone", snapshot)).toBe("acme");
    expect(chosenNewThreadRuntime(undefined, snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime(undefined, undefined)).toBe("pi");
  });
});
