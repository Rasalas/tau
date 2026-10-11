import { describe, expect, it, vi } from "vitest";
import { HandoffStore } from "./store";

describe("HandoffStore runtimes", () => {
  it("offers a handoff only to runtimes the project did not turn off", () => {
    const store = new HandoffStore();
    const heard = vi.fn();
    store.subscribe(heard);
    const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex", disabled: true }, { kind: "cursor", label: "Cursor" }];
    store.setRuntimes(backends);
    expect(store.getSnapshot().runtimes.map((runtime) => runtime.kind)).toEqual(["pi", "cursor"]);
    store.setRuntimes(backends.map((backend) => ({ ...backend })));
    expect(heard).toHaveBeenCalledTimes(1);
    store.setRuntimes(backends.map((backend) => ({ ...backend, disabled: backend.kind === "cursor" })));
    expect(store.getSnapshot().runtimes.map((runtime) => runtime.kind)).toEqual(["pi", "codex"]);
  });
});
