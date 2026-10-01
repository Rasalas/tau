import { describe, expect, it } from "vitest";
import { HOST_ERROR } from "./host-transport.js";
import { isMachineUpdateNotice, machineKitError } from "./machine-compatibility.js";

describe("missing machine kit features", () => {
  it.each([HOST_ERROR.unknownMethod, HOST_ERROR.unknownExtension, HOST_ERROR.unknownCommand])("names the requested kit for %s and preserves the code", (code) => {
    const error = Object.assign(new Error("remote details"), { code });
    expect(machineKitError(error, "rex", "tau.files", "read")).toMatchObject({
      message: "rex has no Files that can do this yet. Update rex.", code, cause: error,
    });
  });

  it.each(["Host extension tau.files is not installed.", 'Host extension Files has no command "read".'])("accepts the exact legacy failed message: %s", (message) => {
    expect(machineKitError(Object.assign(new Error(message), { code: HOST_ERROR.failed }), "rex", "tau.files", "read")).toMatchObject({ message: "rex has no Files that can do this yet. Update rex.", code: HOST_ERROR.failed });
  });

  it.each([
    ["failed", "Host extension Files is not active."],
    ["failed", "Host extension Files is not active: crashed."],
    ["failed", 'Host extension Files has no command "write".'],
    ["failed", "Host extension tau.terminal is not installed."],
    ["failed", 'Provider failed: Host extension Files has no command "read".'],
    ["timeout", 'Host extension Files has no command "read".'],
    ["unauthorized", "Host extension tau.files is not installed."],
    [undefined, "Host extension tau.files is not installed."],
  ])("keeps %s / %s unchanged", (code, message) => {
    const error = Object.assign(new Error(message), { code });
    expect(machineKitError(error, "rex", "tau.files", "read")).toBe(error);
  });
});

it("recognizes only complete generated update notices for presentation", () => {
  expect(isMachineUpdateNotice("rex runs an older Tau that cannot take messages from here yet. Update rex in Settings → Machines.")).toBe(true);
  expect(isMachineUpdateNotice("rex runs an older Tau that cannot start threads yet. Update rex in Settings → Machines.")).toBe(true);
  expect(isMachineUpdateNotice("rex has no Workspace Kit that can do this yet. Update rex.")).toBe(true);
  expect(isMachineUpdateNotice("rex has no Files that can do this yet. Update attic.")).toBe(false);
  expect(isMachineUpdateNotice("Provider says update rex in Settings → Machines.")).toBe(false);
  expect(isMachineUpdateNotice("Failed: rex has no Files that can do this yet. Update rex.")).toBe(false);
});
