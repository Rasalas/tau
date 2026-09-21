import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostJobEvent } from "../shared/host-transport.js";
import { HostJobRunner } from "./host-jobs.js";
import { CLIENT_SIDE_METHODS } from "../shared/host-transport.js";
import { createClientHostMethods, createHostMethods, createUnsupportedHostMethods, invokeHostMethod } from "./host-methods.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import type { PiHost } from "./pi-host.js";
import { activateHostKit } from "./test-support/host-kit-harness.js";

/**
 * The client and the host agree only by string. A method added to one and
 * forgotten in the other fails at runtime with "Unknown method", and only when
 * the user happens to hit that button. The two channel names of the Electron
 * transport are checked the same way.
 */
const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const channels = (file: string) => new Set(read(file).match(/tau:[a-z-]+/gu) ?? []);

/**
 * Names the renderer's client never sends: the first four it resolves itself,
 * and `client-call-result` belongs to the window process around it, which
 * answers the host's calls into its own machine (ADR 0021).
 */
const CLIENT_SIDE = new Set(["hello", "start-job", "cancel-job", "job-methods", "client-call-result"]);

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
      workbenchSource: unavailable,
      relaunchWorkbench: unavailable,
      installUpdate: unavailable,
    },
  });
  return new Set(Object.keys(methods));
}

/** Every protocol method name the client sends. */
function clientMethods(): Set<string> {
  const source = read("workbench/host-client.ts");
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

  it("the client-side table implements exactly the client-side method names", () => {
    const unavailable = () => { throw new Error("not available in this test"); };
    const client = createClientHostMethods({
      copyText: unavailable,
      copyImage: unavailable,
      readImagePreview: unavailable,
      loadDesktopExtensions: unavailable,
      rebuildWorkbench: unavailable,
      workbenchSource: unavailable,
      relaunchWorkbench: unavailable,
      installUpdate: unavailable,
    });
    expect(Object.keys(client).sort()).toEqual([...CLIENT_SIDE_METHODS].sort());
    // A window merges its client-side table over the refusing one; every name
    // it answers must be a name the host knows too.
    expect([...CLIENT_SIDE_METHODS].filter((method) => !methods.has(method))).toEqual([]);
  });

  it("a client of a remote host answers every local method with an unsupported error", async () => {
    const refusing = createUnsupportedHostMethods("no local host here");
    expect(Object.keys(refusing).sort()).toEqual([...methods].sort());
    await expect(invokeHostMethod(refusing, "bootstrap", [])).rejects.toMatchObject({ code: "unsupported", message: "no local host here" });
    await expect(invokeHostMethod(refusing, "copy-text", ["x"])).rejects.toMatchObject({ code: "unsupported" });
  });

  it("preserves registry authority when a host-extension call moves to a job", async () => {
    const unavailable = () => { throw new Error("not available in this test"); };
    const events: HostJobEvent[] = [];
    type JobDone = Extract<HostJobEvent, { type: "job-done" }>;
    const done = new Map<string, (event: JobDone) => void>();
    const jobs = new HostJobRunner((event) => {
      events.push(event);
      if (event.type === "job-done") done.get(event.jobId)?.(event);
    });
    let sourceContextId = "";
    const registry = await activateHostKit({
      id: "source.kit",
      name: "Source Kit",
      activate: (context) => { sourceContextId = context.invocationContextId; },
    });
    try {
      let deniedCalls = 0;
      await expect(registry.activate({
        id: "target.kit",
        name: "Target Kit",
        activate: (context) => {
          context.registerCommand("allowed", (input) => ({ input }), { callers: ["source.kit"] });
          context.registerCommand("denied", () => { deniedCalls += 1; return "unexpected"; });
        },
      })).resolves.toBe(true);
      expect(sourceContextId).toMatch(/^[0-9a-f-]{36}$/u);
      const host = {
        invokeHostExtension: (extensionId: string, command: string, input: unknown, principal: HostInvocationPrincipal) =>
          registry.invoke(extensionId, command, input, principal),
      } as unknown as PiHost;
      const jobMethods = createHostMethods({
        bootstrap: unavailable,
        requireHost: async () => host,
        host: () => host,
        jobs,
        platform: {
          copyText: unavailable,
          copyImage: unavailable,
          readImagePreview: unavailable,
          inspectExtensions: unavailable,
          loadDesktopExtensions: unavailable,
          rebuildWorkbench: unavailable,
          workbenchSource: unavailable,
          relaunchWorkbench: unavailable,
          installUpdate: unavailable,
        },
      });
      const principal: HostInvocationPrincipal = { kind: "host-extension", contextId: sourceContextId };
      const waitForDone = (jobId: string): Promise<JobDone> => new Promise((resolve) => {
        const existing = events.find((event): event is JobDone => event.type === "job-done" && event.jobId === jobId);
        if (existing) {
          resolve(existing);
          return;
        }
        done.set(jobId, resolve);
      });

      const allowedStart = await invokeHostMethod(jobMethods, "start-job", [
        "host-extension",
        ["target.kit", "allowed", { callerId: "spoofed.caller", value: 1 }],
      ], principal) as { jobId: string };
      await expect(waitForDone(allowedStart.jobId)).resolves.toMatchObject({
        type: "job-done",
        result: { input: { callerId: "spoofed.caller", value: 1 } },
      });

      const deniedStart = await invokeHostMethod(jobMethods, "start-job", [
        "host-extension",
        ["target.kit", "denied", { callerId: "target.kit" }],
      ], principal) as { jobId: string };
      await expect(waitForDone(deniedStart.jobId)).resolves.toMatchObject({
        type: "job-done",
        error: { code: "unauthorized", message: "Caller source.kit is not allowed to invoke target.kit/denied." },
      });
      expect(deniedCalls).toBe(0);
      expect(registry.isActive("target.kit")).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("preload and the Electron transport name the same channels", () => {
    expect([...channels("preload/index.cts")].sort()).toEqual(["tau:host-event", "tau:request"]);
    expect([...channels("main/host-transport-electron.ts")].sort()).toEqual(["tau:host-event", "tau:request"]);
  });
});
