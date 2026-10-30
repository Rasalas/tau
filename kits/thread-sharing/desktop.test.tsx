// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness, expectKitActivatesCleanly, HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import sharing from "./desktop.js";
import { SHARING_ID, type SharingState } from "./protocol.js";

const releases: Array<() => void> = [];
afterEach(() => { cleanup(); for (const release of releases.splice(0)) release(); });
function fixture(state: SharingState, readOnly = false) {
  const invoke = vi.fn(async (_id: string, command: string) => command === "state" ? state : command === "create" ? { id: "grant", url: "https://test.ts.net/extensions/tau.thread-sharing/guest#guest=taug.private" } : undefined);
  const { registry, preferences } = createKitHarness(invoke);
  const client = createFakeHostClient({ isReadOnly: () => readOnly });
  registry.activate(sharing); releases.push(() => registry.deactivate(SHARING_ID));
  const actions = { activeThread: () => ({ sessionId: "one" }), notify: vi.fn(), copyText: vi.fn(async () => undefined) } as unknown as WorkbenchActions;
  const wrap = (children: ReactNode) => <HostClientProvider client={client}><TestProviders preferences={preferences}>{children}</TestProviders></HostClientProvider>;
  return { registry, invoke, actions, wrap };
}
const initial = (): SharingState => ({ owner: true, enabled: true, available: true, toolOutputThreads: ["one"], links: [] });
describe("guest sharing workbench UI", () => {
  it("registers and removes the extension's contributions", async () => {
    await expect(expectKitActivatesCleanly(sharing, async () => initial())).resolves.toBeUndefined();
  });
  it("shows an empty settings state and prevents management by a paired device", async () => {
    const f = fixture({ ...initial(), owner: false });
    const section = f.registry.getSettingsSections("connections")[0]!;
    render(f.wrap(<section.Component onNotify={vi.fn()} onChanged={vi.fn()} />));
    await screen.findByText("No thread is shared.");
    const toggle = screen.getByRole("switch", { name: "Allow guest links" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(f.registry.getCommands().find((c) => c.id === "thread-sharing.share")?.unavailable?.()).toContain("own Tau window");
  });
  it("creates a bounded expiring link only on explicit action and copies only on Copy link", async () => {
    const f = fixture(initial());
    const header = f.registry.getRegions("thread-title")[0]!;
    render(f.wrap(<header.Component actions={f.actions} snapshot={{ sessionId: "one" } as HostSnapshot} />));
    const command = f.registry.getCommands().find((c) => c.id === "thread-sharing.share")!;
    await waitFor(() => expect(command.unavailable?.()).toBeUndefined());
    await command.run(f.actions);
    await screen.findByRole("dialog", { name: "Share with a guest" });
    const output = screen.getByRole("checkbox", { name: "Show tool output" }) as HTMLButtonElement;
    expect(output.disabled).toBe(false);
    expect(output.getAttribute("aria-checked")).toBe("false");
    expect(f.invoke.mock.calls.some(([, name]) => name === "create")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    const copy = await screen.findByRole("button", { name: "Copy link" });
    expect(f.invoke).toHaveBeenCalledWith(SHARING_ID, "create", { threadId: "one", hours: 8, mode: "suggest", showToolOutput: false });
    expect(f.actions.copyText).not.toHaveBeenCalled();
    fireEvent.click(copy);
    await waitFor(() => expect(f.actions.copyText).toHaveBeenCalledWith(expect.stringContaining("#guest=")));
  });
  it("sends tool output opt-in only after the owner checks it", async () => {
    const f = fixture(initial()); const header = f.registry.getRegions("thread-title")[0]!;
    render(f.wrap(<header.Component actions={f.actions} snapshot={{ sessionId: "one" } as HostSnapshot} />));
    const command = f.registry.getCommands().find((c) => c.id === "thread-sharing.share")!;
    await waitFor(() => expect(command.unavailable?.()).toBeUndefined()); await command.run(f.actions);
    await screen.findByRole("dialog", { name: "Share with a guest" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show tool output" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(SHARING_ID, "create", { threadId: "one", hours: 8, mode: "suggest", showToolOutput: true }));
  });
  it("keeps the checkbox disabled when the selected thread lacks a public projection", async () => {
    const f = fixture({ ...initial(), toolOutputThreads: [] }); const header = f.registry.getRegions("thread-title")[0]!;
    render(f.wrap(<header.Component actions={f.actions} snapshot={{ sessionId: "one" } as HostSnapshot} />));
    const command = f.registry.getCommands().find((c) => c.id === "thread-sharing.share")!;
    await waitFor(() => expect(command.unavailable?.()).toBeUndefined()); await command.run(f.actions);
    await screen.findByRole("dialog", { name: "Share with a guest" });
    const output = screen.getByRole("checkbox", { name: "Show tool output" }) as HTMLButtonElement;
    expect(output.disabled).toBe(true); expect(output.getAttribute("aria-checked")).toBe("false");
  });
  it("explains the existing HTTPS requirement without promising a Tau Connect guest tunnel", async () => {
    const f = fixture({ ...initial(), available: false }); const section = f.registry.getSettingsSections("connections")[0]!;
    render(f.wrap(<section.Component onNotify={vi.fn()} onChanged={vi.fn()} />));
    await screen.findByText(/Tau Connect's WebSocket relay does not serve guest pages/);
    expect(screen.getByText(/Guests need a published HTTPS address/).textContent).toContain("The guest must be able to reach that HTTPS address.");
  });
  it("keeps Send disabled until the suggestion card is focused or hovered", async () => {
    const state = initial();
    state.links = [{ id: "g", threadId: "one", title: "One", mode: "suggest", claimed: true, watching: true, expiresAt: Date.now() + 60_000, suggestions: [{ id: "s", text: "Review this", images: [], state: "pending" }] }];
    const f = fixture(state);
    const region = f.registry.getRegions("composer-above")[0]!;
    render(f.wrap(<region.Component actions={f.actions} snapshot={{ sessionId: "one" } as HostSnapshot} />));
    const card = await screen.findByRole("region", { name: "Guest suggests" });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(f.invoke.mock.calls.some(([, command]) => command === "send")).toBe(false);
    fireEvent.focus(card);
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith(SHARING_ID, "send", { id: "g", suggestionId: "s" }));
  });
  it("shows proposals but disables both decisions for Read only", async () => {
    const state = initial();
    state.links = [{ id: "g", threadId: "one", title: "One", mode: "suggest", claimed: true, watching: true, expiresAt: Date.now() + 60_000, suggestions: [{ id: "s", text: "Read only proposal", images: [], state: "pending" }] }];
    const f = fixture(state, true);
    const region = f.registry.getRegions("composer-above")[0]!;
    render(f.wrap(<region.Component actions={f.actions} snapshot={{ sessionId: "one" } as HostSnapshot} />));
    fireEvent.focus(await screen.findByRole("region", { name: "Guest suggests" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
