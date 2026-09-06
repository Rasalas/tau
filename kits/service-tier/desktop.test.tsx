// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { serviceTierKitExtension } from "./desktop.js";

afterEach(cleanup);

function activate(state: { tier: "standard" | "fast"; available: boolean }) {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => {
    if (command === "set-tier") state = { ...state, tier: (input as { tier: "standard" | "fast" }).tier };
    return state;
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(serviceTierKitExtension);
  return { registry, invoke };
}

describe("Service Tier Kit desktop extension", () => {
  it("shows nothing while the model's API offers no tier", async () => {
    const { registry, invoke } = activate({ tier: "standard", available: false });
    const [control] = registry.getComposerControls();
    const view = render(<control.Component snapshot={{ sessionId: "s", model: { provider: "p", id: "m" } } as unknown as HostSnapshot} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("tau.service-tier", "state", undefined));
    expect(view.container.querySelector(".runtime-chip")).toBeNull();
  });

  it("offers the tier menu when available and sets the tier through the host", async () => {
    const { registry, invoke } = activate({ tier: "standard", available: true });
    const [control] = registry.getComposerControls();
    render(<control.Component snapshot={{ sessionId: "s", model: { provider: "p", id: "m" } } as unknown as HostSnapshot} />);
    const chip = await screen.findByRole("button", { name: /standard/u });
    fireEvent.click(chip);
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /^Fast/u })); });
    expect(invoke).toHaveBeenCalledWith("tau.service-tier", "set-tier", { tier: "fast" });
    await screen.findByRole("button", { name: /fast/u });
  });

  it("follows tier changes the host announces", async () => {
    const { registry } = activate({ tier: "standard", available: true });
    const [control] = registry.getComposerControls();
    render(<control.Component snapshot={{ sessionId: "s" } as unknown as HostSnapshot} />);
    await screen.findByRole("button", { name: /standard/u });
    act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "tau.service-tier", name: "state", payload: { tier: "fast", available: true } }));
    await screen.findByRole("button", { name: /fast/u });
  });
});
