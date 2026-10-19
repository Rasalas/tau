// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import type { PublishInfo } from "./protocol.js";
import { PublishForm } from "./publish-form.js";

afterEach(cleanup);

const INFO: PublishInfo = {
  branch: "main",
  folder: "app",
  services: [
    { service: "github", ready: true, account: "octo", protocol: "ssh" },
    { service: "gitlab", ready: false, problem: "GitLab CLI (glab) is not installed." },
  ],
};

function hostWith(info: PublishInfo = INFO) {
  const invoke = vi.fn(async (command: string) => {
    if (command === "publish-info") return info;
    if (command === "publish-repository") return { repository: "octo/app", url: "https://github.com/octo/app", remote: "git@github.com:octo/app.git", pushed: true, branch: "main" };
    throw new Error(command);
  });
  return { invoke, host: { invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient };
}

describe("the publish form", () => {
  it("suggests the account and folder, then publishes only from the confirmation", async () => {
    const { invoke, host } = hostWith();
    const published = vi.fn();
    render(<PublishForm host={host} workspace="ws1_shown" onPublished={published} onCancel={() => undefined} />);
    const name = await screen.findByLabelText("Repository") as HTMLInputElement;
    expect(name.value).toBe("octo/app");
    expect(invoke).toHaveBeenCalledWith("publish-info", { workspace: "ws1_shown" });
    expect(screen.getByRole("radio", { name: "GitLab" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("radio", { name: "SSH" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue…" }));
    expect(invoke).not.toHaveBeenCalledWith("publish-repository", expect.anything());
    expect(screen.getByText(/Create the public repository/u).textContent).toContain("octo/app");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue…" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitHub" }));
    await waitFor(() => expect(published).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("publish-repository", { service: "github", repository: "octo/app", visibility: "public", protocol: "ssh", confirm: true, workspace: "ws1_shown" });
  });

  it("offers nothing to publish with when no CLI is ready, and says why", async () => {
    const { host } = hostWith({ ...INFO, services: [{ service: "github", ready: false, problem: "GitHub CLI (gh) is not signed in." }, INFO.services[1]!] });
    render(<PublishForm host={host} onPublished={() => undefined} onCancel={() => undefined} />);
    expect((await screen.findByRole("note")).textContent).toContain("gh) is not signed in");
    expect(screen.getByRole("button", { name: "Continue…" })).toHaveProperty("disabled", true);
  });

  it("keeps the form open with the advice when only the push failed, and pushes again", async () => {
    const created = { repository: "octo/app", url: "https://github.com/octo/app", remote: "git@github.com:octo/app.git", pushed: false, branch: "main", pushProblem: "SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS, then push again." };
    const invoke = vi.fn(async (command: string) => {
      if (command === "publish-info") return INFO;
      if (command === "publish-repository") return created;
      if (command === "publish-push") return { detail: "Pushed" };
      throw new Error(command);
    });
    const published = vi.fn();
    render(<PublishForm host={{ invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient} workspace="ws1_shown" onPublished={published} onCancel={() => undefined} />);
    await screen.findByLabelText("Repository");
    fireEvent.click(screen.getByRole("button", { name: "Continue…" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitHub" }));
    expect((await screen.findByRole("alert")).textContent).toContain("octo/app was created and added as origin, but the push failed. SSH authentication was rejected");
    expect(published).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Push again" }));
    await waitFor(() => expect(published).toHaveBeenCalledWith({ repository: "octo/app", url: "https://github.com/octo/app", remote: "git@github.com:octo/app.git", pushed: true, branch: "main" }));
    expect(invoke).toHaveBeenCalledWith("publish-push", { workspace: "ws1_shown" });
  });
});
