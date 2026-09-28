// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness, RendererServicesProvider } from "../../src/renderer/test-support/kit-harness.js";
import { accessKitExtension } from "./desktop.js";
import { PERMISSIONS_ROW } from "./permissions.js";
import { ACCESS_HOST_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

function renderSection(level: string) {
  const calls: unknown[][] = [];
  const { registry, preferences } = createKitHarness(async (...args) => { calls.push(args); return undefined; });
  preferences.setValue(ACCESS_HOST_EXTENSION_ID, "level", level);
  registry.activate(accessKitExtension);
  const [section] = registry.getSettingsSections("runtimes");
  render(<RendererServicesProvider services={{ preferences }}><section.Component onNotify={vi.fn()} onChanged={vi.fn()} /></RendererServicesProvider>);
  return { section: section!, calls, preferences };
}

const cards = async () => (await screen.findByRole("list")).querySelectorAll("li");
const says = async () => [...await cards()].map((card) => [card.querySelector("h3")?.textContent, card.querySelector("p")?.textContent]);

describe("Access Kit on Settings → Runtimes", () => {
  it("names itself the target of the Permissions button and a row the search finds", () => {
    const { section } = renderSection("full");
    expect(section.rows?.map((row) => row.id)).toEqual([PERMISSIONS_ROW]);
    expect(document.getElementById(PERMISSIONS_ROW)).toBeTruthy();
  });

  it("says what a runtime may do before it asks, at the level in force", async () => {
    renderSection("ask");
    expect(await says()).toEqual([
      ["Read files", "Always allowed"],
      ["Edit files", "Asks every time"],
      ["Run commands", "Asks every time"],
      ["Reach the network", "A command that reaches it asks first"],
    ]);
    cleanup();
    renderSection("read-only");
    expect((await says())[1]).toEqual(["Edit files", "Never: an edit is blocked"]);
  });

  it("changes the level here as the composer does: stored, and told to the host", async () => {
    const { calls, preferences } = renderSection("full");
    const level = await screen.findByRole("radiogroup", { name: "Access level" });
    fireEvent.click(within(level).getByRole("radio", { name: "Ask" }));
    expect(preferences.value(ACCESS_HOST_EXTENSION_ID, "level")).toBe("ask");
    expect(calls).toEqual([[ACCESS_HOST_EXTENSION_ID, "set-level", { level: "ask" }]]);
    expect((await says())[2]).toEqual(["Run commands", "Asks every time"]);
  });
});
