import { describe, expect, it } from "vitest";
import { machineClass } from "./machine-class.mjs";

describe("machine benchmark metadata", () => {
  it("reports stable hardware facts without host identity", () => {
    const machine = machineClass();
    expect(machine.platform).toBe(process.platform);
    expect(machine.architecture).toBe(process.arch);
    expect(machine.chip).toEqual(expect.any(String));
    expect(machine.chip.length).toBeGreaterThan(0);
    expect(machine.memoryGiB).toEqual(expect.any(Number));
    expect(machine.memoryGiB).toBeGreaterThan(0);
    expect(machine.logicalCores).toEqual(expect.any(Number));
    expect(machine.logicalCores).toBeGreaterThan(0);
    expect(machine).not.toHaveProperty("hostname");
    expect(machine).not.toHaveProperty("username");
  });
});
