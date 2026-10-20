// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import type { DesktopExtensionContext } from "tau";
import servers from "./desktop.js";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID, SERVERS_PROMPTS_EVENT, type CredentialStatus, type ServerNetworkState, type ServerPrompt, type ServerTargetRow, type ServerTargetsState } from "./protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const APP: ServerTargetRow = {
  id: "sftp-app--staging-1", configKey: "app", source: "sftp.json", label: "app", context: "app", profiles: ["staging", "production"],
  profile: "staging", protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/app-staging",
  password: "Asked once, then kept in the keychain", issues: [], usable: true,
};
const STATIC: ServerTargetRow = {
  ...APP, id: "sftp-static-1", configKey: "static", label: "static", context: "public", profiles: [], remotePath: "/srv/static",
  issues: [{ code: "plaintext-password", level: "warning", message: "\"password\" is stored in plain text in sftp.json." }],
};
delete (STATIC as { profile?: string }).profile;
const STATE: ServerTargetsState = { workspace: "/work/site", file: "/work/site/.vscode/sftp.json", targets: [APP, STATIC], issues: [] };

function setup(answer: (command: string, input?: unknown) => unknown, cwd: string | null = "/work/site") {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => answer(command, input));
  const { registry, preferences } = createKitHarness(invoke);
  registry.activate(servers);
  const page = registry.getSettingsPages().find((entry) => entry.id === "servers.settings")!;
  const props: SettingsPageProps = { onNotify: vi.fn(), ...(cwd ? { cwd } : {}) };
  render(<TestProviders preferences={preferences}><page.Component {...props} /></TestProviders>);
  return { invoke, props, page };
}

describe("Settings → Servers", () => {
  it("lists the targets of the open project with address, folder, profile and warnings", async () => {
    const { invoke } = setup((command) => (command === "targets" ? STATE : undefined));
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "targets", { cwd: "/work/site" });
    expect(screen.getByText("sftp://tester@127.0.0.1:2222/srv/app-staging")).toBeTruthy();
    expect(screen.getByText("sftp://tester@127.0.0.1:2222/srv/static")).toBeTruthy();
    expect(screen.getByText("public")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Profile of app" }) as HTMLSelectElement).value).toBe("staging");
    expect(screen.queryByRole("combobox", { name: "Profile of static" })).toBeNull();
    expect(screen.getByText(/stored in plain text/u)).toBeTruthy();
  });

  it("switches the profile through the host and shows what it answers", async () => {
    const production = { ...STATE, targets: [{ ...APP, id: "sftp-app--production-1", profile: "production", remotePath: "/srv/app" }, STATIC] };
    const { invoke } = setup((command) => (command === "targets" ? STATE : command === "set-profile" ? production : undefined));
    await flush();
    await act(async () => { fireEvent.change(screen.getByRole("combobox", { name: "Profile of app" }), { target: { value: "production" } }); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-profile", { cwd: "/work/site", configKey: "app", profile: "production" });
    expect(screen.getByText("sftp://tester@127.0.0.1:2222/srv/app")).toBeTruthy();
  });

  it("sets what the agent may run on a server, per target", async () => {
    const { invoke } = setup((command, input) => {
      if (command === "targets") return STATE;
      if (command === "target-levels") return { levels: { [APP.id]: "ask", [STATIC.id]: "read-only" } };
      if (command === "set-target-level") return { level: (input as { level: string }).level };
      return undefined;
    });
    await flush();
    const app = screen.getByRole("radiogroup", { name: "What the agent may run on app" });
    const chosen = (group: HTMLElement) => within(group).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
    expect(chosen(app)).toBe("Ask first");
    expect(chosen(screen.getByRole("radiogroup", { name: "What the agent may run on static" }))).toBe("Read only");
    await act(async () => { fireEvent.click(within(app).getByRole("radio", { name: "Full access" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-target-level", { cwd: "/work/site", targetId: APP.id, level: "full" });
    expect(chosen(app)).toBe("Full access");
    expect(screen.getByText(/runs commands on the server without asking/u)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Keep the history for" })).toBeTruthy();
  });

  it("asks before cleaning up the history, since dropped deployments cannot be rolled back", async () => {
    const { invoke } = setup((command) => (command === "targets" ? STATE : command === "cleanup-history" ? { targets: [] } : undefined));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Clean up…" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/can no longer be rolled back/u);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(invoke).not.toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "cleanup-history", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Clean up…" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clean up" })); });
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "cleanup-history", { cwd: "/work/site" });
  });

  it("says when what the agent may run did not load, and tries again", async () => {
    let fail = true;
    const { invoke } = setup((command) => {
      if (command === "targets") return STATE;
      if (command === "target-levels") {
        if (fail) throw new Error("The host did not answer");
        return { levels: { [APP.id]: "ask", [STATIC.id]: "ask" } };
      }
      return undefined;
    });
    await flush();
    expect(screen.queryByText(/Reading what the agent may run/u)).toBeNull();
    expect(screen.getAllByText(/could not read what the agent may run here: The host did not answer\./u)).toHaveLength(2);
    fail = false;
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!); });
    await flush();
    expect(invoke.mock.calls.filter(([, command]) => command === "target-levels")).toHaveLength(2);
    expect(screen.getByRole("radiogroup", { name: "What the agent may run on app" })).toBeTruthy();
  });

  it("says when there is no project or no sftp.json", async () => {
    setup(() => undefined, null);
    await flush();
    expect(screen.getByText("No project open")).toBeTruthy();
    cleanup();
    setup((command) => (command === "targets" ? { workspace: "/work/site", targets: [], issues: [] } : undefined));
    await flush();
    expect(screen.getByText("No sftp.json in this project")).toBeTruthy();
  });
});

describe("server questions cannot trap the workbench", () => {
  const prompt: ServerPrompt = { id: "connect", kind: "confirm", title: "Connect?", message: "A server connection", confirmLabel: "Connect" };
  it("dismisses a question that the host already answered, without waiting for an event", async () => {
    const host = { onEvent: () => () => undefined, invoke: vi.fn(async (name: string) => name === "prompts" ? { prompts: [prompt] } : { answered: false }) };
    const feed = new ServerPromptFeed({ host } as unknown as DesktopExtensionContext);
    const stop = feed.start();
    const Layer = createServerPromptLayer(feed);
    render(<Layer />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    stop();
  });

  it("keeps Cancel available while an answer is in flight", async () => {
    const host = { onEvent: () => () => undefined, invoke: vi.fn((name: string) => name === "prompts" ? Promise.resolve({ prompts: [prompt] }) : new Promise(() => undefined)) };
    const feed = new ServerPromptFeed({ host } as unknown as DesktopExtensionContext);
    const stop = feed.start();
    const Layer = createServerPromptLayer(feed);
    render(<Layer />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(host.invoke).toHaveBeenCalledWith("answer-prompt", { id: "connect", action: "cancel" });
    stop();
  });

  it("does not resurrect a question from a stale initial request", async () => {
    let initial!: (value: unknown) => void;
    let event!: (value: unknown) => void;
    const host = { onEvent: (_name: string, listener: (value: unknown) => void) => { event = listener; return () => undefined; }, invoke: () => new Promise((resolve) => { initial = resolve; }) };
    const feed = new ServerPromptFeed({ host } as unknown as DesktopExtensionContext);
    const stop = feed.start();
    event({ prompts: [] });
    initial({ prompts: [prompt] });
    await flush();
    expect(feed.get()).toEqual([]);
    stop();
  });
});

describe("the rows Settings → Servers names for the search", () => {
  it("each lands on an element once a server project is open", async () => {
    const STATUS: CredentialStatus = { targetId: APP.id, password: { source: "Tau's keychain item", session: false, saved: false, foreignItem: { label: "item", allowed: true } } };
    const network: ServerNetworkState = { serverProject: true, allowAll: false, allowHosts: [], packageSources: ["registry.npmjs.org"], pi: { available: true } };
    const { page } = setup((command) => (command === "targets" ? STATE : command === "credential-status" ? { targets: [STATUS] } : command === "network" ? network : undefined));
    await flush();
    const rows = page.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(document.getElementById(row.id), row.label).toBeTruthy();
  });
});

describe("the password source in Settings → Servers", () => {
  const STATUS: CredentialStatus = {
    targetId: APP.id,
    password: { source: "Tau's keychain item, then VS Code's, then asking you", session: false, saved: false, foreignItem: { label: "tester@127.0.0.1 (app)", allowed: true } },
  };

  it("shows where the password comes from, checks it and withdraws approvals, never a value", async () => {
    const { invoke, props } = setup((command) => {
      if (command === "targets") return STATE;
      if (command === "credential-status") return { targets: [STATUS] };
      if (command === "check-credential") return { found: true, source: "VS Code's keychain item tester@127.0.0.1 (app)" };
      return { ok: true };
    });
    await flush();
    expect(screen.getByText(/VS Code's item tester@127.0.0.1 \(app\): allowed/u)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Check" })[0]!); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "check-credential", { cwd: "/work/site", targetId: APP.id, kind: "password" });
    expect(props.onNotify).toHaveBeenCalledWith("app: found the password. Source: VS Code's keychain item tester@127.0.0.1 (app).");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Withdraw" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "forget-credential-approvals", { cwd: "/work/site" });
  });

  it("forgets only the secret of the row it was asked on", async () => {
    const KEYED: ServerTargetRow = { ...APP, privateKeyPath: "~/.ssh/id_ed25519" };
    const kept: CredentialStatus = { targetId: APP.id, password: { source: "Tau's keychain item", saved: true, session: false }, passphrase: { source: "Tau's keychain item", saved: true, session: false } };
    const { invoke, props } = setup((command) => {
      if (command === "targets") return { ...STATE, targets: [KEYED] };
      if (command === "credential-status") return { targets: [kept] };
      return { ok: true };
    });
    await flush();
    const forget = screen.getAllByRole("button", { name: "Forget" });
    expect(forget).toHaveLength(2);
    await act(async () => { fireEvent.click(forget[1]!); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "forget-credential", { cwd: "/work/site", targetId: APP.id, kind: "passphrase" });
    expect(props.onNotify).toHaveBeenCalledWith("Tau forgot the key passphrase it kept for app.");
  });
});

describe("the servers' questions", () => {
  function feedWith(prompts: ServerPrompt[]) {
    const listeners: ((payload: unknown) => void)[] = [];
    const invoke = vi.fn(async (command: string, _input?: unknown) => (command === "prompts" ? { prompts } : { answered: true }));
    const context = { host: { invoke, onEvent: (name: string, listener: (payload: unknown) => void) => { if (name === SERVERS_PROMPTS_EVENT) listeners.push(listener); return () => undefined; } } } as unknown as DesktopExtensionContext;
    const feed = new ServerPromptFeed(context);
    feed.start();
    const Layer = createServerPromptLayer(feed);
    render(<TestProviders><Layer /></TestProviders>);
    return { invoke, publish: (next: ServerPrompt[]) => act(() => { for (const listener of listeners) listener({ prompts: next }); }) };
  }

  it("asks for a password in a dialog and sends the answer to the host", async () => {
    const { invoke, publish } = feedWith([{ id: "p1", kind: "secret", title: "Password for tester@127.0.0.1", message: "Tau keeps it.", field: "Password", confirmLabel: "Connect", alternativeLabel: "Try other keychain items on this login" }]);
    await flush();
    const field = screen.getByLabelText("Password") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "typed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    expect(invoke).toHaveBeenCalledWith("answer-prompt", { id: "p1", action: "confirm", value: "typed" });
    publish([]);
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("shows a command to allow verbatim and answers the other ways", async () => {
    const { invoke } = feedWith([{ id: "c1", kind: "confirm", title: "Run a command from sftp.json?", message: "m", detail: "op read op://x", confirmLabel: "Allow for this project", cancelLabel: "Not now" }]);
    await flush();
    expect(screen.getByText("op read op://x")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Not now" })); });
    expect(invoke).toHaveBeenCalledWith("answer-prompt", { id: "c1", action: "cancel" });
  });
});

describe("Settings → Servers → Network", () => {
  const LIMITED: ServerNetworkState = { serverProject: true, allowAll: false, allowHosts: [], packageSources: ["registry.npmjs.org", "pypi.org"], pi: { available: true } };

  it("shows the limit of a server project, adds and removes a host, and lifts the limit", async () => {
    let state = LIMITED;
    const { invoke, props } = setup((command, input) => {
      if (command === "targets") return STATE;
      if (command === "network") return state;
      if (command === "set-network") {
        const patch = input as { allowAll?: boolean; allowHosts?: string[] };
        state = { ...state, ...(patch.allowAll !== undefined ? { allowAll: patch.allowAll } : {}), ...(patch.allowHosts ? { allowHosts: patch.allowHosts } : {}) };
        return state;
      }
      return undefined;
    });
    await flush();
    expect(screen.getByText(/Reach this machine and the package sources only/u)).toBeTruthy();
    expect(screen.getByText("registry.npmjs.org · pypi.org")).toBeTruthy();
    const add = screen.getByRole("textbox", { name: "Add to Allowed hosts" });
    await act(async () => { fireEvent.change(add, { target: { value: "https://api.example.com" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
    expect(screen.getByRole("alert").textContent).toBe("Enter a host name alone, such as api.example.com.");
    await act(async () => { fireEvent.change(add, { target: { value: "api.example.com" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-network", { cwd: "/work/site", allowHosts: ["api.example.com"] });
    expect(screen.getByText("api.example.com")).toBeTruthy();
    expect((add as HTMLInputElement).value).toBe("");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove api.example.com" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-network", { cwd: "/work/site", allowHosts: [] });
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Let agent commands reach the whole network" })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-network", { cwd: "/work/site", allowAll: true });
    expect(screen.getByText(/Reach the whole network/u)).toBeTruthy();
    expect(props.onNotify).toHaveBeenCalledWith("The agent's commands in this project reach the whole network now.");
  });

  it("says when the limit did not load instead of hiding it, and tries again", async () => {
    let fail = true;
    setup((command) => {
      if (command === "targets") return STATE;
      if (command === "network") { if (fail) throw new Error("The host did not answer"); return LIMITED; }
      return undefined;
    });
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Could not read the network limit.*The host did not answer/u);
    fail = false;
    await act(async () => { fireEvent.click(within(alert).getByRole("button", { name: "Try again" })); });
    await flush();
    expect(screen.getByText("Agent commands")).toBeTruthy();
  });

  it("says when Pi's sandbox is missing, and shows nothing outside a server project", async () => {
    setup((command) => (command === "targets" ? STATE : command === "network" ? { ...LIMITED, pi: { available: false, reason: "bubblewrap (bwrap) not installed" } } : undefined));
    await flush();
    expect(screen.getByText(/Not available here: bubblewrap \(bwrap\) not installed/u)).toBeTruthy();
    cleanup();
    setup((command) => (command === "targets" ? STATE : command === "network" ? { ...LIMITED, serverProject: false } : undefined));
    await flush();
    expect(screen.queryByText("Agent commands")).toBeNull();
  });
});
