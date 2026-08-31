import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiComposerCommand } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { PiHost } from "./pi-host.js";
import { PI_RUNTIME_ADAPTER, type SkillRuntimeAdapter } from "./skill-invocation.js";

const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test-driven development" }];

function localHost(adapter: SkillRuntimeAdapter) {
  const prompt = vi.fn(async () => undefined);
  const steer = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const session = {
    sessionId: "session",
    sessionName: undefined as string | undefined,
    sessionFile: "/tmp/session.jsonl",
    messages: [],
    model: { provider: "anthropic", id: "model" },
    isStreaming: false,
    settingsManager: { getEnableSkillCommands: () => true },
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getPrompts: () => ({ prompts: [] }),
      getSkills: () => ({ skills: [{ name: "tdd", description: "Test-driven development" }] }),
    },
    prompt,
    steer,
    followUp,
  };
  const thread = { session, sessionId: "session", cwd: "/repo", sessionFile: "/tmp/session.jsonl", skillRuntimeAdapter: adapter };
  const host = new PiHost("/repo", () => undefined, {} as never, true, false, { skillRuntimeAdapter: adapter });
  const internals = host as unknown as {
    threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
    branchFor: () => undefined;
    publishThreadShellSoon: () => void;
  };
  internals.branchFor = () => undefined;
  internals.publishThreadShellSoon = () => undefined;
  return { host, session, thread, internals };
}

async function adopt(host: ReturnType<typeof localHost>): Promise<void> {
  await host.internals.threads.adopt({
    sessionId: host.thread.sessionId,
    cwd: host.thread.cwd,
    runtime: host.thread,
    isolation: "in-process",
  });
  host.internals.threads.setActive(host.thread.sessionId);
}

describe("PiHost skill delivery", () => {
  it("maps bridge messages through the bridge's explicit runtime capability", () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      bridgeSnapshot: PiBridgeSnapshot;
      bridgeHostSnapshot(): HostSnapshot;
    };
    internals.bridgeSnapshot = {
      sessionId: "bridge",
      sessionFile: "/tmp/bridge.jsonl",
      cwd: "/repo",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "$tdd fix it" }],
        timestamp: 1,
      }],
      isStreaming: false,
      model: { provider: "anthropic", id: "model" },
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      composerCommands: commands,
    };

    expect(internals.bridgeHostSnapshot().messages[0]).toMatchObject({
      text: "fix it",
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd fix it" },
    });
  });

  it("normalizes local delivery through the explicit Pi adapter", async () => {
    const fixture = localHost(PI_RUNTIME_ADAPTER);
    await adopt(fixture);
    await fixture.host.prompt("$tdd fix it", [], "session");
    expect(fixture.session.prompt).toHaveBeenCalledWith("/skill:tdd fix it", expect.objectContaining({ images: [] }));
  });

  it("normalizes local delivery through an explicit Claude Code adapter, not model.provider", async () => {
    const adapter: SkillRuntimeAdapter = { capabilities: { skillInvocationDialect: "claude-code" } };
    const fixture = localHost(adapter);
    await adopt(fixture);
    await fixture.host.prompt("$tdd fix it", [], "session");
    expect(fixture.session.prompt).toHaveBeenCalledWith("/tdd fix it", expect.objectContaining({ images: [] }));
  });

  it("passes prompt, steer, follow-up, and new-session intent raw to the runtime owner", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false, {
      skillRuntimeAdapter: { capabilities: { skillInvocationDialect: "claude-code" } },
    });
    const command = vi.fn(async () => undefined);
    const internals = host as unknown as {
      bridge: { command: typeof command };
      bridgeSnapshot: { sessionId: string };
    };
    internals.bridge = { command };
    internals.bridgeSnapshot = { sessionId: "bridge" };

    await host.prompt("$tdd fix it", [], "bridge");
    await host.steer("$tdd steer it", [], "bridge");
    await host.followUp("$tdd follow it", [], "bridge");
    await host.newSession("$tdd start it");
    expect(command.mock.calls).toEqual([
      [{ command: "prompt", text: "$tdd fix it" }],
      [{ command: "prompt", text: "$tdd steer it", deliverAs: "steer" }],
      [{ command: "prompt", text: "$tdd follow it", deliverAs: "followUp" }],
      [{ command: "new_session", initialPrompt: "$tdd start it" }],
    ]);
  });
});
