// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ConnectStatus } from "../../shared/connect";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ConnectSettings } from "./ConnectSettings";

it("shows a removed route and registers again through the existing removal flow", async () => {
  const relay = "https://relay.example";
  const removeConnect = vi.fn(async (): Promise<ConnectStatus> => ({ phase: "disabled" }));
  const configureConnect = vi.fn(async (): Promise<ConnectStatus> => ({ phase: "connected", relay }));
  const createConnectLink = vi.fn(async () => ({ link: "unused" }));
  const client = createFakeHostClient({ connectStatus: async () => ({ phase: "removed", relay, detail: "This machine's registration was removed from the relay." }), removeConnect, configureConnect, createConnectLink });
  render(<TestProviders><HostClientProvider client={client}><ConnectSettings onNotify={vi.fn()} /></HostClientProvider></TestProviders>);
  expect((await screen.findByRole("status")).textContent).toContain("Removed from relay");
  expect(await screen.findByText("This machine's registration was removed from the relay.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Copy pairing link" }) as HTMLButtonElement).disabled).toBe(true);
  const again = await screen.findByRole("button", { name: "Register again" });
  fireEvent.click(again);
  const address = await screen.findByLabelText("Relay address");
  expect((address as HTMLInputElement).value).toBe(relay);
  const token = await screen.findByLabelText("Enrollment token");
  fireEvent.change(token, { target: { value: "test-enrollment-token" } });
  const register = screen.getByRole("button", { name: "Register this machine" }) as HTMLButtonElement;
  await waitFor(() => expect(register.disabled).toBe(false));
  fireEvent.click(register);
  await waitFor(() => expect(configureConnect).toHaveBeenCalledWith({ relay, enrollmentToken: "test-enrollment-token" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
  expect(removeConnect).toHaveBeenCalledOnce(); expect(createConnectLink).not.toHaveBeenCalled();
});
