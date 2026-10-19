// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileMedia } from "./FileMedia";
import { ClientEnvironmentProvider, electronClientEnvironment } from "../client-environment";
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

it("hands a PDF to the system viewer where the web view cannot draw it", async () => {
  const openDocument = vi.fn().mockRejectedValueOnce(new Error("No app on this device can open PDF files.")).mockResolvedValue(undefined);
  const environment = { ...electronClientEnvironment(new URLSearchParams("profile=compact")), openDocument };
  const load = vi.fn(async () => ({ url: "https://host/resources/pdf", mimeType: "application/pdf" }));
  const { container, findByRole, findByText } = render(<ClientEnvironmentProvider environment={environment}><FileMedia path="docs/spec.pdf" load={load} /></ClientEnvironmentProvider>);
  const open = await findByRole("button", { name: /Open in/u });
  expect(container.querySelector("iframe")).toBeNull();
  fireEvent.click(open);
  await findByText("No app on this device can open PDF files.");
  expect(openDocument).toHaveBeenCalledWith({ url: "https://host/resources/pdf", name: "spec.pdf", mimeType: "application/pdf" });
  fireEvent.click(open);
  await waitFor(() => expect(openDocument).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(container.textContent).not.toContain("No app on this device"));
});
