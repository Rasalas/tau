import { describe, expect, it } from "vitest";
import { createWorkspaceHostClient } from "./protocol.js";

function recorder() {
  const calls: Array<{ command: string; input?: unknown }> = [];
  const client = createWorkspaceHostClient(async (command, input) => {
    calls.push({ command, input });
    return undefined;
  });
  return { calls, client };
}

describe("Workspace Kit client encoding", () => {
  it("names the workspace on Git writes and branch safety reads", async () => {
    const { calls, client } = recorder();
    await client.stageFile("a", "ws1_rex");
    await client.unstageFile("a", "ws1_rex");
    await client.revertFile("a", "ws1_rex");
    await client.stageAll("ws1_rex");
    await client.pull("ws1_rex");
    await client.push("ws1_rex");
    await client.createBranch("fix", "ws1_rex");
    await client.switchRef("main", "ws1_rex");
    await client.checkoutTurns("thread", "ws1_rex");
    for (const call of calls) expect(call.input).toHaveProperty("workspace", "ws1_rex");
  });

  it("names a file by its path inside the workspace", async () => {
    const { calls, client } = recorder();
    await client.readFile("src/main/index.ts");
    await client.getFileDiff("src/main/index.ts", { contextLines: 3 });
    await client.stageFile("src/a.ts");
    await client.unstageFile("src/a.ts");
    await client.revertFile("src/a.ts");
    await client.getFileTree("src");
    await client.openInEditor("zed", "src/a.ts", "ws1_project");
    await client.getTurnFileDiff("session", "checkpoint", "src/a.ts");
    expect(calls.map((call) => call.command)).toEqual([
      "read-file", "file-diff", "stage-file", "unstage-file", "revert-file", "file-tree", "open-in-editor", "turn-file-diff",
    ]);
    for (const call of calls) expect(call.input).toHaveProperty("relPath");
    expect(calls.find((call) => call.command === "open-in-editor")?.input).toMatchObject({ workspace: "ws1_project" });
    // Nothing carries a path of the host's own filesystem.
    for (const call of calls) expect(JSON.stringify(call.input)).not.toContain("/src");
  });

  it("sends external transcript links with an explicit originating workspace", async () => {
    const { calls, client } = recorder();
    await client.readLinkedFile("../docs/draft.md", "ws1_thread");
    await client.readLinkedFile("/host/docs/draft.md", "ws1_thread");
    expect(calls).toEqual([
      { command: "read-linked-file", input: { path: "../docs/draft.md", workspace: "ws1_thread" } },
      { command: "read-linked-file", input: { path: "/host/docs/draft.md", workspace: "ws1_thread" } },
    ]);
  });

  it("names a workspace by its id, and omits it for the host's own", async () => {
    const { calls, client } = recorder();
    await client.getWorkspaceInfo("ws1_project");
    await client.getWorktreeStatuses("ws1_project");
    await client.createWorktree("fix/queue", { baseRef: "main" }, "ws1_project");
    await client.getWorkspaceInfo();
    expect(calls[0]?.input).toEqual({ workspace: "ws1_project" });
    expect(calls[1]?.input).toEqual({ workspace: "ws1_project" });
    expect(calls[2]?.input).toEqual({ branch: "fix/queue", baseRef: "main", workspace: "ws1_project" });
    expect(calls[3]?.input).toBeUndefined();
  });

  it("sends pull as a workspace command without path input", async () => {
    const { calls, client } = recorder();
    await client.pull();
    expect(calls).toEqual([{ command: "pull", input: undefined }]);
  });

  it("keeps folder browsing on host paths", async () => {
    const { calls, client } = recorder();
    await client.listDirectories("/Users/me");
    await client.startClone("git@example.com:acme/app.git", "/Users/me/code");
    expect(calls[0]?.input).toEqual({ path: "/Users/me" });
    expect(calls[1]?.input).toEqual({ repositoryUrl: "git@example.com:acme/app.git", parentPath: "/Users/me/code" });
  });
});
