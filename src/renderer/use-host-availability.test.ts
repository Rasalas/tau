import { describe, expect, it } from "vitest";
import { hostAvailability } from "./use-host-availability";
import { commandRefusal } from "./use-host-capabilities";

const client = (halves: Record<string, { active: boolean; error?: string } | null | undefined>) => ({
  hostExtensionHalf: (id: string) => halves[id],
});

describe("a host half's availability", () => {
  it("is available until the host answered, and says why when the half does not run", () => {
    const halves = client({ "me.ok": { active: true }, "me.failed": { active: false, error: "My kit lacks permission process" }, "me.waiting": { active: false }, "me.gone": null });
    expect(hostAvailability("me.unknown", halves)).toEqual({ available: true });
    expect(hostAvailability("me.ok", halves)).toEqual({ available: true });
    expect(hostAvailability("me.failed", halves)).toEqual({ available: false, reason: "Its host half stopped: My kit lacks permission process." });
    expect(hostAvailability("me.waiting", halves).reason).toMatch(/waits for approval/u);
    expect(hostAvailability("me.gone", halves).reason).toMatch(/not running/u);
    // The same answer is the same object, so a store reading it sees no change.
    expect(hostAvailability("me.failed", halves)).toBe(hostAvailability("me.failed", halves));
  });

  it("disables a command on every surface with the reason it gives", () => {
    expect(commandRefusal({ access: "read", unavailable: () => "Its host half stopped." }, false)).toBe("Its host half stopped.");
    expect(commandRefusal({ unavailable: () => undefined }, false)).toBeUndefined();
  });
});
