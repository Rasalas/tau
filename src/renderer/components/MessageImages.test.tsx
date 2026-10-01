// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
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
    expect(image.closest("article.message.user")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("does not render an empty bubble for a persisted image-only message", () => {
    const onCopy = vi.fn();
    const message = { id: "image-only", role: "user" as const, text: "", sourceEntryId: "entry-image-only", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 };
    const view = render(<Message message={message} onCopy={onCopy} />);

    expect(screen.getByRole("img", { name: "Attached image" })).toBeTruthy();
    expect(view.container.querySelector("article.message.user")).toBeTruthy();
    expect(view.container.querySelector(".message-text")).toBeNull();
    expect(screen.queryByText("Image attached")).toBeNull();
    expect(screen.getByLabelText(/^Sent /u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith(message);
  });

  it("does not render an empty bubble for a local-path-only message", async () => {
    const client = createFakeHostClient({
      readImagePreview: vi.fn(async () => ({ name: "preview.png", dataUrl: "data:image/png;base64,iVBORw==" })),
    });
    const view = render(<HostClientProvider client={client}>
      <Message message={{ id: "local-image-only", role: "user", text: "/tmp/preview.png", timestamp: 0 }} />
    </HostClientProvider>);

    expect(screen.queryByText("Image attached")).toBeNull();
    expect(view.container.querySelector("article.message.user")).toBeTruthy();
    await screen.findByRole("img", { name: "preview.png" });
    expect(view.container.querySelector("article.message.user")).toBeTruthy();
    expect(view.container.querySelector(".message-text")).toBeNull();
  });

  it("offers a viewport-safe image context menu and copies persisted image data", async () => {
    const copyImage = vi.fn(async () => undefined);
    const client = createFakeHostClient({ copyImage });
    render(<HostClientProvider client={client}>
      <Message message={{ id: "user-image", role: "user", text: "please inspect", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 }} />
    </HostClientProvider>);

    const imageButton = screen.getByRole("button", { name: "Open image 1" });
    // The shared menu keeps itself inside the window; its own tests cover that.
    fireEvent.contextMenu(imageButton, { clientX: 9999, clientY: 9999 });
    const menu = await screen.findByRole("menu", { name: "Image actions" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull());
    expect(document.activeElement).toBe(imageButton);

    fireEvent.keyDown(imageButton, { key: "F10", shiftKey: true });
    const menuItem = await screen.findByRole("menuitem", { name: "Copy image" });
    await waitFor(() => expect(document.activeElement).toBe(menuItem));
    fireEvent.click(menuItem);
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,iVBORw=="));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull());
  });

  it("copies a local preview data URL and closes the menu from Escape or outside", async () => {
    const copyImage = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      copyImage,
      readImagePreview: vi.fn(async () => ({ name: "preview.png", dataUrl: "data:image/png;base64,iVBORw==" })),
    });
    render(<HostClientProvider client={client}>
      <Message message={{ id: "local-image", role: "user", text: "/tmp/preview.png\ninspect", timestamp: 0 }} />
    </HostClientProvider>);

    const imageButton = await screen.findByRole("button", { name: "Open image 1" });
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    await screen.findByRole("menu", { name: "Image actions" });
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull());
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull());
    fireEvent.contextMenu(imageButton, { clientX: 12, clientY: 18 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,iVBORw=="));
  });

  it("opens and closes persisted images in an accessible lightbox", async () => {
    render(<Message message={{ id: "user-image", role: "user", text: "please inspect", images: [{ mimeType: "image/png", data: "iVBORw==" }], timestamp: 0 }} />);
    const openButton = screen.getByRole("button", { name: "Open image 1" });
    openButton.focus();
    fireEvent.click(openButton);
    const dialog = await screen.findByRole("dialog", { name: "Image preview" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.querySelector(".lightbox-stage img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    const closeButton = screen.getByRole("button", { name: "Close preview" });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    // One image: nothing to step through.
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    fireEvent.keyDown(closeButton, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull());
    expect(document.activeElement).toBe(openButton);
  });

  it("steps through a message's images by the names the prompt gave them", async () => {
    const images = [{ mimeType: "image/png", data: "AAAA" }, { mimeType: "image/png", data: "BBBB" }];
    render(<Message message={{ id: "user-images", role: "user", text: "checkout-429.png grafana.png Make it friendlier.", images, timestamp: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image 1" }));
    const dialog = await screen.findByRole("dialog", { name: "checkout-429.png" });
    expect(dialog.textContent).toContain("1 of 2 · from your message");
    fireEvent.keyDown(screen.getByRole("button", { name: "Close preview" }), { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "grafana.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Image 1" }));
    const shown = await screen.findByRole("dialog", { name: "checkout-429.png" });
    // Scrolling up zooms in; the next picture starts at fit again.
    const picture = shown.querySelector<HTMLImageElement>(".lightbox-stage img")!;
    fireEvent.wheel(picture, { deltaY: -100 });
    fireEvent.wheel(picture, { deltaY: -100 });
    await waitFor(() => expect(picture.style.transform).toBe(`scale(${String(1.15 * 1.15)})`));
  });
});
