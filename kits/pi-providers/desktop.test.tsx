// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PiProvidersCard, piProvidersExtension, setUpBy, waysIn } from "./desktop.js";
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
    expect(await screen.findByText("Set up (1)")).toBeTruthy();
    expect(screen.getByText("Sign in or add a key (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /OpenAI.*OPENAI_API_KEY/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Anthropic.*Subscription · API key/u })).toBeTruthy();
    expect(screen.queryByText("Amazon Bedrock")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter Pi's providers"), { target: { value: "open" } });
    expect(screen.getByText("Sign in or add a key (0)")).toBeTruthy();
  });

  it("opens a provider's sign-in and reads the list again once a sign-in finished", async () => {
    const { host, invoke, push } = fakeHost(PROVIDERS);
    render(<PiProvidersCard host={host} onNotify={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/u }));
    expect(await screen.findByRole("button", { name: "Sign in to Anthropic (Claude Pro/Max)" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("sign-in-state", { target: "anthropic" });

    push({ target: "anthropic", report: { methods: [], account: { signedIn: true, label: "Anthropic (Claude Pro/Max)" } } }, [{ ...PROVIDERS[0]!, configured: true, stored: "oauth" }, PROVIDERS[1]!]);
    await waitFor(() => expect(screen.getByText("Set up (2)")).toBeTruthy());
  });

  it("words a provider's row", () => {
    expect(waysIn(PROVIDERS[0]!)).toBe("Subscription · API key");
    expect(waysIn(PROVIDERS[2]!)).toBe("Environment only");
    expect(setUpBy({ ...PROVIDERS[0]!, configured: true, stored: "api_key" })).toBe("API key");
    expect(setUpBy(PROVIDERS[1]!)).toBe("OPENAI_API_KEY");
  });
});
