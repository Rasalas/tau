import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostMachines, decodeMachineEntry } from "./host-machines.js";
import type { EnvironmentMonitor } from "./environment-monitor.js";
import type { HostLogger } from "./host-log.js";

it("hands agents a separately owned Connect bridge and restores it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-agent-connect-"));
  const bridges: Array<{ port: number; close: ReturnType<typeof vi.fn> }> = [];
  const route = { relay: "https://connect.example.org", id: "12345678-1234-1234-1234-123456789012", token: "a".repeat(43), port: 34567 };
  const options = {
    path: join(directory, "machines.json"), ownId: "local",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as HostLogger,
    monitor: () => ({ close: vi.fn() }) as unknown as EnvironmentMonitor,
    connectBridge: (value: typeof route) => {
      const bridge = { port: value.port, close: vi.fn(), start: async () => {} };
      bridges.push(bridge); return bridge;
    },
  };
  let machines = await HostMachines.open(options);
  try {
    await machines.add(decodeMachineEntry({ id: "remote", token: "agent-token", endpoints: [{ url: "https://127.0.0.1:34567/" }], managed: { connect: route } }));
    expect(bridges[0]!.port).not.toBe(route.port);
    expect(machines.list()[0]!.address).toBe(`${route.relay}/v1/routes/${route.id}`);
    machines.close();
    expect(bridges[0]!.close).toHaveBeenCalledOnce();
    machines = await HostMachines.open(options);
    expect(bridges[1]!.port).toBe(bridges[0]!.port);
    expect(machines.list()).toHaveLength(1);
    await machines.remove("remote");
    expect(bridges[1]!.close).toHaveBeenCalledOnce();
  } finally { machines.close(); await rm(directory, { recursive: true, force: true }); }
});
