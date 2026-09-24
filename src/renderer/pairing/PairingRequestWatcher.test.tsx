// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiConnections, UiPairingRequest } from "../../shared/connections";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { PairingRequestWatcher } from "./PairingRequestWatcher";

afterEach(cleanup);

const request: UiPairingRequest = {
  id: "r1", name: "Alex’s iPhone", device: { kind: "phone", browser: "Safari", os: "iOS" }, address: "192.0.2.9",
  verification: "482913", access: "full", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
};

const listed = (requests: UiPairingRequest[]): UiConnections => ({ scheme: "ws", endpoints: [], webClient: true, tokenPath: "", links: [], requests, clients: [], owners: [] });

describe("a device asking to pair, wherever the owner is", () => {
  it("asks the owner at once and lets the device in with the access picked", async () => {
    let requests: UiPairingRequest[] = [];
    const approvePairing = vi.fn(async () => ({ approved: true }));
    const client = createFakeHostClient({ listConnections: async () => listed(requests), approvePairing });
    render(<TestProviders><HostClientProvider client={client}><PairingRequestWatcher /></HostClientProvider></TestProviders>);
    requests = [request];
    act(() => client.emit({ type: "connections-changed" }));
    const dialog = await screen.findByRole("dialog", { name: "Alex’s iPhone wants to connect" });
    expect(within(dialog).getByText("482 913")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Read only" }));
    requests = [];
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(approvePairing).toHaveBeenCalledWith("r1", { access: "read-only" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stops asking in a window that is not the owner's", async () => {
    const listConnections = vi.fn(async () => { throw Object.assign(new Error("no"), { code: "forbidden" }); });
    const client = createFakeHostClient({ listConnections });
    render(<TestProviders><HostClientProvider client={client}><PairingRequestWatcher /></HostClientProvider></TestProviders>);
    act(() => client.emit({ type: "connections-changed" }));
    await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(1));
    act(() => client.emit({ type: "connections-changed" }));
    await Promise.resolve();
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
