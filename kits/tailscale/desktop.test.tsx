// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import tailscale from "./desktop.js";
import { TAILSCALE_EXTENSION_ID, type TailscaleView } from "./protocol.js";

afterEach(cleanup);

const NAME = "box-one.tail0000.ts.net";

function view(overrides: Partial<TailscaleView> = {}): TailscaleView {
  return {
    state: "running",
    dnsName: NAME,
    magicDns: true,
    https: true,
    proxyPort: 7789,
    proxyListening: false,
    serve: { on: false, httpsPort: 443, others: [] },
    platform: "darwin",
    ...overrides,
  };
}

function renderSection(answers: Record<string, (input: unknown) => TailscaleView>) {
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    expect(extensionId).toBe(TAILSCALE_EXTENSION_ID);
    const answer = answers[command];
    if (!answer) throw new Error(`no ${command} in this test`);
    return answer(input);
  });
  const { registry } = createKitHarness(invoke);
  registry.activate(tailscale);
  const [section] = registry.getSettingsSections("connections");
  const notify = vi.fn();
  const changed = vi.fn();
  const Component = section!.Component;
  render(<TestProviders><Component onNotify={notify} onChanged={changed} /></TestProviders>);
  return { invoke, notify, changed, registry };
}

describe("Tailscale on Settings → Connections", () => {
  it("says when Tailscale did not answer, and asks again", async () => {
    let calls = 0;
    const { registry } = renderSection({ status: () => { calls += 1; if (calls === 1) throw new Error("tailscale: command not found"); return view(); } });
    expect(await screen.findByText("tailscale: command not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("switch", { name: "Tailscale HTTPS" })).toBeTruthy();
    // Every row the section names for the search is on it.
    const rows = registry.getSettingsSections("connections")[0]!.rows ?? [];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(document.getElementById(row.id), row.id).toBeTruthy();
  });


  it("sends the owner to the admin console while the tailnet has HTTPS certificates off, and offers no switch", async () => {
    renderSection({ status: () => view({ https: false }) });
    expect(await screen.findByText(/HTTPS certificates are off in your tailnet/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open DNS settings" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(NAME)).toBeTruthy();
  });

  it("says what to do where Tailscale is missing", async () => {
    renderSection({ status: () => view({ state: "not-installed", dnsName: undefined }) });
    expect(await screen.findByRole("button", { name: "Get Tailscale" })).toBeTruthy();
  });

  it("sets Serve up only after the owner agrees to publish the machine's name, on a port nothing else holds", async () => {
    const others = [{ httpsPort: 443, path: "/", target: "http://127.0.0.1:3773" }];
    const { invoke, notify, changed } = renderSection({
      status: () => view({ serve: { on: false, httpsPort: 443, others } }),
      "serve-on": () => view({ proxyListening: true, serve: { on: true, httpsPort: 8443, url: `https://${NAME}:8443/`, others } }),
    });
    fireEvent.click(await screen.findByRole("switch", { name: "Tailscale HTTPS" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up Tailscale HTTPS" });
    expect(dialog.textContent).toContain("This machine’s name becomes public.");
    expect(dialog.textContent).toContain("Certificate Transparency logs");
    expect(dialog.textContent).toContain(`https://${NAME}:8443/`);
    const setUp = screen.getByRole("button", { name: "Set up" }) as HTMLButtonElement;
    expect(setUp.disabled).toBe(true);

    const port = screen.getByRole("spinbutton", { name: "HTTPS port" });
    fireEvent.change(port, { target: { value: "443" } });
    fireEvent.blur(port);
    expect(screen.getByRole("alert").textContent).toBe("Serve already forwards port 443 to http://127.0.0.1:3773. Pick another port.");
    fireEvent.click(screen.getByRole("checkbox", { name: `I understand that ${NAME} will be published` }));
    expect(setUp.disabled).toBe(false);
    // The refused draft is still in the field: nothing is set up on the port before it.
    fireEvent.click(setUp);
    expect(invoke).not.toHaveBeenCalledWith(TAILSCALE_EXTENSION_ID, "serve-on", expect.anything());
    fireEvent.change(port, { target: { value: "8443" } });
    fireEvent.blur(port);
    fireEvent.click(setUp);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(TAILSCALE_EXTENSION_ID, "serve-on", { httpsPort: 8443, name: NAME }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith(`Tailscale HTTPS is on: https://${NAME}:8443/`);
    // The notice goes out before the render that closes the dialog and turns the switch on.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("switch", { name: "Tailscale HTTPS" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("asks before turning Serve off, and says when the proxy listener is not open", async () => {
    const { invoke, changed } = renderSection({
      status: () => view({ serve: { on: true, httpsPort: 443, url: `https://${NAME}/`, others: [] } }),
      "serve-off": () => view(),
    });
    expect(await screen.findByText(/proxy listener is not open/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Tailscale HTTPS" }));
    expect(invoke).not.toHaveBeenCalledWith(TAILSCALE_EXTENSION_ID, "serve-off", undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(TAILSCALE_EXTENSION_ID, "serve-off", undefined));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });

  it("keeps the dialog open and says why when Tailscale refuses", async () => {
    const { notify, changed } = renderSection({
      status: () => view(),
      "serve-on": () => { throw new Error("Tailscale refused: this user may not change Serve."); },
    });
    fireEvent.click(await screen.findByRole("switch", { name: "Tailscale HTTPS" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Tailscale refused: this user may not change Serve."));
    expect(screen.getByRole("dialog", { name: "Set up Tailscale HTTPS" })).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
  });
});
