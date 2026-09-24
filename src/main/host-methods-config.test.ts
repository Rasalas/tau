import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PiHost } from "./pi-host.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import { HostJobRunner } from "./host-jobs.js";

// The config manager reads its paths once, when its module loads.
const directory = await mkdtemp(join(tmpdir(), "tau-host-methods-config-"));
const configFile = join(directory, "config.json");
const before = { config: process.env.TAU_CONFIG_FILE, agent: process.env.PI_CODING_AGENT_DIR };
process.env.TAU_CONFIG_FILE = configFile;
process.env.PI_CODING_AGENT_DIR = join(directory, "pi-agent");
const { createHostMethods, invokeHostMethod } = await import("./host-methods.js");

afterAll(async () => {
  for (const [name, value] of [["TAU_CONFIG_FILE", before.config], ["PI_CODING_AGENT_DIR", before.agent]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const refuse = (): never => { throw new Error("not in this test"); };

describe("Tau's own config writes", () => {
  it("tell the kits that follow the config, whether or not anything watches the file", async () => {
    const configWritten = vi.fn();
    const host = { configWritten, resolveWorkspacePath: (value: string) => value } as unknown as PiHost;
    const table = createHostMethods({
      bootstrap: refuse,
      requireHost: async () => host,
      host: () => host,
      jobs: new HostJobRunner(() => undefined),
      platform: {
        copyText: refuse, copyImage: refuse, readImagePreview: refuse, inspectExtensions: refuse, loadDesktopExtensions: refuse,
        rebuildWorkbench: refuse, workbenchSource: refuse, relaunchWorkbench: refuse, installUpdate: refuse, notify: refuse, setBadge: refuse,
      },
    });
    const owner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c1", local: true };

    await invokeHostMethod(table, "update-config", [{ values: { "tau.access.level": "ask" } }, "global"], owner);
    expect(JSON.parse(await readFile(configFile, "utf8"))).toMatchObject({ values: { "tau.access.level": "ask" } });
    expect(configWritten).toHaveBeenCalledWith([configFile]);

    await invokeHostMethod(table, "clear-config", [["values.tau.access.level"], "global"], owner);
    expect(configWritten).toHaveBeenCalledTimes(2);
  });
});
