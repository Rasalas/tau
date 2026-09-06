// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { observatoryExtension } from "./desktop.js";

afterEach(cleanup);

/** The kit in the real workbench: core lends the rail slot, the kit fills the panel. */
describe("Signals in the workbench", () => {
  it("opens from the panel rail and streams what the workbench recorded", async () => {
    renderApp(undefined, { extensions: [observatoryExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Signals" }));

    expect(await screen.findByText("preview.mode")).toBeTruthy();
    expect(screen.getByText("Electron host unavailable; showing fixture state")).toBeTruthy();
  });
});
