import { describe, expect, it } from "vitest";
import { MAX_LOAD, loadAllows, pickDeviceType, pickRuntime } from "./sim-device.mjs";

const phone = (name) => ({ name, productFamily: "iPhone", identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replaceAll(" ", "-")}` });

describe("pickRuntime", () => {
  it("takes the newest available iOS runtime", () => {
    const list = {
      runtimes: [
        { platform: "iOS", version: "26.4.1", isAvailable: true, name: "iOS 26.4" },
        { platform: "iOS", version: "27.0", isAvailable: true, name: "iOS 27.0" },
        { platform: "iOS", version: "28.0", isAvailable: false, name: "iOS 28.0" },
        { platform: "watchOS", version: "30.0", isAvailable: true, name: "watchOS 30.0" },
        { platform: "iOS", version: "26.10", isAvailable: true, name: "iOS 26.10" },
      ],
    };
    expect(pickRuntime(list).name).toBe("iOS 27.0");
  });

  it("says what to install when there is none", () => {
    expect(() => pickRuntime({ runtimes: [] })).toThrow(/no iOS simulator runtime/);
  });
});

describe("pickDeviceType", () => {
  it("takes the newest plain iPhone", () => {
    const runtime = { name: "iOS 27.0", supportedDeviceTypes: [phone("iPhone 18 Pro"), phone("iPhone 17"), phone("iPhone Air"), phone("iPhone 16"), { name: "iPad Air", productFamily: "iPad" }] };
    expect(pickDeviceType(runtime).name).toBe("iPhone 17");
  });

  it("falls back to any iPhone", () => {
    expect(pickDeviceType({ name: "iOS", supportedDeviceTypes: [phone("iPhone Air")] }).name).toBe("iPhone Air");
  });

  it("refuses a runtime without iPhones", () => {
    expect(() => pickDeviceType({ name: "iOS", supportedDeviceTypes: [] })).toThrow(/supports no iPhone/);
  });
});

describe("loadAllows", () => {
  it("starts a simulator only below the brief's limit", () => {
    expect(MAX_LOAD).toBe(40);
    expect(loadAllows(12)).toBe(true);
    expect(loadAllows(40)).toBe(false);
    expect(loadAllows(321)).toBe(false);
  });
});
