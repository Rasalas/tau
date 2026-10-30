// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UiLocalMcpStatus } from "../../shared/external-mcp";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ExternalMcpSettings } from "./ExternalMcpSettings";

const url = "http://127.0.0.1:41234/mcp";

function setup(owner = true) {
  let status: UiLocalMcpStatus = { enabled: false, listening: false, protocolVersion: "2025-11-25", tokens: [], projects: [{ id: "ws-a", name: "Alpha" }, { id: "ws-b", name: "Beta" }] };
  const manageExternalMcp = vi.fn(async (input: Record<string, unknown>) => {
    if (input.action === "local-create") {
      status = { ...status, enabled: true, listening: true, url, tokens: [{ id: "g1", name: String(input.name), scopes: input.control ? ["tau:read", "tau:threads"] : ["tau:read"], projectIds: input.projectIds as string[], execution: (input.execution ?? "read-only") as "ask", createdAt: 1 }] };
      return { token: "tau_mcp_local_secret", id: "g1", url };
    }
    if (input.action === "local-revoke") { status = { ...status, tokens: [] }; return { revoked: true }; }
    return status;
  });
  const copyText = vi.fn(async () => undefined);
  const client = createFakeHostClient({ manageExternalMcp, copyText, isOwner: () => owner });
  render(<TestProviders><HostClientProvider client={client}><ExternalMcpSettings onNotify={vi.fn()} /></HostClientProvider></TestProviders>);
  return { manageExternalMcp, copyText };
}

it("creates a control token with an ask ceiling, reveals it once with a Claude Code command, and revokes it", async () => {
  const { manageExternalMcp, copyText } = setup();
  expect((await screen.findByRole("status")).textContent).toContain("Off.");
  fireEvent.click(screen.getByRole("button", { name: "Create token…" }));
  fireEvent.change(screen.getByLabelText("Client name"), { target: { value: "Claude Code" } });
  fireEvent.click(screen.getByLabelText("Alpha"));
  fireEvent.click(screen.getByLabelText("It may start threads and steer or stop the threads it started"));
  expect((screen.getByLabelText("Execution ceiling") as HTMLSelectElement).value).toBe("ask");
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  await waitFor(() => expect(manageExternalMcp).toHaveBeenCalledWith({ action: "local-create", name: "Claude Code", projectIds: ["ws-a"], control: true, execution: "ask", expiresInDays: 90 }));
  const configuration = await screen.findByLabelText("Client configuration");
  expect(configuration.textContent).toBe(`claude mcp add --transport http tau ${url} --header "Authorization: Bearer tau_mcp_local_secret"`);
  fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(configuration.textContent));
  expect(await screen.findByText(/Reads, starts threads · Ask before edits/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(/tau_mcp_local_secret/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revoke Claude Code" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(manageExternalMcp).toHaveBeenCalledWith({ action: "local-revoke", id: "g1" }));
});

it("shows nothing to a device that does not own the machine", async () => {
  const { manageExternalMcp } = setup(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("MCP clients")).toBeNull();
  expect(manageExternalMcp).not.toHaveBeenCalled();
});
