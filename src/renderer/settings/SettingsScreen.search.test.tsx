// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../extension-system";
import { TestProviders } from "../test-support/test-providers";
import { SettingsScreen } from "./SettingsScreen";

afterEach(cleanup);

function Harness({ registry }: { registry: ExtensionRegistry }) {
  const [page, setPage] = useState("defaults");
  return <SettingsScreen page={page} registry={registry} onSetPage={setPage} onSetModel={() => undefined} onSetThinking={() => undefined} onClose={() => undefined} onNotify={() => undefined} />;
}

/** A page whose row waits for an answer, the way rows read from the host do. */
function LatePage() {
  const [ready, setReady] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => setReady(true)); }, []);
  return ready ? <div id="setting-late-row" tabIndex={-1}>The late row</div> : <p>Loading</p>;
}

function setup() {
  const registry = new ExtensionRegistry();
  registry.activate({
    id: "fixture.search",
    name: "Search fixture",
    activate(context) {
      context.registerCommand({ id: "search.files", label: "Go to file…", group: "Search", run: () => undefined });
      context.registerKeybinding({ keys: "mod+p", commandId: "search.files" });
      context.registerCommand({ id: "search.content", label: "Search in project…", group: "Search", run: () => undefined });
      context.registerKeybinding({ keys: "mod+shift+f", commandId: "search.content" });
      context.registerSettingsPage({ id: "usage", label: "Usage", keywords: ["quota"], profiles: ["desktop"], Component: () => <p>Usage page</p> });
      context.registerSettingsPage({ id: "late", label: "Late", profiles: ["desktop"], rows: [{ id: "setting-late-row", label: "Arrives later" }], Component: LatePage });
    },
  });
  render(<TestProviders><Harness registry={registry} /></TestProviders>);
  const modal = screen.getByRole("dialog", { name: "Settings" });
  const search = within(modal).getByRole("searchbox", { name: "Search settings" });
  return { modal, search };
}

describe("Settings search", () => {
  it("finds a keybinding and opens the Keybindings page filtered to it", () => {
    const { modal, search } = setup();
    fireEvent.change(search, { target: { value: "go to file" } });
    fireEvent.click(within(modal).getByRole("option", { name: /Go to file…/u }));
    expect(within(modal).getByRole("heading", { name: "Keybindings" })).toBeTruthy();
    expect((within(modal).getByPlaceholderText("Filter keybindings or commands…") as HTMLInputElement).value).toBe("search.files");
    const rows = [...modal.querySelectorAll(".keybinding-row strong")].map((row) => row.textContent);
    expect(rows).toEqual(["Go to file…"]);
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("scrolls to a row that is drawn after its page", async () => {
    const { modal, search } = setup();
    fireEvent.change(search, { target: { value: "arrives later" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-late-row"));
    expect(within(modal).getByText("The late row").classList.contains("settings-target-pulse")).toBe(true);
  });

  it("opens a contributed page by its keywords with Enter, and says so when nothing matches", () => {
    const { modal, search } = setup();
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(within(modal).getByText(/No setting matches/u)).toBeTruthy();
    fireEvent.change(search, { target: { value: "quota" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(within(modal).getByText("Usage page")).toBeTruthy();
  });
});
