// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignInEvent, SignInFlowState, SignInReport } from "../../shared/sign-in";
import type { HostExtensionClient } from "../extension-system";
import { ProviderCardContext } from "../settings/provider-card-state";
import { SignInSetup, flowLine } from "./SignInUi";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A kit's host half as the window sees it: commands answered from a script, events pushed by the test. */
function fakeHost(report: SignInReport) {
  const listeners = new Set<(payload: unknown) => void>();
  const calls: Array<{ command: string; input: unknown }> = [];
  let answers: Record<string, (input: unknown) => unknown> = {};
  const host: HostExtensionClient = {
    invoke: async (command, input) => {
      calls.push({ command, input });
      if (answers[command]) return answers[command]!(input);
      if (command === "sign-in-state") return report;
      return undefined;
    },
    onEvent: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const push = (event: SignInEvent) => act(() => { for (const listener of listeners) listener(event); });
  return { host, calls, push, answer: (next: typeof answers) => { answers = next; } };
}

const METHODS: SignInReport["methods"] = [
  { id: "chatgpt", label: "Sign in with ChatGPT", kind: "browser" },
  { id: "device", label: "Use a device code", kind: "device-code", description: "For a browser on another device." },
  { id: "terminal", label: "Sign in in a terminal", kind: "terminal" },
  { id: "key", label: "Use an API key", kind: "api-key", unavailable: "Set a key first." },
];

const common = { program: "Codex", openExternal: vi.fn(), copyText: vi.fn(async () => undefined) };

describe("SignInSetup", () => {
  it("offers the program's methods while signed out, and says why one cannot start", async () => {
    const { host } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    render(<SignInSetup host={host} {...common} />);
    expect(await screen.findByText("Not signed in")).toBeTruthy();
    const group = screen.getByRole("group", { name: "Sign in to Codex" });
    expect(group.textContent).toContain("For a browser on another device.");
    expect(within(group).getByRole("button", { name: "Sign in", description: "Sign in with ChatGPT" })).toBeTruthy();
    expect((within(group).getByRole("button", { name: "Add key", description: "Use an API key" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Set a key first.")).toBeTruthy();
  });

  it("shows the consent page to open and copy, then the account once the host reports it", async () => {
    const openExternal = vi.fn();
    const copyText = vi.fn(async () => undefined);
    const { host, calls, push, answer } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    const flow: SignInFlowState = { flowId: "f1", method: "chatgpt", phase: "starting" };
    answer({ "sign-in": () => flow });
    render(<SignInSetup host={host} program="Codex" openExternal={openExternal} copyText={copyText} target="work" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in", description: "Sign in with ChatGPT" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in", input: { target: "work", method: "chatgpt" } }));
    push({ target: "default", flow: { ...flow, phase: "waiting", browser: { url: "http://elsewhere" } } });
    expect(screen.queryByRole("button", { name: /Open sign-in page/u })).toBeNull();
    push({ target: "work", flow: { ...flow, phase: "waiting", browser: { url: "https://auth.example/consent?x=1" } } });
    fireEvent.click(screen.getByRole("button", { name: /Open sign-in page/u }));
    expect(openExternal).toHaveBeenCalledWith("https://auth.example/consent?x=1");
    fireEvent.click(screen.getByRole("button", { name: "Copy sign-in link" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("https://auth.example/consent?x=1"));

    push({ target: "work", report: { methods: METHODS, account: { signedIn: true, label: "a@example.com", detail: "ChatGPT Pro", canSignOut: true }, flow: { ...flow, phase: "succeeded" } } });
    expect(screen.queryByText("a@example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show email address" }));
    expect(screen.getByText("a@example.com")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Sign in to Codex" })).toBeNull();
  });

  it("shows a device code with its page, and cancels the flow it shows", async () => {
    const { host, calls, push, answer } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    const flow: SignInFlowState = { flowId: "f2", method: "device", phase: "waiting", deviceCode: { url: "http://127.0.0.1:9/device", code: "FAKE-1234" } };
    answer({ "sign-in-cancel": () => ({ ...flow, phase: "cancelled", message: "Sign-in cancelled." }) });
    render(<SignInSetup host={host} {...common} />);
    await screen.findByText("Not signed in");
    push({ target: "default", flow });
    expect(screen.getByLabelText("Device code").textContent).toBe("FAKE-1234");
    expect(screen.getByRole("button", { name: /Open 127\.0\.0\.1:9/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in-cancel", input: { flowId: "f2" } }));
    expect(await screen.findByText("Sign-in cancelled.")).toBeTruthy();
  });

  it("answers a question: a secret is typed into a password field, a choice by its id", async () => {
    const { host, calls, push } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    render(<SignInSetup host={host} {...common} />);
    await screen.findByText("Not signed in");
    push({ target: "default", flow: { flowId: "f3", method: "key", phase: "waiting", prompt: { id: "p1", kind: "secret", message: "Paste your OpenAI API key" } } });
    const field = screen.getByLabelText("Paste your OpenAI API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: " sk-test " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in-respond", input: { flowId: "f3", value: "sk-test" } }));

    push({ target: "default", flow: { flowId: "f3", method: "key", phase: "waiting", prompt: { id: "p2", kind: "select", message: "How?", options: [{ id: "browser", label: "In the browser" }, { id: "device", label: "With a code" }] } } });
    fireEvent.click(screen.getByRole("button", { name: "With a code" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in-respond", input: { flowId: "f3", value: "device" } }));
  });

  it("runs the command of a flow it started in a terminal once and answers with the exit status", async () => {
    const runInTerminal = vi.fn(async () => ({ exitCode: 0 }));
    const { host, calls, push, answer } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    const flow: SignInFlowState = { flowId: "f4", method: "terminal", phase: "starting" };
    answer({ "sign-in": () => flow });
    render(<SignInSetup host={host} {...common} runInTerminal={runInTerminal} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in", description: "Sign in in a terminal" }));
    const waiting = { ...flow, phase: "waiting" as const, terminal: { command: "codex login" }, prompt: { id: "p1", kind: "text" as const, message: "Waiting for the terminal" } };
    push({ target: "default", flow: waiting });
    push({ target: "default", flow: { ...waiting } });
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in-respond", input: { flowId: "f4", value: "0" } }));
    expect(runInTerminal).toHaveBeenCalledOnce();
    expect(runInTerminal).toHaveBeenCalledWith("codex login");
    expect(screen.queryByLabelText("Waiting for the terminal")).toBeNull();
  });

  it("leaves a terminal flow another window started to that window, and without a terminal asks to be told", async () => {
    const { host, calls, push } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    render(<SignInSetup host={host} {...common} />);
    await screen.findByText("Not signed in");
    push({ target: "default", flow: { flowId: "f5", method: "terminal", phase: "waiting", terminal: { command: "codex login" }, prompt: { id: "p1", kind: "text", message: "Waiting" } } });
    expect(screen.getByText("codex login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I have signed in" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: "sign-in-respond", input: { flowId: "f5", value: "done" } }));
  });

  it("asks before signing out and says what the host answered", async () => {
    // The fake address ends in a@example.com too; it is not the real address.
    vi.spyOn(Math, "random").mockReturnValue(10 / 36);
    const onNotify = vi.fn();
    const { host, calls, answer } = fakeHost({ methods: METHODS, account: { signedIn: true, label: "a@example.com", canSignOut: true } });
    answer({ "sign-out": () => ({ methods: METHODS, account: { signedIn: false }, note: "Signed out of Codex." }) });
    render(<SignInSetup host={host} {...common} onNotify={onNotify} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out of Codex?" });
    expect(within(dialog).queryByText("a@example.com", { exact: true })).toBeNull();
    const reveal = within(dialog).getByRole("button", { name: "Show email address" });
    expect(reveal.textContent).toBe("user-a@example.com");
    fireEvent.click(reveal);
    expect(within(dialog).getByText("a@example.com")).toBeTruthy();
    expect(dialog.textContent).toMatch(/stop working until you sign in again; their history stays/u);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Signed out of Codex."));
    expect(calls.map((call) => call.command)).toContain("sign-out");
    expect(await screen.findByText("Not signed in")).toBeTruthy();
  });

  it("names the account's state in the head of the card it is drawn in, and says nothing there for a nested sign-in", async () => {
    const slot = vi.fn();
    const { host, push } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    const { rerender } = render(<ProviderCardContext.Provider value={slot}><SignInSetup host={host} {...common} rowId="setting-codex-account" /></ProviderCardContext.Provider>);
    await waitFor(() => expect(slot).toHaveBeenLastCalledWith("account", { label: "Needs sign-in", tone: "warn" }));
    expect(document.getElementById("setting-codex-account")).toBeTruthy();
    push({ target: "default", report: { methods: METHODS, account: { signedIn: true, label: "a@example.com" } } });
    await waitFor(() => expect(slot).toHaveBeenLastCalledWith("account", { label: "Signed in", tone: "success" }));

    slot.mockClear();
    rerender(<ProviderCardContext.Provider value={slot}><SignInSetup host={host} {...common} cardBadge={false} /></ProviderCardContext.Provider>);
    await waitFor(() => expect(slot).toHaveBeenLastCalledWith("account", undefined));
  });

  it("says what went wrong when the program could not be asked, and asks again", async () => {
    const { host, answer } = fakeHost({ methods: METHODS, account: { signedIn: false } });
    answer({ "sign-in-state": () => { throw new Error("The Codex host half is not running."); } });
    render(<SignInSetup host={host} {...common} />);
    expect(await screen.findByText("Could not ask Codex who is signed in: The Codex host half is not running.")).toBeTruthy();
    answer({});
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(await screen.findByText("Not signed in")).toBeTruthy();
  });

  it("words each phase", () => {
    expect(flowLine({ flowId: "x", method: "m", phase: "waiting", browser: { url: "u" } }, "Codex")).toMatch(/browser/u);
    expect(flowLine({ flowId: "x", method: "m", phase: "failed", message: "Refused." }, "Codex")).toBe("Refused.");
    expect(flowLine({ flowId: "x", method: "m", phase: "verifying" }, "Codex")).toBe("Checking the Codex sign-in…");
  });
});
