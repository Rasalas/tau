// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { missingSettingsRows, renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { PREVIEW_SETTINGS_ROWS, PreviewSettingsPage } from "./settings-page.js";

afterEach(cleanup);

const key = (name: string) => `tau.preview.${name}`;

describe("Settings → Preview", () => {
  it("chooses what a new page opens with, where links go and what a recording shows", async () => {
    const { updates } = renderKitSettingsPage(PreviewSettingsPage, { host: { values: { [key("default-zoom")]: "1.5" } } });

    const zoom = screen.getByRole("combobox", { name: "Default zoom" }) as HTMLSelectElement;
    await waitFor(() => expect(zoom.value).toBe("1.5"));
    expect((screen.getByRole("combobox", { name: "Default viewport" }) as HTMLSelectElement).value).toBe("fill");

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Default appearance" })).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("default-appearance")]: "dark" } }));

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Open links in" })).getByRole("radio", { name: "Preview" }));
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("link-target")]: "app" } }));

    const rates = screen.getByRole("radiogroup", { name: "Frame rate" });
    expect(within(rates).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["15 fps", "30 fps", "60 fps"]);
    fireEvent.click(within(rates).getByRole("radio", { name: "60 fps" }));
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("recording-frame-rate")]: "60" } }));

    fireEvent.click(screen.getByRole("switch", { name: "Show clicks" }));
    await waitFor(() => expect(updates).toContainEqual({ options: { [key("recording-clicks")]: true } }));
    expect(missingSettingsRows({ rows: PREVIEW_SETTINGS_ROWS })).toEqual([]);
  });
});
