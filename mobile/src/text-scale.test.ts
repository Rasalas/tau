import { describe, expect, it } from "vitest";
import { androidFontScale, type TextScalePort } from "./text-scale";

describe("androidFontScale", () => {
  it("reads the plugin's scale and follows its changes", async () => {
    let push: ((scale: number) => void) | undefined;
    const port: TextScalePort = { read: async () => 1.15, listen: async (listener) => { push = listener; return () => { push = undefined; }; } };
    const system = await androidFontScale(port);
    expect(system.read()).toBe(1.15);
    const seen: number[] = [];
    const stop = system.subscribe(() => seen.push(system.read()!));
    push!(1.3);
    stop();
    push!(1);
    expect(seen).toEqual([1.3]);
    expect(system.read()).toBe(1);
  });
});
