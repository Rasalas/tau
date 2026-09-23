import { useEffect, useState } from "react";
import type { HostEvent, UiMessage } from "../shared/contracts";
import App from "./App";
import { HostClientProvider, setHostClient } from "./host-client-context";
import { ClientStorageProvider } from "./client-storage-context";
import { RendererServicesProvider } from "./renderer-services-context";
import { createRendererServices } from "./renderer-services";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";

/**
 * The whole workbench, fed by a scripted host: a thread with history, a run
 * that starts one bash call, and that call's output growing once per frame.
 * The timed span per update is the store's frame flush plus React's commit.
 */
export interface AppToolStreamOptions {
  updates: number;
  linesPerUpdate: number;
  onReady(): void;
  onUpdate(durationMs: number): void;
  onFinished(): void;
}

const SESSION = "renderer-benchmark";

function history(turns: number): UiMessage[] {
  return Array.from({ length: turns * 2 }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: index % 2 === 0 ? `Question ${index / 2}` : `Answer ${index}\n\nA settled reply with a little Markdown: \`code\` and **bold**.`,
    timestamp: index,
  }));
}

export default function AppToolStreamScenario(options: AppToolStreamOptions) {
  const [setup] = useState(() => {
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/benchmark", name: "benchmark", lastOpenedAt: 1 }],
          sessions: [{ id: SESSION, path: "/benchmark/session.jsonl", title: "Benchmark", modifiedAt: 1, projectPath: "/benchmark", projectName: "benchmark", messageCount: 40 }],
        },
        detail: { sessionId: SESSION, messages: history(20), isStreaming: false, activeTools: [] },
        catalog: { sessionId: SESSION, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/benchmark" },
      }),
    });
    const storage = createMemoryStorage();
    setHostClient(client);
    setClientStorage(storage);
    return { client, storage, services: createRendererServices() };
  });

  useEffect(() => {
    const { client } = setup;
    let stopped = false;
    const emit = (event: HostEvent) => { if (!stopped) client.emit(event); };
    const nextFrame = (callback: () => void) => requestAnimationFrame(() => { if (!stopped) callback(); });

    let output = "";
    let sent = 0;
    const line = (index: number) => `${String(index).padStart(6, "0")} building module ${index % 97} of the benchmark workspace\n`;
    // B runs before the store's flush in the next frame, E after it; both
    // were queued around the emit, and animation frames run in queue order.
    const step = () => {
      if (sent === options.updates) {
        emit({ type: "tool-end", sessionId: SESSION, tool: { id: "benchmark-tool", name: "bash", args: { command: "benchmark" }, output, status: "done", startedAt: 0, endedAt: 1 } });
        emit({ type: "agent-status", sessionId: SESSION, running: false });
        nextFrame(options.onFinished);
        return;
      }
      for (let index = 0; index < options.linesPerUpdate; index += 1) output += line(sent * options.linesPerUpdate + index);
      let startedAt = 0;
      requestAnimationFrame(() => { startedAt = performance.now(); });
      emit({ type: "tool-update", sessionId: SESSION, id: "benchmark-tool", output });
      sent += 1;
      nextFrame(() => {
        options.onUpdate(performance.now() - startedAt);
        step();
      });
    };

    const waitForTranscript = () => {
      if (!document.querySelector(".transcript .virtual-transcript-row")) { nextFrame(waitForTranscript); return; }
      emit({ type: "agent-status", sessionId: SESSION, running: true });
      emit({ type: "tool-start", sessionId: SESSION, tool: { id: "benchmark-tool", name: "bash", args: { command: "benchmark" }, status: "running", startedAt: Date.now() } });
      // Two frames for the run to settle before the timed updates begin.
      nextFrame(() => nextFrame(() => { options.onReady(); step(); }));
    };
    nextFrame(waitForTranscript);
    return () => { stopped = true; };
  // The scenario runs once per mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  return <HostClientProvider client={setup.client}>
    <ClientStorageProvider storage={setup.storage}>
      <RendererServicesProvider services={setup.services}>
        <App />
      </RendererServicesProvider>
    </ClientStorageProvider>
  </HostClientProvider>;
}
