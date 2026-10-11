import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderTools } from "./provider.js";
import { createGitHubProvider } from "./provider-github.js";
import { markBotComments, parseGitHubBotLogins, parseGitHubDetail, parseRequestUrl } from "./pull-request-json.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const REF = parseRequestUrl("https://github.com/acme/tau/pull/7")!;
const AUTHORS = JSON.stringify({ data: { repository: { pullRequest: {
  comments: { nodes: [{ author: { login: "octo", __typename: "User" } }, { author: { login: "ci-bot", __typename: "Bot" } }, { author: null }] },
  reviews: { nodes: [{ author: { login: "coderabbitai", __typename: "Bot" } }] },
} } } });

describe("bots among a GitHub request's comments", () => {
  it("reads the bot accounts from the account types and marks their comments", () => {
    const logins = parseGitHubBotLogins(AUTHORS);
    expect([...logins]).toEqual(["ci-bot", "coderabbitai"]);
    const detail = parseGitHubDetail(REF, fixture("gh-pr-view-discussed.json"));
    // `gh pr view` names the account without its [bot] suffix.
    const bare = { ...detail, comments: detail.comments.map((comment) => comment.author.login === "ci-bot[bot]" ? { ...comment, author: { login: "ci-bot" } } : comment) };
    const marked = markBotComments(bare, logins);
    expect(marked.comments.filter((comment) => comment.author.bot).map((comment) => comment.author.login)).toEqual(["ci-bot"]);
    expect(markBotComments(bare, new Set())).toBe(bare);
  });

  it("asks for the account types with the detail, and still answers when that read fails", async () => {
    const calls: string[][] = [];
    const tools = {
      cli: async (_kind: string, call: { args: string[] }) => {
        calls.push(call.args);
        if (call.args[0] === "pr") return fixture("gh-pr-view-discussed.json");
        return AUTHORS;
      },
    } as unknown as ProviderTools;
    const detail = await createGitHubProvider(tools).detail(REF, false);
    expect(calls.map((args) => args.slice(0, 3))).toEqual([["pr", "view", REF.url], ["api", "--hostname", "github.com"]]);
    expect(calls[1]!.join(" ")).toContain("__typename");
    expect(detail.comments.filter((comment) => comment.author.bot).map((comment) => comment.author.login)).toEqual(["ci-bot[bot]"]);

    const failing = { cli: async (_kind: string, call: { args: string[] }) => { if (call.args[0] === "pr") return fixture("gh-pr-view-discussed.json"); throw new Error("rate limited"); } } as unknown as ProviderTools;
    await expect(createGitHubProvider(failing).detail(REF, false)).resolves.toMatchObject({ title: "Add the output helper" });
  });
});
