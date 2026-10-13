// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { observatoryExtension } from "./desktop.js";

afterEach(cleanup);

/** The kit in the real workbench: sections of Settings → Diagnostics, not a tool beside the chat. */
describe("Signals in the workbench", () => {
  it("takes no place in the panel rail and streams what the workbench recorded from Settings → Diagnostics", async () => {
    renderApp(undefined, { extensions: [observatoryExtension] });
    await screen.findByRole("textbox");
    expect(screen.queryByRole("button", { name: "Signals" })).toBeNull();

    // mod+alt+o, the kit's own chord, opens Diagnostics.
    const mac = /mac|iphone|ipad/iu.test(navigator.platform);
    fireEvent.keyDown(window, { key: "o", code: "KeyO", altKey: true, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    expect(await screen.findByText("preview.mode")).toBeTruthy();
    expect(screen.getByText("Electron host unavailable; showing fixture state")).toBeTruthy();
  });
});
