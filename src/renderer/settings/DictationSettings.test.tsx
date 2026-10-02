// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DictationSettings } from "./DictationSettings";
import { TestProviders } from "../test-support/test-providers";
import { PreferencesStore } from "../preferences";
import type { DictationPort } from "../dictation";

it("keeps dictation language in device Settings, defaulting to device language", async () => {
  const preferences = new PreferencesStore();
  const native: DictationPort = {
    languages: async () => ({ available: true, defaultLanguage: "de-DE", languages: [{ id: "de-DE", name: "German", installed: true }, { id: "en-US", name: "English", installed: false }] }),
    download: vi.fn(), start: vi.fn(), finish: vi.fn(), cancel: vi.fn(),
  };
  render(<TestProviders preferences={preferences}><DictationSettings port={native} /></TestProviders>);
  const select = await screen.findByRole("combobox", { name: "Dictation language" });
  expect(select).toHaveProperty("value", "");
  fireEvent.change(select, { target: { value: "en-US" } });
  await waitFor(() => expect(select).toHaveProperty("value", "en-US"));
  expect(preferences.getSnapshot().dictationLanguage).toBe("en-US");
  expect(native.start).not.toHaveBeenCalled();
});
