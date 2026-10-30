// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness, HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { titleGeneratorExtension } from "./desktop.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_INSTRUCTIONS_LIMIT } from "./protocol.js";

afterEach(cleanup);
const key = `${THREAD_TITLES_HOST_EXTENSION_ID}.instructions`;

function renderSetting(initial?: string) {
  let instructions = initial;
  const layers = () => ({ host: instructions === undefined ? {} : { values: { [key]: instructions } } });
  const updateConfig = vi.fn(async (patch: { values?: Record<string, string> }) => { instructions = patch.values?.[key]; return layers().host; });
  const clearConfig = vi.fn(async () => { instructions = undefined; return layers(); });
  const client = createFakeHostClient({ getConfigLayers: async () => layers(), updateConfig, clearConfig });
  const { registry, preferences } = createKitHarness();
  registry.activate(titleGeneratorExtension);
  const section = registry.getSettingsSections("threads").find((entry) => entry.id === "thread-titles.instructions")!;
  render(<HostClientProvider client={client}><TestProviders preferences={preferences}>
    <section.Component onNotify={vi.fn()} onChanged={vi.fn()} />
  </TestProviders></HostClientProvider>);
  return { registry, section, updateConfig, clearConfig };
}

describe("thread title instructions in Settings", () => {
  it("adds a searchable row to New threads and removes it with the extension", () => {
    const kit = renderSetting();
    expect(kit.section.card).toBe("new-threads");
    expect(kit.section.rows?.[0]?.label).toBe("Thread title instructions");
    expect(document.getElementById("setting-thread-title-instructions")).toBeTruthy();
    expect(screen.getByRole("button", { name: /About Thread title instructions:.*Automatic naming prefers runtime-provided titles/u })).toBeTruthy();
    kit.registry.deactivate(THREAD_TITLES_HOST_EXTENSION_ID);
    expect(kit.registry.getSettingsSections("threads")).toHaveLength(0);
  });

  it("loads, commits multiple lines on blur, and resets through the existing settings store", async () => {
    const kit = renderSetting("Use English.");
    const field = screen.getByRole("textbox", { name: "Thread title instructions" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("Use English."));
    fireEvent.change(field, { target: { value: "  Lead with TAU-42.\nUse German.  " } });
    expect(kit.updateConfig).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() => expect(kit.updateConfig).toHaveBeenCalledWith({ values: { [key]: "Lead with TAU-42.\nUse German." } }, "global", undefined));
    fireEvent.click(await screen.findByRole("button", { name: "Reset Thread title instructions to default" }));
    await waitFor(() => expect(kit.clearConfig).toHaveBeenCalledWith([`values.${key}`], "global", undefined));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("rejects oversized drafts without persisting them and accepts a corrected value", async () => {
    const kit = renderSetting("Use English.");
    const field = screen.getByRole("textbox", { name: "Thread title instructions" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("Use English."));
    fireEvent.change(field, { target: { value: "x".repeat(TITLE_INSTRUCTIONS_LIMIT + 1) } });
    fireEvent.blur(field);
    expect(screen.getByText("Use at most 2,000 characters.")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(kit.updateConfig).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "Use German." } });
    fireEvent.blur(field);
    await waitFor(() => expect(kit.updateConfig).toHaveBeenCalledWith({ values: { [key]: "Use German." } }, "global", undefined));
  });

  it("allows clearing the instructions explicitly", async () => {
    const kit = renderSetting("Use English.");
    const field = screen.getByRole("textbox", { name: "Thread title instructions" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("Use English."));
    fireEvent.change(field, { target: { value: "  \n " } });
    fireEvent.blur(field);
    await waitFor(() => expect(kit.updateConfig).toHaveBeenCalledWith({ values: { [key]: "" } }, "global", undefined));
  });
});
