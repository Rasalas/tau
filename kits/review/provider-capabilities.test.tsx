// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, HostExtensionClient, PreferencesStore, StageTabHandle, WorkbenchActions } from "tau";
import { PendingReviewStore } from "./pending-review.js";
import type { PullRequestDetail, PullRequestFiles, PullRequestRef, PullRequestThread, SourceProviderStatus } from "./protocol.js";
import { parseAzureDetail, parseAzurePolicies, parseAzureThreads } from "./provider-azure.js";
import { parseBitbucketChecks, parseBitbucketDetail, parseBitbucketThreads } from "./provider-bitbucket.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseRequestUrl, parseUnifiedDiff } from "./pull-request-json.js";
import { PullRequestView } from "./pull-request-view.js";
import { RowRequests } from "./requests.js";
import { createReviewSettingsPage, REVIEW_SETTINGS_ROWS } from "./settings-page.js";
import { SourceControlSettings } from "./source-settings.js";
import { missingSettingsRows, renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { ThreadLinkRows } from "./thread-links-store.js";

afterEach(cleanup);

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function client(detail: PullRequestDetail, threads: PullRequestThread[], files?: PullRequestFiles): PullRequestClient {
  return {
    view: vi.fn(async () => detail),
    checks: vi.fn(async () => detail.checks),
    pipeline: vi.fn(async () => ({})),
    threads: vi.fn(async () => threads),
    files: vi.fn(async () => { if (!files) throw new Error("no diff"); return files; }),
    comment: vi.fn(async () => undefined),
    update: vi.fn(async () => detail),
    viewed: vi.fn(async () => "viewed" as const),
    review: vi.fn(async () => detail),
    resolve: vi.fn(async () => threads),
    editComment: vi.fn(async () => undefined),
    reviewers: vi.fn(async () => detail),
    labels: vi.fn(async () => detail),
    candidates: vi.fn(async () => ({ labels: [], reviewers: [] })),
    list: vi.fn(async () => { throw new Error("not in this test"); }),
    links: vi.fn(async () => []),
    link: vi.fn(async () => { throw new Error("not in this test"); }),
    unlink: vi.fn(async () => true),
    listMany: vi.fn(async () => ({ lists: [], failures: [] })),
    action: vi.fn(async () => { throw new Error("not in this test"); }),
    stack: vi.fn(async () => null),
    stackAction: vi.fn(async () => { throw new Error("not in this test"); }),
    linkedThreads: vi.fn(async () => []),
    onLinksChanged: () => () => undefined,
  };
}

function memoryStorage(): ClientStorage {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, remove: (key) => { values.delete(key); }, keys: () => [...values.keys()] };
}

function renderView(ref: PullRequestRef, view: PullRequestClient) {
  const storage = memoryStorage();
  const snapshot = {};
  const preferences = { subscribe: () => () => undefined, getSnapshot: () => snapshot, optionValue: (_id: string, _key: string, fallback: unknown) => fallback, setOption: vi.fn() } as unknown as PreferencesStore;
  const actions = { activeThread: () => ({ sessionId: "thread-1", cwd: "/project", draftPending: false }), openExternal: vi.fn(), notify: vi.fn(), copyText: vi.fn(async () => undefined) } as unknown as WorkbenchActions;
  const handle: StageTabHandle = { id: "tab", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined };
  const shared = { links: new ThreadLinkRows(view), pending: new PendingReviewStore(() => storage, () => `held-${Math.random()}`), preferences };
  render(<PullRequestView params={{ url: ref.url, number: ref.number, service: ref.service }} handle={handle} actions={actions} client={view} chips={() => undefined} rows={new RowRequests(async () => undefined)} shared={shared} />);
}

describe("what a provider cannot do is hidden", () => {
  it("gives an Azure DevOps request no Code tab, no labels and verdicts only as votes", async () => {
    const ref = parseRequestUrl("https://dev.azure.com/powershell/PowerShell/_git/PowerShell/pullrequest/46")!;
    const threads = fixture("azure-threads.json");
    const detail = parseAzureDetail(ref, fixture("azure-pr.json"), threads, fixture("azure-commits.json"), parseAzurePolicies(fixture("azure-policies.json")));
    renderView(ref, client(detail, parseAzureThreads(threads).threads));
    expect(await screen.findByRole("heading", { name: "Inventory bootstrapping" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Summary", "Timeline"]);
    expect(screen.queryByRole("button", { name: "Add a label" })).toBeNull();
    expect(screen.getByRole("button", { name: "Request a review" })).toBeTruthy();
    expect(screen.getByText("az repos pr checkout --id 46")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment on or review PR #46" }));
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getAllByRole("radio").map((radio) => radio.parentElement?.textContent?.trim())).toEqual(["Approve", "Request changes"]);
  });

  it("gives a Bitbucket conversation a reply but no Resolve, and hides reviewers and labels editing", async () => {
    const ref = parseRequestUrl("https://bitbucket.org/atlassian/bitbucket-upload-file/pull-requests/11")!;
    const comments = fixture("bitbucket-comments.json");
    const detail = parseBitbucketDetail(ref, fixture("bitbucket-pull.json"), comments, fixture("bitbucket-commits.json"), parseBitbucketChecks(fixture("bitbucket-statuses.json")), fixture("bitbucket-diffstat.json"));
    const entries = parseUnifiedDiff(fixture("bitbucket-pull.diff"));
    const files: PullRequestFiles = { files: entries.map((entry) => ({ ...entry.file, viewed: "unviewed" })), diffs: entries.map((entry) => entry.diff), viewedOn: "local" };
    renderView(ref, client(detail, parseBitbucketThreads(comments), files));
    await screen.findByRole("heading", { name: detail.title });
    expect(screen.queryByRole("button", { name: "Request a review" })).toBeNull();
    expect(screen.queryByText("Labels")).toBeNull();
    // No CLI of Bitbucket's own checks a request out.
    expect(screen.queryByTitle("Copy the checkout command")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Reply" }).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });
});

describe("Settings → Review", () => {
  function sourceHost() {
    const statuses: SourceProviderStatus[] = [
      { service: "github", name: "GitHub", tool: "GitHub CLI (gh)", installed: true, signedIn: true, account: "octo" },
      { service: "forgejo", name: "Forgejo", tool: "Gitea CLI (tea)", installed: false, hint: "Gitea CLI (tea) is not installed or not on your PATH." },
    ];
    let hosts: Record<string, string> = { "git.example.com": "forgejo" };
    const invoke = vi.fn(async (command: string, input?: unknown) => {
      if (command === "source-providers") return statuses;
      if (command === "source-hosts") return hosts;
      const { host, service } = input as { host: string; service: string | null };
      hosts = service ? { ...hosts, [host]: service } : Object.fromEntries(Object.entries(hosts).filter(([name]) => name !== host));
      return hosts;
    });
    return { invoke, host: { invoke, onEvent: () => () => undefined } as unknown as HostExtensionClient };
  }

  it("lists each provider's setup and keeps the self-hosted servers", async () => {
    const { invoke, host } = sourceHost();
    const onNotify = vi.fn();
    render(<SourceControlSettings host={host} onNotify={onNotify} />);
    expect(await screen.findByText("Signed in as octo.")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
    expect(screen.getByText(/Left to the website: replies, resolving conversations, publishing\./u)).toBeTruthy();

    // An empty server says what is missing instead of adding nothing.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onNotify).toHaveBeenCalledWith("Enter the server's host name first, such as git.example.com.");
    const server = screen.getByRole("textbox", { name: "Server" });
    fireEvent.change(server, { target: { value: "code.example.com:8443" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "gitlab" } });
    // Return in the field adds, as the button does.
    fireEvent.submit((server as HTMLInputElement).form!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-source-host", { host: "code.example.com:8443", service: "gitlab" }));
    expect(await screen.findByText("code.example.com:8443")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget git.example.com" }));
    await waitFor(() => expect(screen.queryByText("git.example.com")).toBeNull());
  });

  it("says when the hosts could not be checked, and checks again", async () => {
    const { invoke, host } = sourceHost();
    invoke.mockRejectedValueOnce(new Error("gh crashed"));
    render(<SourceControlSettings host={host} onNotify={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("gh crashed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Signed in as octo.")).toBeTruthy();
  });

  it("writes the format, the instructions and the diff colours, and has every searched row", async () => {
    const { host } = sourceHost();
    const Page = createReviewSettingsPage(host);
    const { updates, cleared } = renderKitSettingsPage(Page, { host: { values: { "tau.review.writing-instructions": "Say why." } } });
    const key = (name: string) => `tau.review.${name}`;

    fireEvent.change(screen.getByRole("combobox", { name: "Commit message format" }), { target: { value: "gitmoji" } });
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("commit-style")]: "gitmoji" } }));

    const instructions = screen.getByRole("textbox", { name: "Your instructions" }) as HTMLTextAreaElement;
    await waitFor(() => expect(instructions.value).toBe("Say why."));
    expect(instructions.tagName).toBe("TEXTAREA");
    fireEvent.change(instructions, { target: { value: "  Say why.\nName the ticket.  " } });
    fireEvent.keyDown(instructions, { key: "Enter", metaKey: true });
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("writing-instructions")]: "Say why.\nName the ticket." } }));
    fireEvent.change(instructions, { target: { value: "" } });
    fireEvent.blur(instructions);
    await waitFor(() => expect(cleared).toContainEqual([`values.${key("writing-instructions")}`]));

    const colours = screen.getByRole("radiogroup", { name: "Diff colours" });
    expect(within(colours).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Red & green", "Blue & orange"]);
    fireEvent.click(within(colours).getByRole("radio", { name: "Blue & orange" }));
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("diff-colors")]: "blue-orange" } }));

    fireEvent.click(screen.getByRole("switch", { name: "Split view" }));
    await waitFor(() => expect(updates).toContainEqual({ options: { [key("split-diff")]: true } }));
    await screen.findByText("Signed in as octo.");
    expect(missingSettingsRows({ rows: REVIEW_SETTINGS_ROWS })).toEqual([]);
  });
});
