// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import PrivateSecretFiles from "./card.js";
import { SecretFilesFeed } from "./feed.js";
import type { SecretFileRequest, SecretFilesState } from "./protocol.js";

afterEach(cleanup);
const request: SecretFileRequest = { id: "request", threadId: "thread", label: "Deployment key", reason: "Authenticate the CLI", filename: "key.pem", lifetimeMinutes: 60, status: "pending", expiresAt: Date.now() + 600_000 };
function setup(patch: Partial<SecretFilesState> = {}, failSave = false) {
  let state: SecretFilesState = { canManage: true, requests: [structuredClone(request)], ...patch };
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "state") return structuredClone(state);
    if (command === "submit") {
      if (failSave) throw new Error("The machine disconnected.");
      const lifetimeMinutes = (input as { lifetimeMinutes: number }).lifetimeMinutes;
      state = { ...state, requests: [{ ...request, lifetimeMinutes, status: "ready", expiresAt: Date.now() + lifetimeMinutes * 60_000 }] };
    }
    if (command === "revoke") state = { ...state, requests: [{ ...request, status: "ended", saved: true }] };
    if (command === "decline") state = { ...state, requests: [{ ...request, status: "declined" }] };
    return undefined;
  });
  const feed = new SecretFilesFeed({ invoke, onEvent: () => () => undefined } as HostExtensionClient);
  const actions = { activeThread: () => ({ sessionId: "thread" }) } as unknown as WorkbenchActions;
  render(<><div className="composer-frame"><textarea aria-label="Composer" defaultValue="Unsent message" /></div><PrivateSecretFiles actions={actions} feed={feed} /></>);
  return { invoke };
}

it("saves through the private field, allows a shorter lifetime and offers immediate deletion", async () => {
  const h = setup();
  const field = await screen.findByLabelText("Deployment key") as HTMLInputElement;
  expect(field.type).toBe("password");
  expect((screen.getByRole("textbox", { name: "Composer" }) as HTMLTextAreaElement).value).toBe("Unsent message");
  const lifetime = screen.getByRole("combobox", { name: "Keep for" });
  expect([...lifetime.querySelectorAll("option")].map((option) => option.value)).toEqual(["15", "60"]);
  fireEvent.change(lifetime, { target: { value: "15" } });
  fireEvent.change(field, { target: { value: "private-ui-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Save for commands" }));
  expect(field.value).toBe("");
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("submit", { id: "request", value: "private-ui-value", lifetimeMinutes: 15 }));
  expect(await screen.findByText(/Saved for commands/u)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private-ui-value");
  fireEvent.click(screen.getByRole("button", { name: "Delete now" }));
  expect(await screen.findByText("Deleted. Commands that read it will fail.")).toBeTruthy();
});

it("keeps the value cleared after a failed save and reports the cause", async () => {
  setup({}, true);
  const field = await screen.findByLabelText("Deployment key") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "private-ui-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Save for commands" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The machine disconnected.");
  expect(field.value).toBe("");
});

it("lets other devices see the request without accepting the secret", async () => {
  setup({ canManage: false });
  const field = await screen.findByLabelText("Deployment key") as HTMLInputElement;
  expect(field.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save for commands" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Save this in this machine's own Tau window.")).toBeTruthy();
});

it("shows only requests belonging to the active thread", async () => {
  const h = setup({ requests: [{ ...request, threadId: "other-thread" }] });
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("state"));
  expect(screen.queryByLabelText("Deployment key")).toBeNull();
});

it("leaves terminal focus alone when a private request arrives", async () => {
  const terminal = document.createElement("input"); document.body.append(terminal); terminal.focus();
  setup({ requests: [{ ...request }] });
  (screen.getByRole("textbox", { name: "Composer" }) as HTMLTextAreaElement).value = "";
  await screen.findByLabelText("Deployment key");
  expect(document.activeElement).toBe(terminal);
  terminal.remove();
});
it("distinguishes an unsaved request and lets its status be dismissed", async () => {
  setup({ requests: [{ ...request, status: "ended" }] });
  expect(await screen.findByText("Secret request ended. Nothing was saved.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByLabelText("Private command secret")).toBeNull();
});
