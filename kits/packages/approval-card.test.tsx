// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import packagesKit from "./desktop.js";
import { INSTALL_REQUESTS_EVENT, type InstallRequest } from "./install-protocol.js";
import { PACKAGES_EXTENSION_ID } from "./protocol.js";

const registries: Array<{ deactivate(id: string): void }> = [];
afterEach(() => {
  cleanup();
  for (const registry of registries.splice(0)) registry.deactivate(packagesKit.id);
});

const request = (overrides: Partial<InstallRequest> = {}): InstallRequest => ({
  id: "r1", threadId: "s1", status: "pending", packageId: "acme.hello", name: "Hello", version: "1.0.0", description: "Copies the branch name",
  permissions: ["sessions", "native"], isolation: "worker", ...overrides,
});

function setup(initial: InstallRequest[], canManage = true, answer: (command: string) => unknown = () => ({})) {
  let held = initial;
  const invoke = vi.fn(async (_extensionId: string, command: string) => {
    if (command === "install-requests") return { requests: held, canManage };
    return answer(command);
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(packagesKit);
  registries.push(registry);
  const publish = (list: InstallRequest[]) => act(() => {
    held = list;
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: PACKAGES_EXTENSION_ID, name: INSTALL_REQUESTS_EVENT, payload: { requests: list } });
  });
  const actions = { openSettings: vi.fn(), activeThread: () => ({ sessionId: "s1", draftPending: false }) } as unknown as WorkbenchActions;
  const draw = (sessionId = "s1") => {
    const { Component } = registry.getRegions("composer-above").find((region) => region.id === "packages.install-request")!;
    return render(<Component snapshot={{ sessionId } as HostSnapshot} actions={actions} />);
  };
  return { invoke, publish, actions, draw };
}

describe("Allow-package card above the composer", () => {
  it("shows the package, what it asks for and how it is isolated, from the data the host sends", async () => {
    const { draw } = setup([request()]);
    draw();
    expect(await screen.findByRole("region", { name: "Allow Hello" })).toBeTruthy();
    expect(screen.getByText("Copies the branch name")).toBeTruthy();
    expect(screen.getByText("Read and write threads")).toBeTruthy();
    expect(screen.getByText("Load compiled code into Tau")).toBeTruthy();
    expect(screen.getByText(/runs in a process of its own/u)).toBeTruthy();
  });

  it("warns about a package that runs in Tau's own process", async () => {
    const { draw } = setup([request({ isolation: "in-process", permissions: [] })]);
    draw();
    expect((await screen.findByRole("note")).textContent).toContain("runs inside Tau's own process");
    expect(screen.getByText("It asks for no permissions.")).toBeTruthy();
  });

  it("shows only the card of the thread on screen, and follows the host's list", async () => {
    const { draw, publish } = setup([]);
    const view = draw("s2");
    await publish([request({ threadId: "s1" })]);
    expect(view.container.querySelector(".install-card")).toBeNull();
    view.unmount();
    draw("s1");
    expect(await screen.findByRole("region", { name: "Allow Hello" })).toBeTruthy();
    await publish([]);
    expect(screen.queryByRole("region", { name: "Allow Hello" })).toBeNull();
  });

  it("Allow and turn on asks the host once and shows that it is working", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { draw, invoke } = setup([request()], true, () => new Promise((resolve) => { finish = resolve; }));
    draw();
    const allow = await screen.findByRole("button", { name: "Allow and turn on" });
    fireEvent.click(allow);
    expect(await screen.findByRole("button", { name: "Allowing…" })).toHaveProperty("disabled", true);
    expect(invoke.mock.calls.filter((call) => call[1] === "allow-install")).toEqual([[PACKAGES_EXTENSION_ID, "allow-install", { id: "r1" }]]);
    await act(async () => finish({ running: true }));
  });

  it("Not now declines, and a refused Allow shows why and stays answerable", async () => {
    const { draw, invoke } = setup([request()], true, (command) => { if (command === "allow-install") throw new Error("The package was not allowed."); return {}; });
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Allow and turn on" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not allowed");
    expect(screen.getByRole("button", { name: "Allow and turn on" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "decline-install", { id: "r1" }));
  });

  it("Details opens the package's page in Settings", async () => {
    const { draw, actions } = setup([request()]);
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(actions.openSettings).toHaveBeenCalledWith("extensions/acme.hello");
  });

  it("leaves the buttons off for a connection that may not answer", async () => {
    const { draw } = setup([request()], false);
    draw();
    expect(await screen.findByText(/Allow it in this machine's own Tau window/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow and turn on" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Not now" })).toHaveProperty("disabled", true);
  });
});
