// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness, PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { PiProvidersCard, piProvidersExtension, providerRowId, setUpBy, waysIn, type ProviderIconControls } from "./desktop.js";
import { readProviderIcon } from "./provider-icons.js";
import type { PiProviderView } from "./protocol.js";

afterEach(cleanup);

const PROVIDERS: PiProviderView[] = [
  { id: "anthropic", name: "Anthropic", configured: false, apiKey: { name: "Anthropic API key", interactive: true }, oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true } },
  { id: "openai", name: "OpenAI", configured: true, source: "environment", label: "OPENAI_API_KEY", apiKey: { name: "OpenAI API key", interactive: true } },
  { id: "bedrock", name: "Amazon Bedrock", configured: false, apiKey: { name: "AWS credentials", interactive: false } },
];

function fakeHost(providers: PiProviderView[]) {
  const listeners = new Set<(payload: unknown) => void>();
  let list = providers;
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "providers") return list;
    if (command === "sign-in-state") return { methods: [{ id: "oauth", label: "Sign in to Anthropic (Claude Pro/Max)", kind: "browser" }, { id: "api-key", label: "Enter an API key", kind: "api-key" }], account: { signedIn: false }, target: (input as { target?: string }).target };
    return undefined;
  });
  return {
    host: { invoke, onEvent: (_name: string, listener: (payload: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    invoke,
    push: (payload: unknown, next?: PiProviderView[]) => act(() => { if (next) list = next; for (const listener of listeners) listener(payload); }),
  };
}

describe("Pi Providers desktop half", () => {
  it("puts Pi's card first on Providers", () => {
    const { registry } = createKitHarness();
    registry.activate(piProvidersExtension);
    expect(registry.getSettingsPages()).toMatchObject([{ id: "pi-providers.settings", runtime: "pi", label: "Pi" }]);
  });

  it("lists what is set up apart from what can be, and leaves out a provider without a way in", async () => {
    const { host } = fakeHost(PROVIDERS);
    render(<PiProvidersCard host={host} onNotify={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Set up" })).toBeTruthy();
    const openai = document.getElementById(providerRowId(PROVIDERS[1]!))!;
    expect(within(openai).getByRole("heading", { name: "OpenAI" })).toBeTruthy();
    expect(within(openai).getByText("OPENAI_API_KEY")).toBeTruthy();
    expect(within(openai).getByRole("button", { name: "Manage OpenAI" })).toBeTruthy();
    const anthropic = document.getElementById(providerRowId(PROVIDERS[0]!))!;
    expect(within(anthropic).getByText("Subscription · API key")).toBeTruthy();
    expect(within(anthropic).getByRole("button", { name: "Set up Anthropic" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Amazon Bedrock")).toBeNull();
    // The search's row is the list itself.
    const [page] = (() => { const { registry } = createKitHarness(); registry.activate(piProvidersExtension); return registry.getSettingsPages(); })();
    for (const row of page!.rows ?? []) expect(document.getElementById(row.id), row.id).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter Pi's providers" }), { target: { value: "open" } });
    expect(screen.queryByRole("heading", { name: "Sign in or add a key" })).toBeNull();
    expect(screen.getByRole("button", { name: "Manage OpenAI" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter Pi's providers" }), { target: { value: "nothing like it" } });
    expect(screen.getByText("No provider matches “nothing like it”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all providers" }));
    expect(screen.getByRole("button", { name: "Set up Anthropic" })).toBeTruthy();
  });

  it("opens a provider's sign-in and reads the list again once a sign-in finished", async () => {
    const { host, invoke, push } = fakeHost(PROVIDERS);
    render(<PiProvidersCard host={host} onNotify={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Anthropic" }));
    expect(await screen.findByRole("button", { name: "Sign in", description: /^Sign in to Anthropic \(/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up Anthropic" }).getAttribute("aria-expanded")).toBe("true");
    expect(invoke).toHaveBeenCalledWith("sign-in-state", { target: "anthropic" });

    push({ target: "anthropic", report: { methods: [], account: { signedIn: true, label: "Anthropic (Claude Pro/Max)" } } }, [{ ...PROVIDERS[0]!, configured: true, stored: "oauth" }, PROVIDERS[1]!]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Anthropic" })).toBeTruthy());
    expect(screen.getByText("Every provider is set up")).toBeTruthy();
  });

  it("says when Pi could not be asked, and asks again", async () => {
    const { host, invoke } = fakeHost(PROVIDERS);
    invoke.mockRejectedValueOnce(new Error("Pi's host half is not running."));
    render(<PiProvidersCard host={host} onNotify={vi.fn()} />);
    expect(await screen.findByText("Pi's providers did not load")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Manage OpenAI" })).toBeTruthy();
  });

  it("offers a next step while nothing is set up", async () => {
    const { host } = fakeHost([PROVIDERS[0]!]);
    render(<PiProvidersCard host={host} onNotify={vi.fn()} />);
    expect(await screen.findByText("No provider set up yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("words a provider's row", () => {
    expect(waysIn(PROVIDERS[0]!)).toBe("Subscription · API key");
    expect(waysIn(PROVIDERS[2]!)).toBe("Environment only");
    expect(setUpBy({ ...PROVIDERS[0]!, configured: true, stored: "api_key" })).toBe("API key");
    expect(setUpBy(PROVIDERS[1]!)).toBe("OPENAI_API_KEY");
  });

  it("gives a provider without a mark of Tau's its site icon once, and a row to fetch it again, choose a picture or remove it", async () => {
    const PNG = "data:image/png;base64,iVBORw0KGgo=";
    const radius: PiProviderView = { id: "radius", name: "Radius", configured: true, source: "stored", stored: "api_key", apiKey: { name: "key", interactive: true }, site: "api.radius.example" };
    const { host } = fakeHost([radius, PROVIDERS[1]!]);
    const preferences = new PreferencesStore();
    const icons: ProviderIconControls = {
      preferences,
      fetch: vi.fn(async () => ({ site: "api.radius.example", image: "data:image/x-icon;base64,AAABAA==" })),
      rasterize: vi.fn(async () => PNG),
    };
    const notify = vi.fn();
    render(<PiProvidersCard host={host} icons={icons} onNotify={notify} />);
    await waitFor(() => expect(readProviderIcon(preferences, "radius")).toEqual({ kind: "site", image: PNG, site: "api.radius.example" }));
    expect(icons.fetch).toHaveBeenCalledWith("radius", false);
    expect(icons.fetch).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Manage Radius" }));
    const row = (await screen.findByRole("heading", { name: "Logo" })).closest(".settings-row") as HTMLElement;
    expect(within(row).getByText("The icon of api.radius.example.")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(icons.fetch).toHaveBeenLastCalledWith("radius", true));

    const picked = new File(["x"], "logo.png", { type: "image/png" });
    fireEvent.change(within(row).getByLabelText("Picture for Radius"), { target: { files: [picked] } });
    await waitFor(() => expect(readProviderIcon(preferences, "radius")?.kind).toBe("upload"));
    expect(icons.rasterize).toHaveBeenLastCalledWith(picked);
    expect(within(row).getByText("Your picture.")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(readProviderIcon(preferences, "radius")).toEqual({ kind: "removed" });
    expect(within(row).getByText("Its initial, as you chose.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Manage OpenAI" }));
    // One row opens at a time; OpenAI wears a mark of Tau's own and has no logo row.
    await screen.findByRole("heading", { name: "Account" });
    expect(screen.queryByRole("heading", { name: "Logo" })).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
