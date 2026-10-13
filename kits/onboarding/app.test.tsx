// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import onboarding from "./desktop.js";
import { agentRows, age, toolRows } from "./wizard.js";
import { FLOW_STORAGE_KEY, WelcomeFlow, defaultProjects, defaultSessions, emptySteps, groupProjects, importSummary, stepAfter } from "./flow.js";
import type { Discovery, ToolsReport } from "./protocol.js";

afterEach(cleanup);

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const tools: ToolsReport = {
  platform: "darwin",
  tools: [
    { id: "claude-code", path: "/bin/claude", install: "curl claude", login: "claude auth login" },
    { id: "codex", install: "curl codex", login: "codex login" },
    { id: "gh", path: "/bin/gh", version: "2.81.0", signedIn: true, install: "brew install gh", login: "gh auth login" },
    { id: "glab", install: "brew install glab", login: "glab auth login" },
  ],
};

const discovery: Discovery = {
  projects: [
    { path: "/work/alpha", name: "alpha", sources: ["claude-code", "codex"], threadCount: 4, lastActiveAt: NOW - DAY, git: true },
    { path: "/work/old", name: "old", sources: ["codex"], threadCount: 5, lastActiveAt: NOW - 90 * DAY, git: true },
  ],
  sessions: [
    { source: "claude-code", path: "/h/c1.jsonl", sessionId: "c1", cwd: "/work/alpha", title: "Fix the login test", updatedAt: NOW - DAY, imported: false },
    { source: "codex", path: "/h/x1.jsonl", sessionId: "x1", cwd: "/work/alpha", title: "Add a --json flag", updatedAt: NOW - 2 * DAY, imported: false },
    { source: "codex", path: "/h/x2.jsonl", sessionId: "x2", cwd: "/work/alpha", title: "Already here", updatedAt: NOW - 2 * DAY, imported: true },
    { source: "codex", path: "/h/x3.jsonl", sessionId: "x3", cwd: "/work/old", title: "Old work", updatedAt: NOW - 90 * DAY, imported: false },
  ],
  truncated: false,
  unavailable: [],
};

function host() {
  const calls: Array<[string, string, unknown]> = [];
  let completed = false;
  const answers: Record<string, (input: unknown) => unknown> = {
    "tau.onboarding/state": () => ({ completed, firstStart: !completed }),
    "tau.onboarding/complete": () => { completed = true; },
    "tau.onboarding/tools": () => tools,
    "tau.onboarding/discover": () => discovery,
    "tau.onboarding/project-ref": (input) => ({ workspaceId: `ws:${(input as { path: string }).path}`, displayPath: (input as { path: string }).path }),
    "tau.onboarding/import-sessions": (input) => ({ imported: (input as { paths: string[] }).paths.length, skipped: 0, failed: 0 }),
    "tau.claude-code/status": () => ({ path: "/bin/claude" }),
    "tau.claude-code/probe": () => ({ version: "2.1.0", account: "Claude Max" }),
    "tau.codex/status": (input) => (input as { instance?: string } | undefined)?.instance === "work"
      ? { path: "/bin/codex", version: "0.154.0", signedIn: false }
      : { command: "codex", message: "not found" },
    "tau.codex/sign-in-state": () => ({ methods: [{ id: "chatgpt", label: "Sign in with ChatGPT", kind: "browser" }], account: { signedIn: false } }),
    "tau.antigravity/status": () => ({ installed: false, message: "not installed" }),
  };
  const invokeHostExtension = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    calls.push([extensionId, command, input]);
    const answer = answers[`${extensionId}/${command}`];
    if (!answer) throw new Error(`Host extension ${extensionId} is not installed.`);
    return answer(input);
  });
  return { calls, invokeHostExtension };
}

describe("Onboarding in the workbench", () => {
  it("conceals account emails until clicked, and lets each address be hidden again", async () => {
    const { invokeHostExtension: fallback } = host();
    const email = "private.person@example.net";
    const base = createFakeHostClient();
    const bootstrap = async () => {
      const snapshot = await base.bootstrap();
      return { ...snapshot, catalog: { ...snapshot.catalog, runtimeBackends: [
        { kind: "claude-code", label: "Claude Code" }, { kind: "codex", label: "Codex" },
      ] } };
    };
    const invokeHostExtension = vi.fn(async (id: string, command: string, input?: unknown) => {
      if (id === "tau.claude-code" && command === "probe") return { version: "2.1.0", account: email };
      if (id === "tau.codex" && command === "status") return { path: "/bin/codex", version: "0.154.0", signedIn: true, account: email };
      return fallback(id, command, input);
    });
    const { container } = renderApp(createFakeHostClient({ bootstrap, invokeHostExtension }), { extensions: [onboarding] });
    await waitFor(() => expect(invokeHostExtension).toHaveBeenCalledWith("tau.claude-code", "probe", undefined));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Show email address" })).toHaveLength(2));
    expect(container.innerHTML).not.toContain(email);
    fireEvent.click(screen.getAllByRole("button", { name: "Show email address" })[0]!);
    expect(screen.getAllByText(email)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Show email address" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide email address" }));
    expect(container.innerHTML).not.toContain(email);
  });

  it("stays shut on a device paired Read only: setting up changes the host", async () => {
    const { calls, invokeHostExtension } = host();
    renderApp(createFakeHostClient({ invokeHostExtension, isReadOnly: () => true }), { extensions: [onboarding] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull();
    expect(calls.filter(([id]) => id === "tau.onboarding")).toEqual([]);
  });

  it("opens on a first start and walks through agents, projects and conversations", async () => {
    const { calls, invokeHostExtension } = host();
    const openProject = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const base = createFakeHostClient();
    const bootstrap = async () => {
      const snapshot = await base.bootstrap();
      return { ...snapshot, catalog: { ...snapshot.catalog, runtimeBackends: [
        { kind: "pi", label: "Pi" }, { kind: "claude-code", label: "Claude Code" }, { kind: "codex", label: "Codex" },
        { kind: "codex@work", label: "Codex (work)" }, { kind: "antigravity", label: "Antigravity" },
      ] } };
    };
    const client = createFakeHostClient({ invokeHostExtension, openProject, bootstrap });
    renderApp(client, { extensions: [onboarding] });

    // Agents: every registered runtime, its state from its own kit; the review CLIs are a group of their own.
    await screen.findByRole("heading", { name: "Your agents" });
    await screen.findByText("2.1.0 · Claude Max");
    const card = (label: string) => screen.getByText(label, { selector: "strong" }).closest(".onboarding-card") as HTMLElement;
    await screen.findByText("0.154.0 · Not signed in");
    expect(calls).toContainEqual(["tau.codex", "status", { instance: "work" }]);
    // Each program is asked once per opening; a probe may start it.
    expect(calls.filter(([id, command]) => id === "tau.claude-code" && command === "probe")).toHaveLength(1);
    // The instance signs in to its own home, in place.
    fireEvent.click(within(card("Codex (work)")).getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in", description: "Sign in with ChatGPT" })).toBeTruthy();
    expect(calls).toContainEqual(["tau.codex", "sign-in-state", { target: "work" }]);
    expect(within(card("Antigravity")).getByRole("button", { name: "Open Settings" })).toBeTruthy();
    const reviewTools = screen.getByRole("region", { name: /Tools for pull requests/ });
    expect(within(reviewTools).getByText("GitHub CLI")).toBeTruthy();
    expect(within(reviewTools).getByText("Not installed")).toBeTruthy();
    expect(screen.getAllByText(/GitHub CLI|GitLab CLI/).every((element) => reviewTools.contains(element))).toBe(true);
    // Codex is missing: its own sign-in sets it up, as on its Providers card, not the vendor's installer.
    expect(within(card("Codex")).queryByRole("button", { name: "Install" })).toBeNull();
    expect(within(card("Codex")).getByRole("button", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    // Projects: recent repositories with three conversations are chosen for you.
    await screen.findByRole("heading", { name: "Choose your projects" });
    expect((screen.getByRole("checkbox", { name: /alpha/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /old/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 project" }));
    await screen.findByRole("heading", { name: "Import conversations" });
    expect(calls.some(([, command, input]) => command === "project-ref" && (input as { path: string }).path === "/work/alpha")).toBe(true);
    expect(openProject).toHaveBeenCalled();

    // Conversations: the added project's recent ones; the imported one is only counted.
    expect(screen.getByText("1 conversation is in Tau already.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Old work/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Import 2 conversations" }));
    // The last screen names what is ready and leads to the first thread; setup is done once it is left.
    await screen.findByRole("heading", { name: / is ready$/ });
    const imports = calls.filter(([, command]) => command === "import-sessions").map(([, , input]) => input);
    expect(imports).toEqual([{ source: "claude-code", paths: ["/h/c1.jsonl"] }, { source: "codex", paths: ["/h/x1.jsonl"] }]);
    expect(calls.some(([, command]) => command === "complete")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: / is ready$/ })).toBeNull());
    expect(calls.some(([, command]) => command === "complete")).toBe(true);
  });

  describe("on a machine with no history to bring in", () => {
    const nothing: Discovery = { projects: [], sessions: [], truncated: false, unavailable: [] };
    const NOT_INSTALLED = { installed: false };
    const SIGNED_IN = { path: "/bin/acme", version: "1.0.0", signedIn: true, account: "Acme Team" };
    const backends = [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }];

    /** A first start whose scan finds nothing and whose one agent, Acme, answers `acme` (signed in by default); `gate` holds the scan back. */
    function firstStart({ acme = SIGNED_IN, gate }: { acme?: unknown; gate?: Promise<void> } = {}) {
      const { calls, invokeHostExtension } = host();
      const base = createFakeHostClient();
      const bootstrap = async () => {
        const snapshot = await base.bootstrap();
        return { ...snapshot, catalog: { ...snapshot.catalog, runtimeBackends: backends } };
      };
      const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
        if (command === "discover") { await gate; return nothing; }
        if (extensionId === "tau.acme" && command === "status") return acme;
        return invokeHostExtension(extensionId, command, input);
      });
      const view = renderApp(createFakeHostClient({ invokeHostExtension: answer, bootstrap }), { extensions: [onboarding] });
      return { calls, answer, ...view };
    }

    it("goes past the projects and the conversations to the last screen, in one click", async () => {
      const { calls, answer } = firstStart();
      await screen.findByText("1.0.0 · Acme Team");
      await waitFor(() => expect(answer).toHaveBeenCalledWith("tau.onboarding", "discover", undefined));
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      await screen.findByRole("heading", { name: "Acme is ready" });
      expect(screen.queryByRole("heading", { name: "Choose your projects" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Import conversations" })).toBeNull();
      // The steps it went past cannot be gone back to; the agents can.
      expect((screen.getByRole("button", { name: "Choose your projects, step 2" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Your agents, step 1" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Start a thread" }));
      await waitFor(() => expect(calls.some(([, command]) => command === "complete")).toBe(true));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Acme is ready" })).toBeNull());
    });

    it("goes on by itself when the scan that a step waited for finds nothing", async () => {
      let release!: () => void;
      firstStart({ gate: new Promise<void>((resolve) => { release = resolve; }) });
      await screen.findByText("1.0.0 · Acme Team");
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      await screen.findByText(/Looking for projects/);
      await act(async () => { release(); });
      await screen.findByRole("heading", { name: "Acme is ready" });
    });

    it("says no agent is ready, and leaves a way back to the agents", async () => {
      const { answer } = firstStart({ acme: NOT_INSTALLED });
      await screen.findAllByText("Not installed");
      await waitFor(() => expect(answer).toHaveBeenCalledWith("tau.onboarding", "discover", undefined));
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      await screen.findByRole("heading", { name: "No agent is ready yet" });
      fireEvent.click(screen.getByRole("button", { name: "Back to your agents" }));
      await screen.findByRole("heading", { name: "Your agents" });
    });

    it("keeps Esc from ending setup while no agent is ready: it opens again on the next start", async () => {
      const { calls, storage } = firstStart({ acme: NOT_INSTALLED });
      await screen.findAllByText("Not installed");
      expect(storage.get(FLOW_STORAGE_KEY)).not.toBeNull();
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull());
      expect(calls.some(([, command]) => command === "complete")).toBe(false);
      expect(storage.get(FLOW_STORAGE_KEY)).toBeNull();
    });

    it("lets Esc end setup once an agent is ready", async () => {
      const { calls } = firstStart();
      await screen.findByText("1.0.0 · Acme Team");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(calls.some(([, command]) => command === "complete")).toBe(true));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull());
    });
  });

  describe("Codex, which the kit sets up itself", () => {
    const nothing: Discovery = { projects: [], sessions: [], truncated: false, unavailable: [] };
    const NOT_FOUND = { command: "codex", message: "The Codex CLI \"codex\" was not found." };
    const WAITING = 'Install Codex first; "codex" was not found.';
    const PLAN = { id: "chatgpt-plan", label: "Continue with ChatGPT", actionLabel: "Continue with ChatGPT", availableWhenSignedIn: true, kind: "browser" };
    const TERMINAL = { id: "terminal", label: "Sign in in a terminal", kind: "terminal" };

    /** A first start with Codex as the one runtime; `methods` is what the kit's `sign-in-state` offers while Codex is missing. */
    function firstStart(methods: unknown[]) {
      const { invokeHostExtension } = host();
      let signedIn = false;
      const base = createFakeHostClient();
      const bootstrap = async () => {
        const snapshot = await base.bootstrap();
        return { ...snapshot, catalog: { ...snapshot.catalog, runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] } };
      };
      const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
        if (command === "discover") return nothing;
        if (extensionId === "tau.codex" && command === "status") return signedIn ? { path: "/managed/codex", version: "0.159.2", signedIn: true, account: { kind: "chatgpt", plan: "plus" } } : NOT_FOUND;
        if (extensionId === "tau.codex" && command === "sign-in-state") return { methods, account: { signedIn } };
        if (extensionId === "tau.codex" && command === "sign-in") return { flowId: "f1", method: (input as { method: string }).method, phase: "waiting", browser: { url: "https://auth.example.test/consent" } };
        return invokeHostExtension(extensionId, command, input);
      });
      const client = createFakeHostClient({ invokeHostExtension: answer, bootstrap });
      renderApp(client, { extensions: [onboarding] });
      return {
        answer,
        /** The kit tells the window the sign-in worked, and Codex answers as signed in from then on. */
        finishSignIn: () => {
          signedIn = true;
          act(() => { client.emit({ type: "extension-event", extensionId: "tau.codex", name: "sign-in", payload: { target: "default", report: { methods, account: { signedIn: true, label: "Plus" } } } }); });
        },
      };
    }

    it("offers the kit's own sign-in, the one Settings draws, and ends ready", async () => {
      const { answer, finishSignIn } = firstStart([PLAN, { ...TERMINAL, unavailable: WAITING }]);
      const row = (await screen.findByText("Not installed · Tau fetches it when you sign in")).closest(".onboarding-card") as HTMLElement;
      // One way in: no Install button that runs the vendor's installer.
      expect(within(row).queryByRole("button", { name: "Install" })).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: "Sign in" }));

      fireEvent.click(await screen.findByRole("button", { name: "Continue with ChatGPT" }));
      await waitFor(() => expect(answer).toHaveBeenCalledWith("tau.codex", "sign-in", { target: "default", method: "chatgpt-plan" }));
      expect(answer).toHaveBeenCalledWith("tau.codex", "sign-in-state", { target: "default" });
      await screen.findByRole("button", { name: "Open sign-in page" });
      // The vendor's installer is a hint to copy for a user who installs Codex themselves.
      expect(screen.getByText(/Prefer your own copy of Codex\?/)).toBeTruthy();
      expect(screen.getByText("curl codex")).toBeTruthy();

      finishSignIn();
      await screen.findByText("0.159.2 · plus");
      expect(screen.queryByText("Not installed · Tau fetches it when you sign in")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      await screen.findByRole("heading", { name: "Codex is ready" });
    });

    it("keeps the vendor's installer when the kit's sign-in cannot start without Codex", async () => {
      firstStart([{ ...PLAN, unavailable: "This instance keeps its existing CLI threads." }, { ...TERMINAL, unavailable: WAITING }]);
      const row = (await screen.findByText("Codex", { selector: "strong" })).closest(".onboarding-card") as HTMLElement;
      const install = await within(row).findByRole("button", { name: "Install" });
      expect(within(row).getByText("Not installed")).toBeTruthy();
      fireEvent.click(install);
      expect(screen.getByText("curl codex")).toBeTruthy();
      expect(screen.queryByText(/Prefer your own copy/)).toBeNull();
    });
  });

  describe("a check that fails", () => {
    it("reads as one line with the reason in its tooltip, and asks again on Retry", async () => {
      const { invokeHostExtension } = host();
      let broken = true;
      const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
        if (extensionId === "tau.onboarding" && command === "tools" && broken) throw new Error("spawn gh ENOENT: worker restarted");
        return invokeHostExtension(extensionId, command, input);
      });
      renderApp(createFakeHostClient({ invokeHostExtension: answer }), { extensions: [onboarding] });
      const line = await screen.findByText("Could not check the tools on this machine.");
      expect(line.getAttribute("title")).toBe("spawn gh ENOENT: worker restarted");
      expect(screen.queryByText(/ENOENT/)).toBeNull();
      broken = false;
      fireEvent.click(within(line.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByText("Could not check the tools on this machine.")).toBeNull());
      const reviewTools = screen.getByRole("region", { name: /Tools for pull requests/ });
      await within(reviewTools).findByText("2.81.0 · Signed in");
    });

    it("does not show a late tools error on the next step", async () => {
      const { invokeHostExtension } = host();
      let fail!: (error: Error) => void;
      const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
        if (extensionId === "tau.onboarding" && command === "tools") return new Promise((_, reject) => { fail = reject; });
        return invokeHostExtension(extensionId, command, input);
      });
      renderApp(createFakeHostClient({ invokeHostExtension: answer }), { extensions: [onboarding] });
      await screen.findByRole("heading", { name: "Your agents" });
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      await screen.findByRole("heading", { name: "Choose your projects" });
      await act(async () => { fail(new Error("tools are gone")); });
      expect(screen.queryByText(/tools are gone/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says projects could not be looked for in a line of its own, with Retry and the reason in the tooltip", async () => {
      const { invokeHostExtension } = host();
      let broken = true;
      const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
        if (extensionId === "tau.onboarding" && command === "discover" && broken) throw new Error("Host extension tau.codex did not answer within 30s.");
        return invokeHostExtension(extensionId, command, input);
      });
      renderApp(createFakeHostClient({ invokeHostExtension: answer }), { extensions: [onboarding] });
      await screen.findByRole("heading", { name: "Your agents" });
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
      const line = await screen.findByText("Could not look for projects on this machine.");
      expect(line.getAttribute("title")).toBe("Host extension tau.codex did not answer within 30s.");
      expect(screen.queryByText(/did not answer/)).toBeNull();
      broken = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("checkbox", { name: /alpha/ });
      expect(screen.queryByText("Could not look for projects on this machine.")).toBeNull();
    });
  });

  it("runs a review CLI's install in a terminal it steps aside for, and asks again when the shell ends", async () => {
    const { calls, invokeHostExtension } = host();
    const runs: Array<{ request: { command: string; label?: string }; resolve(result: { id: string; exitCode?: number }): void }> = [];
    const terminal: DesktopExtension = {
      id: "tau.terminal",
      name: "Terminal",
      activate: (plugin) => { plugin.provideService("tau.terminal/run", { run: (request: { command: string; label?: string }) => new Promise((resolve) => runs.push({ request, resolve })) }); },
    };
    renderApp(createFakeHostClient({ invokeHostExtension }), { extensions: [terminal, onboarding] });
    const reviewTools = await screen.findByRole("region", { name: /Tools for pull requests/ });
    const glab = within(reviewTools).getByText("GitLab CLI").closest(".onboarding-card") as HTMLElement;
    const asked = calls.filter(([, command]) => command === "tools").length;
    fireEvent.click(within(glab).getByRole("button", { name: "Install" }));

    await waitFor(() => expect(runs.map((run) => run.request)).toEqual([{ command: "brew install glab", label: "Install GitLab CLI" }]));
    // The wizard covers the workbench; it makes way for the terminal and leaves a way back in the title bar.
    expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull();
    expect(await screen.findByRole("button", { name: /Install GitLab CLI · Back to setup/ })).toBeTruthy();

    await act(async () => { runs[0]!.resolve({ id: "t1", exitCode: 0 }); });
    await screen.findByRole("heading", { name: "Your agents" });
    await waitFor(() => expect(calls.filter(([, command]) => command === "tools").length).toBe(asked + 1));
    expect(screen.queryByRole("button", { name: /Back to setup/ })).toBeNull();
  });

  it("groups clones of one repository and folds folders that are no repository away", async () => {
    const { invokeHostExtension } = host();
    const grouped: Discovery = { ...discovery, projects: [
      { path: "/work/app", name: "app", sources: ["codex"], threadCount: 3, lastActiveAt: NOW - DAY, git: true, remote: { key: "github.com/acme/app", label: "acme/app" } },
      { path: "/work/app-2", name: "app-2", sources: ["claude-code"], threadCount: 1, lastActiveAt: NOW - 2 * DAY, git: true, remote: { key: "github.com/acme/app", label: "acme/app" } },
      { path: "/work/notes", name: "notes", sources: ["codex"], threadCount: 4, lastActiveAt: NOW - DAY, git: false },
    ] };
    const answer = vi.fn(async (extensionId: string, command: string, input?: unknown) => command === "discover" ? grouped : invokeHostExtension(extensionId, command, input));
    renderApp(createFakeHostClient({ invokeHostExtension: answer }), { extensions: [onboarding] });
    await screen.findByRole("heading", { name: "Your agents" });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await screen.findByRole("heading", { name: "Choose your projects" });

    const group = screen.getByRole("checkbox", { name: "Add every folder of acme/app" }) as HTMLInputElement;
    // The default takes only the clone with three conversations.
    expect(group.indeterminate).toBe(true);
    expect((screen.getByRole("checkbox", { name: /app-2/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: "Add 2 projects" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /notes/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Other folders/ }));
    expect(screen.getByRole("checkbox", { name: /notes/ })).toBeTruthy();
  });

  it("opens although the thread index names the blank thread a start opens before setup asks", async () => {
    const { invokeHostExtension } = host();
    let answerState!: () => void;
    const delayed = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
      if (extensionId === "tau.onboarding" && command === "state") await new Promise<void>((resolve) => { answerState = resolve; });
      return invokeHostExtension(extensionId, command, input);
    });
    const client = createFakeHostClient({ invokeHostExtension: delayed });
    renderApp(client, { extensions: [onboarding] });
    await waitFor(() => expect(delayed).toHaveBeenCalledWith("tau.onboarding", "state", undefined));
    const session = (id: string, messageCount: number) => ({ id, path: `/s/${id}.jsonl`, title: "Untitled thread", modifiedAt: NOW, projectPath: "/work/alpha", projectName: "alpha", messageCount });
    act(() => { client.emit({ type: "thread-index", threadIndex: { projects: [], sessions: [session("blank", 0)] } }); });
    await act(async () => { answerState(); });
    await screen.findByRole("heading", { name: "Your agents" });
  });

  it("stays shut when the thread index already holds a thread with messages", async () => {
    const { invokeHostExtension } = host();
    let answerState!: () => void;
    const delayed = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
      if (extensionId === "tau.onboarding" && command === "state") await new Promise<void>((resolve) => { answerState = resolve; });
      return invokeHostExtension(extensionId, command, input);
    });
    const client = createFakeHostClient({ invokeHostExtension: delayed });
    renderApp(client, { extensions: [onboarding] });
    await waitFor(() => expect(delayed).toHaveBeenCalledWith("tau.onboarding", "state", undefined));
    act(() => { client.emit({ type: "thread-index", threadIndex: { projects: [], sessions: [{ id: "codex-1", path: "/s/codex-1.jsonl", title: "Imported", modifiedAt: NOW, projectPath: "/work/alpha", projectName: "alpha", messageCount: 4, backendKind: "codex" }] } }); });
    await act(async () => { answerState(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull();
  });

  it("stays shut on another machine the window shows, which is set up from Settings → Machines", async () => {
    const { calls, invokeHostExtension } = host();
    // The page's address names the machine it shows when that is not the window's own.
    const elsewhere: DesktopExtension = {
      ...onboarding,
      activate: (context) => onboarding.activate(new Proxy(context, {
        get: (target, key) => key === "environments" ? { shownElsewhere: "rex" } : Reflect.get(target, key),
      })),
    };
    renderApp(createFakeHostClient({ invokeHostExtension }), { extensions: [elsewhere] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull();
    expect(calls.filter(([id, command]) => id === "tau.onboarding" && command === "state")).toEqual([]);
  });

  it("stays closed once setup ran, and /welcome brings it back", async () => {
    const { invokeHostExtension } = host();
    await invokeHostExtension("tau.onboarding", "complete");
    const client = createFakeHostClient({ invokeHostExtension });
    renderApp(client, { extensions: [onboarding] });
    await waitFor(() => expect(invokeHostExtension).toHaveBeenCalledWith("tau.onboarding", "state", undefined));
    expect(screen.queryByRole("heading", { name: "Your agents" })).toBeNull();
    const composer = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/welcome" } });
    // The first Enter takes the command from the `/` menu, the second sends it.
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(composer.value).toBe("/welcome "));
    fireEvent.keyDown(composer, { key: "Enter" });
    await screen.findByRole("heading", { name: "Your agents" });
  });
});

describe("Onboarding's choices", () => {
  it("chooses the default projects and sessions and words the import result", () => {
    expect(defaultProjects(discovery.projects, NOW)).toEqual(["/work/alpha"]);
    expect(defaultSessions(discovery.sessions, new Set(["/work/alpha", "/work/old"]), NOW)).toEqual(["/h/c1.jsonl", "/h/x1.jsonl"]);
    expect(importSummary({ imported: 3, failed: 1 })).toBe("Imported 3 threads. 1 thread could not be imported.");
    expect(importSummary({ imported: 0, failed: 2 })).toBe("2 threads could not be imported.");
    expect([age(NOW - 30_000, NOW), age(NOW - 5 * 60_000, NOW), age(NOW - 3 * DAY, NOW), age(NOW - 90 * DAY, NOW), age(0, NOW)]).toEqual(["now", "5m", "3d", "3mo", ""]);
  });

  it("groups projects by their remote, newest first, and keeps folders without Git apart", () => {
    const project = (path: string, lastActiveAt: number, extra: Partial<Discovery["projects"][number]> = {}) => ({ path, name: path.split("/").pop()!, sources: ["codex" as const], threadCount: 1, lastActiveAt, git: true, ...extra });
    const remote = { key: "github.com/acme/app", label: "acme/app" };
    const { repositories, other } = groupProjects([
      project("/a/app", 5, { remote }), project("/b/solo", 9), project("/c/app", 7, { remote, sources: ["claude-code"] }), project("/d/plain", 8, { git: false }),
    ]);
    expect(repositories.map((group) => [group.label, group.projects.map((entry) => entry.path), group.threadCount, group.lastActiveAt, group.sources])).toEqual([
      ["solo", ["/b/solo"], 1, 9, ["codex"]],
      ["acme/app", ["/a/app", "/c/app"], 2, 7, ["codex", "claude-code"]],
    ]);
    expect(other.map((entry) => entry.path)).toEqual(["/d/plain"]);
  });

  it("says what each agent needs before it can be used", () => {
    const state = {
      step: 0 as const,
      added: [],
      tools,
      agents: {
        "claude-code": { installed: true, version: "2.1.0", signedIn: false },
        codex: { error: "Host extension tau.codex did not answer." },
        "claude-code@work": { installed: true, signedIn: false },
        antigravity: { installed: true },
      },
    };
    const backends = ["pi", "claude-code", "codex", "claude-code@work", "antigravity", "later"].map((kind) => ({ kind, label: kind }));
    const line = (row: { id: string; state: string; command?: string; settings?: string; signIn?: { extensionId: string; target: string } }) =>
      `${row.id}:${row.state}:${row.command ?? (row.signIn ? `sign-in=${row.signIn.extensionId}/${row.signIn.target}` : `settings=${row.settings ?? ""}`)}`;
    expect(agentRows(state, 0, backends).map(line)).toEqual([
      "pi:signIn:settings=pi-providers.settings",
      "claude-code:signIn:sign-in=tau.claude-code/default",
      "codex:settings:settings=providers",
      // An instance signs in to its own home.
      "claude-code@work:signIn:sign-in=tau.claude-code/work",
      "antigravity:settings:settings=providers",
      "later:checking:settings=",
    ]);
    expect(toolRows(state).map(line)).toEqual(["gh:ready:settings=", "glab:install:brew install glab"]);
    // A failed check says so in a few words; what the kit answered stays in the tooltip.
    expect(agentRows(state, 0, backends)[2]).toMatchObject({ summary: "Could not check", detail: expect.stringContaining("did not answer") });
  });

  it("sets a missing program up through its kit's sign-in when that can start, else with the vendor's installer", () => {
    const state = {
      step: 0 as const,
      added: [],
      tools,
      agents: {
        codex: { installed: false, signInInstalls: true },
        // An instance has a home of its own: no default installer for it.
        "codex@work": { installed: false, signInInstalls: true },
        "claude-code": { installed: false },
      },
    };
    const backends = ["pi", "codex", "codex@work", "claude-code"].map((kind) => ({ kind, label: kind }));
    const [, codex, work, claude] = agentRows(state, 1, backends);
    expect(codex).toMatchObject({ id: "codex", state: "signIn", summary: "Not installed · Tau fetches it when you sign in", signIn: { extensionId: "tau.codex", target: "default" }, ownInstall: "curl codex" });
    expect(codex).not.toHaveProperty("command");
    expect(work).toMatchObject({ id: "codex@work", state: "signIn", signIn: { extensionId: "tau.codex", target: "work" } });
    expect(work).not.toHaveProperty("ownInstall");
    expect(claude).toMatchObject({ id: "claude-code", state: "install", command: "curl claude" });
  });

  it("asks a missing program's kit whether its own sign-in can start without it", async () => {
    const kit = (status: unknown, signIn: (input: unknown) => unknown) => ({
      invoke: vi.fn(async (command: string, input?: unknown) => command === "status" ? status : signIn(input)),
      onEvent: () => () => undefined,
    });
    const kits = {
      "tau.codex": kit({ message: "not found" }, (input) => ({ methods: [{ id: "chatgpt-plan", label: "Continue with ChatGPT", kind: "browser", ...((input as { target: string }).target === "work" ? { unavailable: "Existing CLI threads." } : {}) }] })),
      "tau.claude-code": kit({}, () => ({ methods: [{ id: "console", label: "Console", kind: "terminal", unavailable: "Install the CLI first." }] })),
      "tau.opencode": kit({}, () => { throw new Error("Unknown command sign-in-state."); }),
    } as const;
    const flow = new WelcomeFlow({ invoke: async () => undefined, onEvent: () => () => undefined }, (id) => kits[id as keyof typeof kits]);
    flow.askAgents(["codex", "codex@work", "claude-code", "opencode"]);
    await waitFor(() => expect(Object.keys(flow.get().agents)).toHaveLength(4));
    expect(flow.get().agents).toEqual({
      codex: { installed: false, signInInstalls: true },
      "codex@work": { installed: false },
      "claude-code": { installed: false },
      opencode: { installed: false },
    });
    expect(kits["tau.codex"].invoke).toHaveBeenCalledWith("sign-in-state", { target: "default" });
    expect(kits["tau.codex"].invoke).toHaveBeenCalledWith("sign-in-state", { target: "work" });
  });

  it("goes past the steps that have nothing to choose, once the scan is in", () => {
    const known = new Set(["/work/alpha", "/work/old"]);
    const none = emptySteps({}, known);
    expect(none).toEqual({ projects: false, sessions: false });
    expect(emptySteps({ discovery }, new Set())).toEqual({ projects: false, sessions: false });
    // Every folder is a project in Tau already; every conversation was imported.
    expect(emptySteps({ discovery: { ...discovery, sessions: discovery.sessions.map((session) => ({ ...session, imported: true })) } }, known)).toEqual({ projects: true, sessions: true });
    expect(emptySteps({ discovery: { ...discovery, projects: [], sessions: [] } }, new Set())).toEqual({ projects: true, sessions: true });
    // A scan that failed is not "nothing": the step says why.
    expect(emptySteps({ discoverError: "Scan failed." }, new Set())).toEqual({ projects: false, sessions: false });
    expect(stepAfter(0, { projects: true, sessions: true })).toBe(3);
    expect(stepAfter(0, { projects: true, sessions: false })).toBe(2);
    expect(stepAfter(0, { projects: false, sessions: true })).toBe(1);
    expect(stepAfter(1, { projects: false, sessions: true })).toBe(3);
    expect(stepAfter(1, { projects: true, sessions: false })).toBe(2);
  });

  it("picks up after a project switch reloaded the page under it", async () => {
    const values = new Map<string, string>();
    const storage = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); }, keys: () => [...values.keys()] };
    const client = { invoke: async (command: string) => command === "project-ref" ? { workspaceId: "ws" } : undefined, onEvent: () => () => undefined };
    const flow = new WelcomeFlow(client, () => client, () => storage);
    flow.start();
    // The first switch never answers: the page went away under it.
    void flow.addProjects({ openWorkspace: () => new Promise<boolean>(() => undefined) } as never, ["/work/alpha", "/work/beta"]);
    await waitFor(() => expect(JSON.parse(values.get(FLOW_STORAGE_KEY) ?? "{}")).toMatchObject({ added: ["/work/alpha"], pending: ["/work/beta"] }));

    const reloaded = new WelcomeFlow(client, () => client, () => storage);
    expect(reloaded.interrupted()).toBe(true);
    expect(reloaded.get()).toMatchObject({ step: 0, added: ["/work/alpha"], pending: ["/work/beta"] });
    const openWorkspace = vi.fn(async () => true);
    reloaded.start();
    await reloaded.addProjects({ openWorkspace } as never, reloaded.get().pending!);
    expect(reloaded.get()).toMatchObject({ step: 2, added: ["/work/alpha", "/work/beta"] });
    await reloaded.finish();
    expect(values.has(FLOW_STORAGE_KEY)).toBe(false);
    expect(new WelcomeFlow(client, () => client, () => storage).interrupted()).toBe(false);
  });

  it("leaves without saying setup ran when asked to dismiss", async () => {
    const values = new Map<string, string>();
    const storage = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); }, keys: () => [...values.keys()] };
    const invoke = vi.fn(async () => undefined);
    const flow = new WelcomeFlow({ invoke, onEvent: () => () => undefined }, () => ({ invoke, onEvent: () => () => undefined }), () => storage);
    flow.start();
    flow.goTo(1);
    expect(values.has(FLOW_STORAGE_KEY)).toBe(true);
    flow.dismiss();
    expect(values.has(FLOW_STORAGE_KEY)).toBe(false);
    expect(flow.get().step).toBe(0);
    expect(invoke).not.toHaveBeenCalledWith("complete");
  });
});
