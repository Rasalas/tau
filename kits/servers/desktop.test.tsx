// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import type { DesktopExtensionContext } from "tau";
import servers from "./desktop.js";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID, SERVERS_PROMPTS_EVENT, type CredentialStatus, type ServerPrompt, type ServerTargetRow, type ServerTargetsState } from "./protocol.js";

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
  return { invoke, props };
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
    const app = screen.getByRole("combobox", { name: "What the agent may run on app" }) as HTMLSelectElement;
    expect(app.value).toBe("ask");
    expect((screen.getByRole("combobox", { name: "What the agent may run on static" }) as HTMLSelectElement).value).toBe("read-only");
    await act(async () => { fireEvent.change(app, { target: { value: "full" } }); });
    await flush();
    expect(invoke).toHaveBeenCalledWith(SERVERS_EXTENSION_ID, "set-target-level", { cwd: "/work/site", targetId: APP.id, level: "full" });
    expect(app.value).toBe("full");
    expect(screen.getByText(/runs commands on the server without asking/u)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Keep the history for" })).toBeTruthy();
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
