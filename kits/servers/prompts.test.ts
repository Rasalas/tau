import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createServersHostExtension } from "./host.js";
import { ServerPrompts, readPromptAnswer } from "./prompts.js";
import { SERVERS_EXTENSION_ID, SERVERS_PROMPTS_EVENT, decodeServerPrompts, type CredentialStatus } from "./protocol.js";
import { readSftpJson } from "./sftp-json.js";

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("ServerPrompts", () => {
  it("publishes open questions, takes the first answer and cancels on abort and dispose", async () => {
    const published: unknown[] = [];
    const prompts = new ServerPrompts((_event, payload) => published.push(payload));
    const first = prompts.ask({ kind: "secret", title: "Password", message: "m", confirmLabel: "Connect" });
    const [open] = prompts.pending();
    expect(decodeServerPrompts(published.at(-1))).toEqual([open]);
    expect(prompts.answer(open!.id, { action: "confirm", value: "typed" })).toBe(true);
    expect(prompts.answer(open!.id, { action: "cancel" })).toBe(false);
    await expect(first).resolves.toEqual({ action: "confirm", value: "typed" });
    expect(JSON.stringify(published)).not.toContain("typed");

    const controller = new AbortController();
    const aborted = prompts.ask({ kind: "confirm", title: "t", message: "m", confirmLabel: "OK" }, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toEqual({ action: "cancel" });
    const pending = prompts.ask({ kind: "confirm", title: "t", message: "m", confirmLabel: "OK" });
    prompts.dispose();
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(prompts.pending()).toEqual([]);
  });

  it("reads an answer only in its known shapes", () => {
    expect(readPromptAnswer({ id: "a", action: "confirm", value: "x" })).toEqual({ id: "a", answer: { action: "confirm", value: "x" } });
    expect(readPromptAnswer({ id: "a", action: "alternative" })).toEqual({ id: "a", answer: { action: "alternative" } });
    expect(readPromptAnswer({ id: "a", action: "confirm", value: 3 })).toBeUndefined();
    expect(readPromptAnswer({ action: "cancel" })).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("the host commands", () => {
  it("check a target's password through a question the window answers, and never publish the secret", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tau-servers-host-")));
    const state = await mkdtemp(join(tmpdir(), "tau-servers-state-"));
    temps.push(root, state);
    await mkdir(join(root, ".vscode"));
    // The secret is computed, so the command text (which the question shows) does not hold it.
    const text = JSON.stringify({ name: "site", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv", passwordCommand: "printf 'Tau-Test-%s' $((6*7))" });
    await writeFile(join(root, ".vscode", "sftp.json"), text);
    const targetId = readSftpJson(text).targets[0]!.id;
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createServersHostExtension(), {
      stateDir: state,
      knownWorkspacePath: async (path: string) => path,
      workspaceRef: () => ({ workspaceId: "ws-1" }),
      findCommand: () => undefined,
      log: () => undefined,
    } as unknown as Partial<HostExtensionServices>, (event) => events.push(event));
    try {
      const invoke = (command: string, input?: unknown) => registry.invoke(SERVERS_EXTENSION_ID, command, input);
      const before = await invoke("credential-status", { cwd: root }) as { targets: CredentialStatus[] };
      expect(before.targets[0]!.password).toMatchObject({ command: "needs-approval" });

      const check = invoke("check-credential", { cwd: root, targetId });
      await expect.poll(async () => decodeServerPrompts(await invoke("prompts"))).toHaveLength(1);
      const [question] = decodeServerPrompts(await invoke("prompts"));
      expect(question).toMatchObject({ kind: "confirm", detail: "printf 'Tau-Test-%s' $((6*7))" });
      await expect(invoke("answer-prompt", { id: question!.id, action: "maybe" })).rejects.toThrow(/Not an answer/u);
      await invoke("answer-prompt", { id: question!.id, action: "confirm" });
      await expect(check).resolves.toEqual({ found: true, source: "The password command in sftp.json" });

      const after = await invoke("credential-status", { cwd: root }) as { targets: CredentialStatus[] };
      expect(after.targets[0]!.password).toMatchObject({ command: "allowed" });
      await invoke("forget-credential-approvals", { cwd: root });
      expect(((await invoke("credential-status", { cwd: root })) as { targets: CredentialStatus[] }).targets[0]!.password.command).toBe("needs-approval");

      const promptEvents = events.filter((event) => event.name === SERVERS_PROMPTS_EVENT);
      expect(promptEvents.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(events)).not.toContain("Tau-Test-42");
      for (const name of await readdir(state, { recursive: true })) {
        expect(await readFile(join(state, name), "utf8").catch(() => "")).not.toContain("Tau-Test-42");
      }
    } finally {
      await registry.dispose();
    }
  });
});
