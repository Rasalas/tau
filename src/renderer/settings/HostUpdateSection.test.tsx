// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus } from "../../shared/host-updates";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { HostUpdateSection } from "./HostUpdateSection";

afterEach(cleanup);

const STATUS: HostUpdateStatus = { version: "0.7.6", phase: "available", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", method: "deb", devicesMayInstall: true };

function renderSection(options: { status?: HostUpdateStatus; owner?: boolean; readOnly?: boolean; refuse?: string } = {}) {
  const hostUpdate = vi.fn(async (action: "status" | "check" | "install") => {
    if (options.refuse) throw Object.assign(new Error(options.refuse), { code: "unknown-method" });
    return action === "install" ? { ...(options.status ?? STATUS), phase: "waiting" as const, runningTurns: 1 } : options.status ?? STATUS;
  });
  const setHostUpdateSettings = vi.fn(async (settings: { automatic?: boolean; devicesMayInstall?: boolean }) => ({ ...(options.status ?? STATUS), ...settings }));
  const client = createFakeHostClient({
    hostUpdate,
    setHostUpdateSettings,
    getHostName: () => "rex",
    isOwner: () => options.owner ?? false,
    isReadOnly: () => options.readOnly ?? false,
  });
  render(<TestProviders><HostClientProvider client={client}><HostUpdateSection fallback={<p>window check</p>} /></HostClientProvider></TestProviders>);
  return { client, hostUpdate, setHostUpdateSettings };
}

describe("Settings → About → Updates (K103)", () => {
  it("shows the host machine's version and a newer release, and installs it on Update now", async () => {
    const { hostUpdate, client } = renderSection();
    expect(await screen.findByText(/Tau 0\.7\.6 on rex/u)).toBeTruthy();
    expect(screen.getByText("Update available")).toBeTruthy();
    expect(screen.getByText("Tau 0.7.14 is available.", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(hostUpdate).toHaveBeenCalledWith("install"));
    expect(await screen.findByText("Tau 0.7.14 installs when the running turn ends.", { exact: false })).toBeTruthy();
    // The host's pushes move it on.
    act(() => client.emit({ type: "update-status", status: { ...STATUS, phase: "installing" } }));
    expect(screen.getByRole("button", { name: "Installing…" })).toHaveProperty("disabled", true);
  });

  it("checks when nothing is pending, and turns automatic updates off", async () => {
    const { hostUpdate, setHostUpdateSettings } = renderSection({ status: { ...STATUS, phase: "current", latest: "0.7.6" } });
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(hostUpdate).toHaveBeenCalledWith("check"));
    fireEvent.click(screen.getByRole("switch", { name: "Automatic updates" }));
    await waitFor(() => expect(setHostUpdateSettings).toHaveBeenCalledWith({ automatic: false }));
    expect(screen.queryByRole("switch", { name: "Paired devices may update this machine" })).toBeNull();
  });

  it("offers the owner the device switch, and a Read-only device no install", async () => {
    renderSection({ owner: true });
    expect(await screen.findByRole("switch", { name: "Paired devices may update this machine" })).toBeTruthy();
    cleanup();
    renderSection({ readOnly: true });
    expect(await screen.findByRole("button", { name: "Update now" })).toHaveProperty("disabled", true);
    cleanup();
    renderSection({ status: { ...STATUS, devicesMayInstall: false } });
    expect(await screen.findByRole("button", { name: "Update now" })).toHaveProperty("disabled", true);
  });

  it("says why a copy cannot update itself", async () => {
    renderSection({ status: { ...STATUS, phase: "unsupported", installer: "none", reason: "This Tau runs from a checkout." } });
    expect(await screen.findByText("This Tau runs from a checkout.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Automatic updates" })).toBeNull();
  });

  it("falls back to the window's own check where the host is too old to answer", async () => {
    renderSection({ refuse: "Unknown method update-status" });
    expect(await screen.findByText("window check")).toBeTruthy();
  });
});
