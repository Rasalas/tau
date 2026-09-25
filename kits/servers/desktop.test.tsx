// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import servers from "./desktop.js";
import { SERVERS_EXTENSION_ID, type ServerTargetRow, type ServerTargetsState } from "./protocol.js";

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
