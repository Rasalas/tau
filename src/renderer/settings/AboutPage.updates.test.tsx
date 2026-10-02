// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus } from "../../shared/host-updates";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { AboutPage, describeMachine } from "./AboutPage";

afterEach(cleanup);

const STATUS: HostUpdateStatus = { version: "0.7.6", phase: "available", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", method: "deb", devicesMayInstall: true, platform: "linux", arch: "x64" };

function renderPage(options: { status?: HostUpdateStatus; owner?: boolean; readOnly?: boolean; refuse?: string; local?: boolean } = {}) {
  const hostUpdate = vi.fn(async (action: "status" | "check" | "install") => {
    if (options.refuse) throw Object.assign(new Error(options.refuse), { code: "unknown-method" });
    return action === "install" ? { ...(options.status ?? STATUS), phase: "waiting" as const, runningTurns: 1 } : options.status ?? STATUS;
  });
  const setHostUpdateSettings = vi.fn(async (settings: { automatic?: boolean; devicesMayInstall?: boolean }) => ({ ...(options.status ?? STATUS), ...settings }));
  const windowAction = vi.fn(async () => undefined);
  const client = createFakeHostClient({
    hostUpdate,
    setHostUpdateSettings,
    windowAction,
    getVersions: () => ({ host: "0.7.6", window: "0.7.6" }),
    getHostName: () => "rex",
    hasCapability: () => options.local ?? false,
    isOwner: () => options.owner ?? false,
    isReadOnly: () => options.readOnly ?? false,
  });
  render(<TestProviders><HostClientProvider client={client}><AboutPage loader={async () => []} /></HostClientProvider></TestProviders>);
  return { client, hostUpdate, setHostUpdateSettings, windowAction };
}

describe("Settings → About → updates (K103, design 2k)", () => {
  it("names the remote machine and asks before updating it", async () => {
    const { hostUpdate } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Update rex" }));
    expect(hostUpdate).not.toHaveBeenCalledWith("install");
    expect(await screen.findByRole("dialog", { name: "Update Tau on rex?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update machine" }));
    await waitFor(() => expect(hostUpdate).toHaveBeenCalledWith("install"));
  });

  it("shows the host machine's version and a newer release, and installs it on Update now", async () => {
    const { hostUpdate, client } = renderPage({ owner: true });
    expect(await screen.findByText("Tau 0.7.14 is available.", { exact: false })).toBeTruthy();
    expect(screen.getByText("0.7.6")).toBeTruthy();
    expect(screen.getByText(/Stable · rex · Linux, x64/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(hostUpdate).toHaveBeenCalledWith("install"));
    expect(await screen.findByText("Tau 0.7.14 installs when the running turn ends.", { exact: false })).toBeTruthy();
    // The host's pushes move it on.
    act(() => client.emit({ type: "update-status", status: { ...STATUS, phase: "installing" } }));
    expect(screen.getByRole("button", { name: "Installing…" })).toHaveProperty("disabled", true);
  });

  it("checks when nothing is pending, and turns automatic updates off", async () => {
    const { hostUpdate, setHostUpdateSettings } = renderPage({ status: { ...STATUS, phase: "current", latest: "0.7.6" } });
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(hostUpdate).toHaveBeenCalledWith("check"));
    fireEvent.click(screen.getByRole("switch", { name: "Automatic updates" }));
    await waitFor(() => expect(setHostUpdateSettings).toHaveBeenCalledWith({ automatic: false }));
    expect(screen.queryByRole("switch", { name: "Paired devices may update this machine" })).toBeNull();
    // A host elsewhere keeps its own channel.
    expect(screen.queryByRole("switch", { name: "Pre-release builds" })).toBeNull();
  });

  it("offers the owner the device switch, and a Read-only device no install", async () => {
    renderPage({ owner: true });
    expect(await screen.findByRole("switch", { name: "Paired devices may update this machine" })).toBeTruthy();
    cleanup();
    renderPage({ readOnly: true });
    expect(await screen.findByRole("button", { name: "Update rex" })).toHaveProperty("disabled", true);
    cleanup();
    renderPage({ status: { ...STATUS, devicesMayInstall: false } });
    expect(await screen.findByRole("button", { name: "Update rex" })).toHaveProperty("disabled", true);
  });

  it("says why a copy cannot update itself, and offers no update controls", async () => {
    renderPage({ local: true, status: { ...STATUS, phase: "unsupported", installer: "none", reason: "Tau Dev is built from source and does not update itself." } });
    expect(await screen.findByText("Tau Dev is built from source and does not update itself.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Automatic updates" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Pre-release builds" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("falls back to the window's own check where the host is too old to answer", async () => {
    const { windowAction } = renderPage({ refuse: "Unknown method update-status" });
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(windowAction).toHaveBeenCalledWith({ kind: "check-for-updates" }));
  });

  it("names the host's chip the way people do", () => {
    expect(describeMachine("darwin", "arm64")).toBe("macOS, Apple silicon");
    expect(describeMachine("darwin", "x64")).toBe("macOS, Intel");
    expect(describeMachine("win32", "x64")).toBe("Windows, x64");
    expect(describeMachine(undefined, "x64")).toBeUndefined();
  });
});
