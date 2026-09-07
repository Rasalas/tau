// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { antigravityExtension, signInLinks } from "./desktop.js";

describe("Antigravity desktop extension", () => {
  it("marks Antigravity threads in the status line and opens a reported sign-in link once", () => {
    const { registry } = createKitHarness();
    registry.activate(antigravityExtension);
    const [item] = registry.getStatusItems();
    expect(item?.id).toBe("antigravity.runtime");
    const Component = item!.Component;
    const actions = { openExternal: vi.fn(), notify: vi.fn() } as never;
    const { rerender } = render(<Component snapshot={{ backendKind: "antigravity", model: { provider: "google", id: "g", name: "Gemini 3.8 Flash (Low)" } } as HostSnapshot} actions={actions} />);
    expect(screen.getByText("Antigravity")).toBeTruthy();
    rerender(<Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByText("Antigravity")).toBeNull();

    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=x";
    act(() => signInLinks.report(url));
    expect((actions as { openExternal: ReturnType<typeof vi.fn> }).openExternal).toHaveBeenCalledWith(url);
    expect(screen.getByLabelText("Open the Google sign-in link")).toBeTruthy();
    act(() => signInLinks.clear());
    expect(screen.queryByText("Antigravity")).toBeNull();
  });
});
