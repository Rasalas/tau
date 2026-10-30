// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { UiModel } from "../../shared/contracts";
import { ExtensionRegistry, type ExtensionOption } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { ExtensionPage } from "./ExtensionPage";
import type { ExtensionEntry } from "./extension-catalog";

afterEach(cleanup);

const models: UiModel[] = [
  { provider: "test", id: "thinking", name: "Thinking" },
  { provider: "test", id: "plain", name: "Plain" },
];

function setup(options: ExtensionOption[], levels: Record<string, string[]> = { "test/thinking": ["off", "low", "high"], "test/plain": ["off"] }) {
  const preferences = new PreferencesStore();
  for (const option of options) preferences.setValue("acme.writing", option.id, "test/thinking");
  const registry = new ExtensionRegistry(undefined, { preferences });
  const entry: ExtensionEntry = {
    id: "acme.writing", name: "Writing", origin: "bundled", state: "on", locked: false, theme: false, permissions: [],
    summary: { id: "acme.writing", name: "Writing", active: true, contributes: "", options },
  };
  const client = createFakeHostClient({ runtimeCatalog: async (kind) => ({ kind, models, thinkingLevels: levels }) });
  render(<TestProviders preferences={preferences}><HostClientProvider client={client}>
    <ExtensionPage entry={entry} registry={registry} models={models} onOpen={() => undefined} onChanged={() => undefined} onNotify={() => undefined} onHostHalves={() => undefined} />
  </HostClientProvider></TestProviders>);
  return preferences;
}

it("stores independent efforts beside two model settings and can restore the default", async () => {
  const preferences = setup([
    { id: "guide-model", kind: "model", label: "Guide model", thinkingLevelValue: "guide-effort" },
    { id: "writer-model", kind: "model", label: "Writer model", thinkingLevelValue: "writer-effort" },
  ]);
  const guide = await screen.findByRole("combobox", { name: "Effort for Guide model" });
  const writer = await screen.findByRole("combobox", { name: "Effort for Writer model" });
  expect(within(guide).getAllByRole("option").map((item) => item.textContent)).toEqual(["Default effort", "Off", "Low", "High"]);
  expect((guide as HTMLSelectElement).value).toBe("");
  fireEvent.change(guide, { target: { value: "high" } });
  fireEvent.change(writer, { target: { value: "low" } });
  expect(preferences.value("acme.writing", "guide-effort")).toBe("high");
  expect(preferences.value("acme.writing", "writer-effort")).toBe("low");
  fireEvent.change(guide, { target: { value: "" } });
  expect(preferences.value("acme.writing", "guide-effort")).toBe("");
  expect(preferences.value("acme.writing", "guide-model")).toBe("test/thinking");
  fireEvent.click(screen.getByRole("button", { name: "Use the thread's model for Writer model" }));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Effort for Writer model" })).toBeNull());
  expect(preferences.value("acme.writing", "writer-effort")).toBe("");
});

it("uses only the selected model's levels and shows the default for a stale effort", async () => {
  const preferences = setup([{ id: "model", kind: "model", label: "Chosen model", thinkingLevelValue: "effort" }]);
  const select = await screen.findByRole("combobox", { name: "Effort for Chosen model" });
  act(() => preferences.setValue("acme.writing", "effort", "unavailable"));
  await waitFor(() => expect((select as HTMLSelectElement).value).toBe(""));
  act(() => preferences.setValue("acme.writing", "model", "test/plain"));
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  expect(screen.getByRole("button", { name: "Chosen model: Plain" })).toBeTruthy();
});

it("names what an unset choice means where the option says, and clears to it", async () => {
  const preferences = setup([{ id: "title-model", kind: "model", label: "Model that names threads", emptyLabel: "Default model" }]);
  fireEvent.click(await screen.findByRole("button", { name: "Use the default model for Model that names threads" }));
  await waitFor(() => expect(preferences.value("acme.writing", "title-model")).toBe(""));
  expect((await screen.findByRole("button", { name: "Model that names threads: Default model" })).textContent).toContain("Default model");
});
