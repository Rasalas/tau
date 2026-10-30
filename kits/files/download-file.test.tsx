// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnvironmentProvider, electronClientEnvironment } from "../../src/renderer/test-support/kit-harness.js";
import { DownloadFileButton } from "./download-file.js";
import type { WorkspaceStoreLike } from "./kit.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function store(downloadFile: NonNullable<WorkspaceStoreLike["downloadFile"]>) {
  return { downloadFile } as WorkspaceStoreLike;
}
describe("passive document downloads", () => {
  it("does not preload, uses the explicit origin, and hands complete bytes to the existing browser save mechanism", async () => {
    const download = vi.fn(async () => ({ blob: new Blob(["saved"]), name: "report.docx" }));
    const create = vi.fn(() => "blob:download"); const revoke = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("report.docx"); expect(this.href).toBe("blob:download");
    });
    const view = render(<DownloadFileButton store={store(download)} path="report.docx" workspace="ws1_origin" />);
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(download).toHaveBeenCalledWith("report.docx", { workspace: "ws1_origin" }, expect.any(AbortSignal));
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:download");
  });
  it("aborts on unmount and never saves a late result", async () => {
    let resolve!: (result: { blob: Blob; name: string }) => void;
    const download = vi.fn((_path: string, _from: { workspace: string }, _signal: AbortSignal) => new Promise<{ blob: Blob; name: string }>((done) => { resolve = done; }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const view = render(<DownloadFileButton store={store(download)} path="report.docx" workspace="ws1_origin" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const signal = download.mock.calls[0]?.[2] as AbortSignal;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ blob: new Blob(["late"]), name: "report.docx" }); });
    expect(click).not.toHaveBeenCalled();
  });
  it("shows transfer errors and allows retry", async () => {
    const download = vi.fn(async () => { throw new Error("The file download was incomplete. Try downloading it again."); });
    render(<DownloadFileButton store={store(download)} path="report.docx" workspace="ws1_origin" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("incomplete");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  });
  it("explains unsupported native save and older Workspace versions without starting a transfer", async () => {
    const download = vi.fn(async () => ({ blob: new Blob(), name: "report.docx" }));
    const environment = { ...electronClientEnvironment(new URLSearchParams()), mobileApp: { platform: "android" as const, version: "1" } };
    const view = render(<ClientEnvironmentProvider environment={environment}><DownloadFileButton store={store(download)} path="report.docx" workspace="ws1_origin" /></ClientEnvironmentProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot save");
    expect(download).not.toHaveBeenCalled();
    view.unmount();
    render(<DownloadFileButton path="report.docx" workspace="ws1_origin" />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Update Tau");
  });
});
