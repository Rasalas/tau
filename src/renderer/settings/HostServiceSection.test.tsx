// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiHostService } from "../../shared/connections";
import type { HostClient } from "../../workbench/host-client";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { HostServiceSection } from "./HostServiceSection";

afterEach(cleanup);

function service(overrides: Partial<UiHostService> = {}): UiHostService {
  return {
    supported: true,
    manager: "launchd",
    label: "dev.tbuck.tau.host",
    installed: false,
    running: false,
    serving: false,
    stale: false,
    unitPath: "/Users/me/Library/LaunchAgents/dev.tbuck.tau.host.plist",
    logPath: "/Users/me/Library/Application Support/tau/logs/host-service.log",
    problems: [],
    ...overrides,
  };
}

function renderSection(overrides: Partial<HostClient>) {
  const notify = vi.fn();
  render(<TestProviders><HostClientProvider client={createFakeHostClient(overrides)}><HostServiceSection onNotify={notify} /></HostClientProvider></TestProviders>);
  return notify;
}

describe("Settings → Connections → Background", () => {
  it("installs the service only after asking, and reports the host it started", async () => {
    let current = service();
    const installService = vi.fn(async () => { current = service({ installed: true, running: true, serving: true, version: "0.4.0" }); return current; });
    const notify = renderSection({ serviceStatus: async () => current, installService });

    expect(await screen.findByText("Not installed")).toBeTruthy();
    expect(screen.getByText(/A LaunchAgent starts Tau’s host when you log in/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install…" }));
    expect(installService).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("Tau’s host runs as a service"));
    expect(screen.getByText("Running · Tau 0.4.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Uninstall…" })).toBeTruthy();
  });

  it("reports the service by its status even when the call itself lost its connection", async () => {
    let current = service();
    const installService = vi.fn(async () => {
      current = service({ installed: true, running: true });
      throw new Error("The host connection dropped.");
    });
    const notify = renderSection({ serviceStatus: async () => current, installService });
    fireEvent.click(await screen.findByRole("button", { name: "Install…" }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Tau’s host runs as a service"));
  });

  it("shows what needs fixing with the command that fixes it, and offers a repair", async () => {
    renderSection({
      serviceStatus: async () => service({
        manager: "systemd",
        installed: true,
        running: true,
        problems: [{ code: "linger-disabled", message: "Lingering is off.", command: "sudo loginctl enable-linger \"$(id -un)\"" }],
      }),
    });
    expect(await screen.findByText("Running, needs repair")).toBeTruthy();
    expect(screen.getByText("sudo loginctl enable-linger \"$(id -un)\"")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repair…" })).toBeTruthy();
  });

  it("removes the service only after asking", async () => {
    let current = service({ installed: true, running: true });
    const uninstallService = vi.fn(async () => { current = service(); return current; });
    const notify = renderSection({ serviceStatus: async () => current, uninstallService });
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove service" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("The service is removed"));
    expect(uninstallService).toHaveBeenCalledOnce();
  });

  it("says why a machine cannot run it, and what a host without the methods is", async () => {
    renderSection({ serviceStatus: async () => service({ supported: false, reason: "An AppImage is mounted at a new path on every start." }) });
    expect(await screen.findByText("An AppImage is mounted at a new path on every start.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install…" })).toBeNull();
    cleanup();
    renderSection({});
    expect(await screen.findByText("This host does not manage a service of its machine.")).toBeTruthy();
  });

  it("lists the service's files with a copy button each", async () => {
    const copyText = vi.fn(async () => undefined);
    renderSection({ serviceStatus: async () => service({ installed: true, running: true }), copyText });
    const files = await screen.findByLabelText("Service files");
    expect(files.textContent).toContain("/Users/me/Library/LaunchAgents/dev.tbuck.tau.host.plist");
    fireEvent.click(screen.getByRole("button", { name: "Copy Log" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("/Users/me/Library/Application Support/tau/logs/host-service.log"));
  });

  it("says when the service did not answer, and asks again", async () => {
    let calls = 0;
    const serviceStatus = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("The host did not answer in time."); return service(); });
    renderSection({ serviceStatus });
    expect(await screen.findByText("The host did not answer in time.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Not installed")).toBeTruthy();
  });

  it("offers keeping the machine awake while turns run", async () => {
    renderSection({ serviceStatus: async () => service() });
    expect(await screen.findByRole("switch", { name: "Keep this machine awake while turns run" })).toBeTruthy();
  });
});

describe("Settings → Connections → Background, invisible display", () => {
  const display = { supported: true, installed: true, display: ":99", xvfbRunning: true, windowRunning: false, idleMinutes: 10 };
  const linux = (overrides: Partial<UiHostService> = {}) => service({ manager: "systemd", label: "tau-host.service", installed: true, running: true, ...overrides });

  it("shows the display of a Linux service and removes it only after asking", async () => {
    let current = linux({ display });
    const installService = vi.fn(async () => { current = linux({ display: { ...display, installed: false, display: undefined, xvfbRunning: false } }); return current; });
    const notify = renderSection({ serviceStatus: async () => current, installService });

    expect(await screen.findByText(":99 · window starts when needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    expect(installService).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove display" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("The invisible display is removed"));
    expect(installService).toHaveBeenCalledWith({ display: false });
    expect(screen.getByRole("button", { name: "Add…" })).toBeTruthy();
  });

  it("adds the AppArmor profile the display's window needs with a button, not a command to copy", async () => {
    const sandbox = { code: "chrome-sandbox", message: "The window on the invisible display cannot start.", command: "tau service install" };
    let current = linux({ display, problems: [sandbox] });
    const allowServiceSandbox = vi.fn(async () => { current = linux({ display }); return current; });
    const notify = renderSection({ serviceStatus: async () => current, allowServiceSandbox });

    expect(await screen.findByText("The window on the invisible display cannot start.")).toBeTruthy();
    expect(screen.queryByText("tau service install")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add AppArmor profile…" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("The window on the invisible display can start now"));
    expect(allowServiceSandbox).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Add AppArmor profile…" })).toBeNull();
  });

  it("says why the profile could not be added", async () => {
    const sandbox = { code: "chrome-sandbox", message: "The window on the invisible display cannot start.", command: "tau service install" };
    const allowServiceSandbox = vi.fn(async () => { throw new Error("No password dialog could open on this machine."); });
    const notify = renderSection({ serviceStatus: async () => linux({ display, problems: [sandbox] }), allowServiceSandbox });
    fireEvent.click(await screen.findByRole("button", { name: "Add AppArmor profile…" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("No password dialog could open on this machine."));
  });

  it("is not offered on macOS or without a service", async () => {
    renderSection({ serviceStatus: async () => service({ installed: true, running: true, display: { ...display, supported: false, installed: false, reason: "macOS has no invisible display." } }) });
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.queryByText("Invisible display")).toBeNull();
  });
});
