// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus, PlatformEnvironments, UiEnvironment } from "tau";
import { MachineUpdateLine } from "./update.js";

afterEach(cleanup);

const STATUS: HostUpdateStatus = { version: "0.7.6", phase: "available", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", method: "deb", devicesMayInstall: true };
const rex = (patch: Partial<UiEnvironment> = {}): UiEnvironment => ({ id: "rex-id", name: "rex", local: false, status: "connected", hostVersion: "0.7.6", update: STATUS, threads: [], threadCount: 0, projects: [], ...patch });

function environments() {
  const update = vi.fn(async (_id: string, action: unknown) => (action === "install" ? { ...STATUS, phase: "waiting" as const } : STATUS));
  return { update, environments: { update } as unknown as PlatformEnvironments };
}

describe("Settings → Machines → a machine's Tau (K103)", () => {
  it("offers Update for a machine behind, and asks before its host restarts", async () => {
    const { update, environments: platform } = environments();
    render(<MachineUpdateLine machine={rex()} environments={platform} behind />);
    expect(screen.getByText("Update available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText("Update Tau on rex?")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("rex-id", "install"));
  });

  it("turns automatic updates off there", async () => {
    const { update, environments: platform } = environments();
    render(<MachineUpdateLine machine={rex({ update: { ...STATUS, phase: "current", latest: "0.7.6" } })} environments={platform} behind={false} />);
    fireEvent.click(screen.getByRole("switch", { name: "Automatic updates on rex" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("rex-id", { automatic: false }));
  });

  it("offers nothing to a Read-only pairing or a machine that is away", () => {
    const { environments: platform } = environments();
    render(<MachineUpdateLine machine={rex({ readOnly: true })} environments={platform} behind />);
    expect(screen.getByRole("button", { name: "Update" })).toHaveProperty("disabled", true);
    cleanup();
    render(<MachineUpdateLine machine={rex({ status: "offline" })} environments={platform} behind />);
    expect(screen.getByRole("button", { name: "Update" })).toHaveProperty("disabled", true);
  });

  it("says when a machine is too old to update from here", () => {
    const { environments: platform } = environments();
    const { update: _none, ...old } = rex();
    render(<MachineUpdateLine machine={old} environments={platform} behind />);
    expect(screen.getByText(/cannot be updated from here/u)).toBeTruthy();
  });

  it("shows nothing for a current machine without a status", () => {
    const { environments: platform } = environments();
    const { update: _none, ...current } = rex();
    const { container } = render(<MachineUpdateLine machine={current} environments={platform} behind={false} />);
    expect(container.textContent).toBe("");
  });
});
