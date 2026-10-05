// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileMedia } from "./FileMedia";
afterEach(cleanup);
it.each([["video/mp4", "video"], ["audio/wav", "audio"], ["application/pdf", "iframe"]])("previews %s and releases the host resource", async (mimeType, tag) => {
  const release = vi.fn();
  const load = vi.fn(async () => ({ url: "https://host/resources/one", mimeType, release }));
  const { container, unmount } = render(<FileMedia path="artifact" load={load} />);
  await waitFor(() => expect(container.querySelector(tag)?.getAttribute("src")).toBe("https://host/resources/one"));
  if (tag !== "iframe") expect(container.querySelector(tag)?.hasAttribute("controls")).toBe(true);
  unmount();
  expect(release).toHaveBeenCalledOnce();
});
