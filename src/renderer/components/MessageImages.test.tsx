// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Message } from "./Message";
import { localImagePaths, visibleUserMessageText } from "./MessageText";

afterEach(cleanup);

describe("message images", () => {
  it("finds shell-escaped local image paths", () => {
    const text = "/Users/me/Application\\ Support/CleanShot/image.png please inspect";
    expect(localImagePaths(text)).toEqual(["/Users/me/Application Support/CleanShot/image.png"]);
    expect(visibleUserMessageText(text)).toBe("please inspect");
  });

  it("renders image content persisted in the Pi message", () => {
    render(<Message message={{ id: "user-image", role: "user", text: "please inspect", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 }} />);
    const image = screen.getByRole("img", { name: "Attached image" }) as HTMLImageElement;
    expect(image.src).toBe("data:image/png;base64,iVBORw==");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens and closes persisted images in an accessible lightbox", () => {
    render(<Message message={{ id: "user-image", role: "user", text: "please inspect", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 }} />);
    const openButton = screen.getByRole("button", { name: "Open image 1" });
    openButton.focus();
    fireEvent.click(openButton);
    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    const closeButton = screen.getByRole("button", { name: "Close preview" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(document.activeElement).toBe(openButton);
  });
});
