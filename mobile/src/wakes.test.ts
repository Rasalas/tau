import { describe, expect, it } from "vitest";
import type { HostWake } from "../../src/workbench/host-link";
import { nativeWakeSource, type NetworkStatus } from "./wakes";

function fakes(initial: NetworkStatus) {
  let appListener: ((state: { isActive: boolean }) => void) | undefined;
  let networkListener: ((status: NetworkStatus) => void) | undefined;
  const removed: string[] = [];
  const app = { addListener: async (_event: "appStateChange", listener: typeof appListener) => { appListener = listener; return { remove: async () => { removed.push("app"); } }; } };
  const network = {
    getStatus: async () => initial,
    addListener: async (_event: "networkStatusChange", listener: typeof networkListener) => { networkListener = listener; return { remove: async () => { removed.push("network"); } }; },
  };
  return { app, network, removed, active: (isActive: boolean) => appListener!({ isActive }), status: (status: NetworkStatus) => networkListener!(status) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("nativeWakeSource", () => {
  it("wakes the transport on the foreground, on a lost and a returned network and on another path", async () => {
    const fake = fakes({ connected: true, connectionType: "wifi" });
    const wakes: HostWake[] = [];
    const stop = nativeWakeSource(fake.app, fake.network)((wake) => wakes.push(wake));
    await settle();
    fake.active(false);
    fake.active(true);
    fake.status({ connected: false, connectionType: "none" });
    fake.status({ connected: false, connectionType: "none" });
    fake.status({ connected: true, connectionType: "cellular" });
    fake.status({ connected: true, connectionType: "wifi" });
    expect(wakes).toEqual(["foreground", "offline", "online", "network-change"]);
    stop();
    await settle();
    expect(fake.removed.sort()).toEqual(["app", "network"]);
  });

  it("says offline at once when the app starts without a network", async () => {
    const fake = fakes({ connected: false, connectionType: "none" });
    const wakes: HostWake[] = [];
    nativeWakeSource(fake.app, fake.network)((wake) => wakes.push(wake));
    await settle();
    expect(wakes).toEqual(["offline"]);
  });
});
