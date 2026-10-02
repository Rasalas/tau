// @vitest-environment jsdom
// Issue #12: workspace images on phone and tablet.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./test-support/render-app";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { setHostClient } from "./host-client-context";
import { runPaletteCommand } from "./test-support/palette";
import { setClientStorage } from "../workbench/client-storage";
import type { DesktopExtension, DocumentOrigin } from "./extension-system";

const paths = [".tau-dev/dictation-preview/recording-detail.png", ".tau-dev/dictation-preview/inserted-detail.png"];
const documentPath = ".scratch/mobile-transcript-images/issues/01-render-workspace-screenshots-on-mobile.md";
const body = `![During recording](${paths[0]})\n\n![Text im Entwurf](${paths[1]})\n\n\`${documentPath}\``;
const text = "Issue 12 readable workspace document fixture";
const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "width", { configurable: true, value: 0 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 0 });
});

function fixture(width: number, profile = "compact") {
  window.history.replaceState({}, "", `/?profile=${profile}`);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 900 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  const loads: Array<{ path: string; from?: DocumentOrigin }> = [];
  const state = { changes: { isRepo: true, files: [] } };
  const documents: DesktopExtension = { id: "test.issue12", name: "Issue 12 fixture", activate(plugin) {
    plugin.registerDocumentSource({ id: "issue12", profiles: ["desktop", "web", "compact"],
      loadFile: async (path, from) => {
        loads.push({ path, from });
        if (from?.workspace !== "ws-origin") throw new Error("Wrong originating workspace");
        if (paths.includes(path)) return { path, name: path.split("/").pop()!, kind: "image", dataUrl, size: 68 };
        if (path !== documentPath) throw new Error("Wrong path");
        return { path, name: "01-render-workspace-screenshots-on-mobile.md", kind: "text", text, size: text.length };
      },
      loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }),
      openInEditor: () => undefined,
      getState: () => state as never,
      subscribe: () => () => undefined,
    });
  } };
  const client = createFakeHostClient({ bootstrap: async () => ({
    version: 1, threadIndex: { projects: [], sessions: [{ id: "issue12-thread", path: "/fixture/session.jsonl", title: "Issue 12 thread", modifiedAt: 1, projectPath: "/isolated/origin", workspaceId: "ws-origin", projectName: "fixture", messageCount: 1 }] },
    detail: { sessionId: "issue12-thread", messages: [{ id: "issue12-answer", role: "assistant", text: body, timestamp: 1 }], isStreaming: false, activeTools: [] },
    catalog: { sessionId: "issue12-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
    project: { cwd: "/isolated/origin", workspaceId: "ws-origin" },
  }) });
  return { ...renderApp(client, { extensions: [documents] }), loads };
}

describe("issue 12 remote workspace images", () => {
  for (const [device, width] of [["iPhone", 390], ["iPad", 1024]] as const) {
    for (const [index, alt] of ["During recording", "Text im Entwurf"].entries()) {
      it(`${device} ${alt} does not resolve against the mobile app origin`, async () => {
        const { loads } = fixture(width);
        if (width < 720) await runPaletteCommand("Toggle sidebar");
        const image = await screen.findByRole("img", { name: alt }) as HTMLImageElement;
        await waitFor(() => expect(image.getAttribute("src")).toBe(dataUrl));
        const reads = loads.filter((load) => load.path === paths[index]);
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((load) => load.from?.workspace === "ws-origin")).toBe(true);
        expect(image.src).not.toBe(new URL(paths[index]!, window.location.href).href);
      });
    }
  }
});
