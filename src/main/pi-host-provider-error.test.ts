import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";

const PROVIDER_TEXT = "Unsupported parameter: temperature";

/** A model on 127.0.0.1 that refuses every request the way OpenAI refuses a parameter. */
async function refusingModel() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: PROVIDER_TEXT, type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-provider-error-"));
  // Pi may still finish a write into its agent dir after the host is gone.
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const model = await refusingModel();
  cleanups.push(model.close);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "tau-fake": {
    baseUrl: model.baseUrl, api: "openai-completions", apiKey: "fake",
    models: [{ id: "fake-1", name: "Fake 1", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  // No automatic retry: the turn must end on the provider's first answer.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "tau-fake", defaultModel: "fake-1", retry: { enabled: false } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const sessions = join(root, "sessions");
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessions);
  vi.stubEnv("TAU_CONFIG_FILE", join(root, "tau-config.json"));
  cleanups.push(async () => { vi.unstubAllEnvs(); });
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined, flush: async () => undefined };
  const open = async () => {
    const events: HostEvent[] = [];
    const host = new PiHost(workspace, (event) => events.push(event), history as never, false, false, { hostExtensions: [] });
    let disposed = false;
    const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); } };
    cleanups.push(dispose);
    await host.start();
    return { host, events, dispose };
  };
  return { open, sessions };
}

describe("a provider error on a Pi turn", () => {
  it("reaches the transcript with the provider's text, live and after the host restarts", async () => {
    const { open, sessions } = await fixture();
    const first = await open();
    await first.host.prompt("Reply with one word: ok");
    await vi.waitFor(() => {
      expect(first.events.some((event) => event.type === "agent-status" && !event.running)).toBe(true);
    }, { timeout: 30_000 });

    // Live: the answer the renderer receives carries the provider's words, and so does the thread it reads.
    const ended = first.events.flatMap((event) => event.type === "assistant-end" ? [event.message] : []);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ role: "assistant", text: "" });
    expect(ended[0]?.error).toContain(PROVIDER_TEXT);
    expect((await first.host.snapshot()).messages.at(-1)?.error).toContain(PROVIDER_TEXT);

    // Restarted: nothing but the session file knows the turn failed.
    await first.dispose();
    const sessionFiles = (await readdir(sessions, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
    expect(sessionFiles).toHaveLength(1);
    const second = await open();
    await second.host.switchSession(join(sessions, sessionFiles[0]!));
    const reopened = (await second.host.snapshot()).messages;
    expect(reopened.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(reopened.at(-1)?.error).toContain(PROVIDER_TEXT);
  });
});
