// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderApp } from "./test-support/render-app";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension } from "./extension-system";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

it.each([
  "rex runs an older Tau that cannot take messages from here yet. Update rex in Settings → Machines.",
  "rex runs an older Tau that cannot start threads yet. Update rex in Settings → Machines.",
  "rex has no Files that can do this yet. Update rex.",
])("opens Machines from the one action on a compatibility toast: %s", async (message) => {
  const machines: DesktopExtension = {
    id: "test.machines", name: "Machines",
    activate(context) { context.registerSettingsPage({ id: "environments.machines", label: "Machines", group: "remote", Component: () => <p>Machine settings target</p> }); },
  };
  const client = createFakeHostClient();
  renderApp(client, { extensions: [machines] });
  await screen.findByRole("button", { name: "Send" });
  act(() => client.emit({ type: "error", message }));
  const action = await screen.findByRole("button", { name: "Machines" });
  const toast = action.closest(".toast-item")!;
  expect(toast.querySelectorAll(".toast-actions button")).toHaveLength(1);
  fireEvent.click(action);
  expect(await screen.findByText("Machine settings target")).toBeTruthy();
});

it("leaves ordinary errors on their existing toast without a Machines action", async () => {
  const client = createFakeHostClient();
  renderApp(client);
  await screen.findByRole("button", { name: "Send" });
  act(() => client.emit({ type: "error", message: "rex is not reachable right now." }));
  expect(await screen.findByText("rex is not reachable right now.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Machines" })).toBeNull();
});
