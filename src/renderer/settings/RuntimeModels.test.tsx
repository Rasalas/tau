// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TauConfig, UiModel } from "../../shared/contracts";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { arrangeModels, RuntimeModels } from "./RuntimeModels";

afterEach(cleanup);

const models: UiModel[] = [
  { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription", contextWindow: 400_000 },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", billing: "subscription" },
  { provider: "openai", id: "o4-mini", name: "o4-mini", billing: "api-key", price: { input: 1.1, output: 4.4 } },
];

describe("Settings → Providers → Models", () => {
  it("lists favourites first, then the user's order, the hidden last", () => {
    const arranged = arrangeModels(models, { hidden: ["openai/gpt-5.6-luna"], order: ["openai/o4-mini"] }, (model) => (model.id === "gpt-5.6-sol" ? 0 : -1));
    expect(arranged.map((entry) => [entry.model.id, entry.group])).toEqual([["gpt-5.6-sol", "favourite"], ["o4-mini", "shown"], ["gpt-5.6-luna", "hidden"]]);
  });

  it("hides, reorders and stars a runtime's models, written to the level Settings edits", async () => {
    // The host's file, as the fake host writes and reads it back.
    let host: TauConfig = {};
    const updateConfig = vi.fn(async (patch: Partial<TauConfig>) => {
      host = { ...host, modelPreferences: { ...host.modelPreferences, ...patch.modelPreferences } };
      return host;
    });
    const client = createFakeHostClient({
      runtimeCatalogs: async () => [{ kind: "codex", models, thinkingLevels: {}, checkedAt: 1 }],
      updateConfig,
      getConfigLayers: async () => ({ host }),
    });
    const preferences = new PreferencesStore();
    render(<TestProviders preferences={preferences}><HostClientProvider client={client}>
      <RuntimeModels backends={[{ kind: "codex", label: "Codex" }]} />
    </HostClientProvider></TestProviders>);
    const list = await screen.findByRole("list", { name: "Codex models" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    fireEvent.click(screen.getByRole("switch", { name: "Show o4-mini in the model picker" }));
    expect(updateConfig).toHaveBeenLastCalledWith({ modelPreferences: { codex: { hidden: ["openai/o4-mini"] } } }, "global", undefined);
    await waitFor(() => expect(screen.getByText("Hidden from the picker")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Move GPT-5.6 Sol up" }));
    expect(updateConfig).toHaveBeenLastCalledWith({ modelPreferences: { codex: { hidden: ["openai/o4-mini"], order: ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna", "openai/o4-mini"] } } }, "global", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Favourite GPT-5.6 Luna" }));
    expect(preferences.getSnapshot().favouriteModels).toEqual(["codex:openai/gpt-5.6-luna"]);
  });

  it("says why a runtime lists no model and what to do, and offers to clear a filter that matches none", async () => {
    const many: UiModel[] = Array.from({ length: 9 }, (_, index) => ({ provider: "openai", id: `m-${index}`, name: `Model ${index}` }));
    const client = createFakeHostClient({
      runtimeCatalogs: async () => [
        { kind: "codex", models: many, thinkingLevels: {}, checkedAt: 1 },
        { kind: "cursor", models: [], thinkingLevels: {}, status: "sign-in-required", checkedAt: 1 },
      ],
      getConfigLayers: async () => ({ host: {} }),
    });
    render(<TestProviders><HostClientProvider client={client}>
      <RuntimeModels backends={[{ kind: "codex", label: "Codex" }, { kind: "cursor", label: "Cursor" }]} />
    </HostClientProvider></TestProviders>);
    expect(await screen.findByText("No Cursor models yet")).toBeTruthy();
    expect(screen.getByText("Sign in to Cursor on its card above; its models follow.")).toBeTruthy();
    const filter = await screen.findByRole("searchbox", { name: "Filter Codex models" });
    fireEvent.change(filter, { target: { value: "nothing like it" } });
    expect(screen.getByText("No Codex model matches “nothing like it”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all models" }));
    expect((filter as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("switch", { name: /^Show Model \d in the model picker$/u })).toHaveLength(9);
  });
});
