import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostJobRunner } from "./host-jobs.js";
import { createHostMethods, createUnsupportedHostMethods, invokeHostMethod } from "./host-methods.js";

/**
 * The renderer and the host agree only by string. A method added to one and
 * forgotten in the other fails at runtime with "Unknown method", and only when
 * the user happens to hit that button. The two channel names of the Electron
 * transport are checked the same way.
 */
const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const channels = (file: string) => new Set(read(file).match(/tau:[a-z-]+/gu) ?? []);

/** Names the client itself resolves: they never reach the method table. */
const CLIENT_SIDE = new Set(["hello", "start-job", "cancel-job", "job-methods"]);

function tableMethods(): Set<string> {
  const unavailable = () => { throw new Error("not available in this test"); };
  const methods = createHostMethods({
    bootstrap: unavailable,
    requireHost: unavailable,
    host: () => undefined,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unavailable,
      copyImage: unavailable,
      readImagePreview: unavailable,
      inspectExtensions: unavailable,
      loadDesktopExtensions: unavailable,
      rebuildWorkbench: unavailable,
      relaunchWorkbench: unavailable,
    },
  });
  return new Set(Object.keys(methods));
}

/** Every protocol method name the renderer's host client sends. */
function clientMethods(): Set<string> {
  const source = read("renderer/host-client.ts");
  return new Set([...source.matchAll(/(?:call|runJob|isJobMethod)(?:<[^>]*>)?\("([a-z-]+)"/gu)].map((match) => match[1]!));
}

describe("host protocol contract", () => {
  const methods = tableMethods();

  it("the host implements every method the client calls", () => {
    const missing = [...clientMethods()].filter((method) => !methods.has(method)).sort();
    expect(missing).toEqual([]);
  });

  it("every method in the table is reachable from the client", () => {
    const client = clientMethods();
    const unreachable = [...methods].filter((method) => !client.has(method) && !CLIENT_SIDE.has(method)).sort();
    expect(unreachable).toEqual([]);
  });

  it("a client of a remote host answers every local method with an unsupported error", async () => {
    const refusing = createUnsupportedHostMethods("no local host here");
    expect(Object.keys(refusing).sort()).toEqual([...methods].sort());
    await expect(invokeHostMethod(refusing, "bootstrap", [])).rejects.toMatchObject({ code: "unsupported", message: "no local host here" });
    await expect(invokeHostMethod(refusing, "copy-text", ["x"])).rejects.toMatchObject({ code: "unsupported" });
  });

  it("preload and the Electron transport name the same channels", () => {
    expect([...channels("preload/index.cts")].sort()).toEqual(["tau:host-event", "tau:request"]);
    expect([...channels("main/host-transport-electron.ts")].sort()).toEqual(["tau:host-event", "tau:request"]);
  });
});
