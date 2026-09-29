// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiEnvironment, UiEnvironments } from "../shared/environments";
import type { HostUpdateStatus } from "../shared/host-updates";
import type { Platform } from "../workbench/platform";
import type { PlatformEnvironments } from "../workbench/environments";
import { HostClientProvider } from "./host-client-context";
import { useMachineUpdates } from "./machine-updates";
import { PlatformProvider, usePlatform } from "./platform-context";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(cleanup);

const STATUS: HostUpdateStatus = { version: "0.7.14", phase: "current", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", devicesMayInstall: true };

/** What a sidebar footer would draw. */
function Footer() {
  const { pending } = useMachineUpdates();
  return <p>{pending.length ? `Update available: ${pending.map((entry) => `${entry.name} ${entry.version ?? "?"}→${entry.latest ?? "?"}`).join(", ")}` : "current"}</p>;
}

function WithPlatform({ environments, children }: { environments?: PlatformEnvironments; children: ReactNode }) {
  const platform = usePlatform();
  return <PlatformProvider platform={{ ...platform, ...(environments ? { environments } : {}) } as Platform}>{children}</PlatformProvider>;
}

function machine(patch: Partial<UiEnvironment>): UiEnvironment {
  return { id: "x", name: "x", local: false, status: "connected", threads: [], threadCount: 0, projects: [], ...patch };
}

describe("useMachineUpdates (K103)", () => {
  it("on a phone or in a browser: the one host it talks to, once that host knows a newer Tau", async () => {
    const client = createFakeHostClient({ hostUpdate: async () => STATUS, getHostName: () => "rex" });
    render(<HostClientProvider client={client}><WithPlatform><Footer /></WithPlatform></HostClientProvider>);
    expect(await screen.findByText("current")).toBeTruthy();
    act(() => client.emit({ type: "update-status", status: { ...STATUS, version: "0.7.6", phase: "available" } }));
    expect(screen.getByText("Update available: rex 0.7.6→0.7.14")).toBeTruthy();
  });

  it("in a window: every machine it keeps that is behind, by its host's check or by this window's version", async () => {
    let list: UiEnvironments = {
      shown: "mini",
      secureStorage: true,
      environments: [
        machine({ id: "mini", name: "mini", local: true, hostVersion: "0.7.14", update: STATUS }),
        machine({ id: "rex", name: "rex", hostVersion: "0.7.6" }),
        machine({ id: "studio", name: "studio", hostVersion: "0.7.14", update: { ...STATUS, phase: "ready", latest: "0.7.15" } }),
      ],
    };
    const listeners = new Set<() => void>();
    const environments = { getSnapshot: () => list, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as PlatformEnvironments;
    const client = createFakeHostClient({ hostUpdate: async () => STATUS, getVersions: () => ({ host: "0.7.14", window: "0.7.14" }) });
    render(<HostClientProvider client={client}><WithPlatform environments={environments}><Footer /></WithPlatform></HostClientProvider>);
    expect(await screen.findByText("Update available: rex 0.7.6→?, studio 0.7.14→0.7.15")).toBeTruthy();
    list = { ...list, environments: list.environments.slice(0, 1) };
    act(() => { for (const listener of listeners) listener(); });
    expect(screen.getByText("current")).toBeTruthy();
  });
});
