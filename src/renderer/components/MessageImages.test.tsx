// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Message } from "./Message";
import { localImagePaths, visibleUserMessageText } from "./MessageText";

afterEach(() => {
  cleanup();
  delete window.tau;
});

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
    expect(image.closest("article.message.user")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("offers a viewport-safe image context menu and copies persisted image data", async () => {
    const copyImage = vi.fn(async () => undefined);
    window.tau = { copyImage } as unknown as typeof window.tau;
    render(<Message message={{ id: "user-image", role: "user", text: "please inspect", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 }} />);

    const imageButton = screen.getByRole("button", { name: "Open image 1" });
    fireEvent.contextMenu(imageButton, { clientX: 9999, clientY: 9999 });
    const menu = screen.getByRole("menu", { name: "Image actions" });
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole("menuitem", { name: "Copy image" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,iVBORw=="));
    expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull();
  });

  it("copies a local preview data URL and closes the menu from Escape or outside", async () => {
    const copyImage = vi.fn(async () => undefined);
    window.tau = {
      copyImage,
      readImagePreview: vi.fn(async () => ({ name: "preview.png", dataUrl: "data:image/png;base64,iVBORw==" })),
    } as unknown as typeof window.tau;
    render(<Message message={{ id: "local-image", role: "user", text: "/tmp/preview.png\ninspect", timestamp: 0 }} />);

    const imageButton = await screen.findByRole("button", { name: "Open image 1" });
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull();
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull();
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,iVBORw=="));
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
