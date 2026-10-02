import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PreviewAppearance, PreviewRecording, PreviewState, PreviewViewport } from "./protocol.js";
import {
  isPreviewRef,
  pageCall,
  previewClick,
  previewCondition,
  previewFind,
  previewScroll,
  previewSnapshot,
  previewType,
  type PreviewActionResult,
  type PreviewTarget,
} from "./page-script.js";
import { VIEWPORT_PRESETS, readViewport, viewportLabel } from "./viewport.js";

/** A tool of any shape, as the array of them and `registerTool` see it. */
// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
export type AnyTool = ToolDefinition<TSchema, any, any>;

/**
 * Pi's `defineTool` is identity, and a kit takes the SDK's types rather than
 * its module: importing the value would bundle the whole agent into the kit.
 */
const defineTool = <Params extends TSchema, Details = unknown>(tool: ToolDefinition<Params, Details>): AnyTool =>
  tool as unknown as AnyTool;

export const TOOL_TIMEOUT_MS = 30_000;
const SCREENSHOT_MAX_WIDTH = 1_280;
const EVALUATE_MAX_CHARS = 20_000;

/** What the tools reach of the page; the Electron view stays behind it. */
export interface PreviewToolPage {
  state(): PreviewState;
  viewport(): { width: number; height: number };
  evaluate(expression: string): Promise<unknown>;
  capture(maxWidth: number): Promise<{ base64: string; width: number; height: number }>;
  pressKey(key: string): void;
}

/** The part of the preview's controller the agent's tools drive. */
export interface PreviewToolController {
  /** The thread `threadId`'s agent is using the page now; the floating preview follows it. */
  drive(threadId: string): void;
  page(): Promise<PreviewToolPage>;
  open(url: unknown): Promise<PreviewState>;
  navigate(input: unknown): Promise<PreviewState>;
  evaluate(expression: string): Promise<unknown>;
  /** Draws the agent's cursor where an action landed. */
  pointAt(kind: "click" | "type" | "key" | "scroll", result: PreviewActionResult | undefined, detail?: { text?: string; key?: string; direction?: "up" | "down" | "left" | "right" }): void;
  resize(viewport: PreviewViewport): Promise<PreviewState>;
  setAppearance(appearance: PreviewAppearance): Promise<PreviewState>;
  recordStart(): Promise<PreviewState>;
  recordStop(): Promise<PreviewRecording | null>;
}

/** A tool result that also carries Pi's error flag. */
type ToolAnswer = AgentToolResult<unknown> & { isError?: boolean };

const answer = (message: string): ToolAnswer => ({ content: [{ type: "text", text: message }], details: undefined });
const failure = (message: string): ToolAnswer => ({ content: [{ type: "text", text: message }], details: undefined, isError: true });

function target(params: { ref?: string; selector?: string; text?: string }, allowText: boolean): PreviewTarget {
  if (params.ref) {
    if (!isPreviewRef(params.ref)) throw new Error(`"${params.ref}" is not a ref; take a preview_snapshot first.`);
    return { ref: params.ref };
  }
  if (params.selector) return { selector: params.selector };
  if (allowText && params.text) return { text: params.text };
  throw new Error(allowText ? "Name the element by ref, selector or text." : "Name the element by ref or selector.");
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(signal.reason instanceof Error ? signal.reason.message : "Preview tool was cancelled.")), { once: true });
  });
}

/** Every tool stops at 30 s, and at whatever the runtime cancels first. */
async function bounded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const guard = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
  return Promise.race([work(), aborted(guard)]);
}

export function describeState(state: PreviewState, viewport?: { width: number; height: number }): string {
  const lines = [
    `url: ${state.url || "(nothing loaded)"}`,
    `title: ${state.title || "(untitled)"}`,
    `loading: ${state.loading}`,
    ...(viewport ? [`viewport: ${viewport.width}×${viewport.height}${state.viewport?.mode === "fixed" ? " (fixed)" : ""}`] : []),
    ...(state.appearance && state.appearance !== "system" ? [`appearance: ${state.appearance}`] : []),
    `history: ${state.canGoBack ? "can go back" : "no back"}, ${state.canGoForward ? "can go forward" : "no forward"}`,
  ];
  if (state.consoleErrors.length > 0) lines.push(`console errors and failed requests (${state.consoleErrors.length}):`, ...state.consoleErrors.slice(-10).map((error) => `  ${error}`));
  return lines.join("\n");
}

function action(result: unknown, verb: string): ToolAnswer {
  const outcome = result as PreviewActionResult | undefined;
  if (!outcome?.ok) return failure(`${verb} failed: ${outcome?.error ?? "the page did not answer"}`);
  return answer(`${verb}: ${outcome.detail ?? "done"}`);
}

const direction = (dx: number, dy: number): "up" | "down" | "left" | "right" =>
  Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "up" : "down") : (dx < 0 ? "left" : "right");

/**
 * The tools the agent of `threadId` sees, for Pi and over MCP alike. Every
 * one of them is sequential and bounded, and each call marks the thread as
 * the one driving the page.
 */
export function previewTools(controller: PreviewToolController, threadId: string): AnyTool[] {
  const sequential = { executionMode: "sequential" as const };
  const run = async (signal: AbortSignal | undefined, work: () => Promise<ToolAnswer>): Promise<ToolAnswer> => {
    controller.drive(threadId);
    try {
      return await bounded(signal, work);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  return [
    defineTool({
      name: "preview_open",
      label: "preview_open",
      description: "View the app or page you are developing in Tau's preview.",
      promptSnippet: "preview_open: view the app or page you are developing",
      parameters: Type.Object({ url: Type.String({ description: "http(s) URL, or an absolute path inside the workspace" }) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const state = await controller.open(params.url);
        const page = await controller.page();
        return answer(`Preview opened.\n${describeState(state, page.viewport())}`);
      }),
    }),
    defineTool({
      name: "preview_navigate",
      label: "preview_navigate",
      description: "Check another page, revisit navigation history or reload the preview after changes.",
      promptSnippet: "preview_navigate: check another page or reload after changes",
      parameters: Type.Object({
        url: Type.Optional(Type.String()),
        action: Type.Optional(Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")])),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => answer(describeState(await controller.navigate(params)))),
    }),
    defineTool({
      name: "preview_status",
      label: "preview_status",
      description: "Check the preview's location, viewport and loading state; diagnose console errors and failed requests.",
      promptSnippet: "preview_status: check page state and diagnose loading errors",
      parameters: Type.Object({}),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const page = await controller.page();
        return answer(describeState(page.state(), page.viewport()));
      }),
    }),
    defineTool({
      name: "preview_snapshot",
      label: "preview_snapshot",
      description: "Read page content and find interactive elements without an image. Element refs are replaced by each snapshot.",
      promptSnippet: "preview_snapshot: read page content and find interactive elements",
      parameters: Type.Object({ maxChars: Type.Optional(Type.Number({ description: "Cap on the tree, 8000 by default" })) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const maxChars = Math.min(Math.max(Math.round(params.maxChars ?? 8_000), 500), 40_000);
        const tree = await controller.evaluate(pageCall(previewSnapshot, maxChars));
        return answer(typeof tree === "string" ? tree : "The page returned no snapshot.");
      }),
    }),
    defineTool({
      name: "preview_screenshot",
      label: "preview_screenshot",
      description: "Inspect layout, styling and rendering bugs in a PNG of the visible preview.",
      promptSnippet: "preview_screenshot: inspect layout, styling and rendering bugs",
      parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean({ description: "Reserved; the visible viewport is captured" })) }),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const page = await controller.page();
        const shot = await page.capture(SCREENSHOT_MAX_WIDTH);
        return {
          content: [
            { type: "text" as const, text: `Preview screenshot of ${page.state().url || "(nothing loaded)"} at ${shot.width}×${shot.height}.` },
            { type: "image" as const, data: shot.base64, mimeType: "image/png" },
          ],
          details: undefined,
        };
      }),
    }),
    defineTool({
      name: "preview_click",
      label: "preview_click",
      description: "Test buttons, links and other click interactions in the preview.",
      promptSnippet: "preview_click: test buttons, links and click interactions",
      parameters: Type.Object({ ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const result = await controller.evaluate(pageCall(previewClick, previewFind, target(params, true))) as PreviewActionResult | undefined;
        controller.pointAt("click", result);
        return action(result, "click");
      }),
    }),
    defineTool({
      name: "preview_type",
      label: "preview_type",
      description: "Test forms and text inputs in the preview. Replaces existing text; can also submit the form.",
      promptSnippet: "preview_type: test forms and text inputs",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        text: Type.String(),
        submit: Type.Optional(Type.Boolean()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const result = await controller.evaluate(pageCall(previewType, previewFind, target(params, false), params.text, params.submit === true)) as PreviewActionResult | undefined;
        controller.pointAt("type", result, { text: params.text });
        return action(result, "type");
      }),
    }),
    defineTool({
      name: "preview_press",
      label: "preview_press",
      description: "Test keyboard interaction and focus navigation in the preview.",
      promptSnippet: "preview_press: test keyboard interaction and focus navigation",
      parameters: Type.Object({ key: Type.String() }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const key = params.key.trim();
        if (!key) throw new Error("preview_press needs a key.");
        const page = await controller.page();
        page.pressKey(key);
        controller.pointAt("key", { ok: true }, { key });
        return answer(`pressed ${key}`);
      }),
    }),
    defineTool({
      name: "preview_scroll",
      label: "preview_scroll",
      description: "Reach content outside the visible preview or test scrollable containers.",
      promptSnippet: "preview_scroll: reach off-screen content and test scrolling",
      parameters: Type.Object({
        ref: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        dx: Type.Optional(Type.Number()),
        dy: Type.Optional(Type.Number()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const scope = params.ref || params.selector ? target(params, false) : undefined;
        const dx = params.dx ?? 0;
        const dy = params.dy ?? 400;
        const result = await controller.evaluate(pageCall(previewScroll, previewFind, scope ?? null, dx, dy)) as PreviewActionResult | undefined;
        controller.pointAt("scroll", result, { direction: direction(dx, dy) });
        return action(result, "scroll");
      }),
    }),
    defineTool({
      name: "preview_evaluate",
      label: "preview_evaluate",
      description: "Inspect DOM details, computed styles or app state through JavaScript. Expressions can change the page.",
      promptSnippet: "preview_evaluate: inspect DOM details, computed styles and app state",
      parameters: Type.Object({ expression: Type.String() }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const expression = params.expression.trim();
        if (!expression) throw new Error("preview_evaluate needs an expression.");
        const value = await controller.evaluate(`(async () => { try { return JSON.stringify(await (${expression}) ?? null); } catch (error) { return JSON.stringify({ error: String(error) }); } })()`);
        const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return answer(json.length > EVALUATE_MAX_CHARS ? `${json.slice(0, EVALUATE_MAX_CHARS)}\n… truncated at ${EVALUATE_MAX_CHARS} characters` : json);
      }),
    }),
    defineTool({
      name: "preview_wait_for",
      label: "preview_wait_for",
      description: "Wait for expected content or navigation before continuing a preview test.",
      promptSnippet: "preview_wait_for: wait for expected content or navigation",
      parameters: Type.Object({
        text: Type.Optional(Type.String()),
        selector: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        if (!params.text && !params.selector && !params.urlIncludes) throw new Error("preview_wait_for needs text, a selector or urlIncludes.");
        const page = await controller.page();
        const deadline = Date.now() + Math.min(Math.max(Math.round(params.timeoutMs ?? 10_000), 100), TOOL_TIMEOUT_MS - 1_000);
        for (;;) {
          const urlMatches = !params.urlIncludes || page.state().url.includes(params.urlIncludes);
          const pageMatches = !params.text && !params.selector
            ? true
            : await page.evaluate(pageCall(previewCondition, params.text ?? null, params.selector ?? null)) === true;
          if (urlMatches && pageMatches) return answer(`condition met at ${page.state().url}`);
          if (Date.now() >= deadline) return failure(`preview_wait_for timed out at ${page.state().url}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }),
    }),
    defineTool({
      name: "preview_resize",
      label: "preview_resize",
      description: "Test responsive layouts at different viewport sizes. Does not change the browser user agent.",
      promptSnippet: "preview_resize: test responsive layouts at different sizes",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("fill"), Type.Literal("fixed"), Type.Literal("preset")], { description: "Fill the panel, set width and height, or use a device preset." }),
        width: Type.Optional(Type.Number({ description: "Width in CSS pixels, 200–4000; required for fixed mode." })),
        height: Type.Optional(Type.Number({ description: "Height in CSS pixels, 200–4000; required for fixed mode." })),
        preset: Type.Optional(Type.String({ description: `Required for preset mode. Options: ${VIEWPORT_PRESETS.map((preset) => preset.id).join(", ")}.` })),
        orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
      }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const viewport = readViewport(params);
        if (!viewport) throw new Error(params.mode === "preset" ? `Unknown preset "${params.preset ?? ""}".` : "A fixed viewport needs a width and a height between 200 and 4000.");
        const state = await controller.resize(viewport);
        const page = await controller.page();
        return answer(`Viewport: ${viewportLabel(viewport)}.\n${describeState(state, page.viewport())}`);
      }),
    }),
    defineTool({
      name: "preview_set_appearance",
      label: "preview_set_appearance",
      description: "Check the page's light, dark or system-following appearance.",
      promptSnippet: "preview_set_appearance: check light and dark appearance",
      parameters: Type.Object({ colorScheme: Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")]) }),
      ...sequential,
      execute: (_id, params, signal) => run(signal, async () => {
        const state = await controller.setAppearance(params.colorScheme);
        return answer(`Appearance: ${state.appearance}.`);
      }),
    }),
    defineTool({
      name: "preview_recording_start",
      label: "preview_recording_start",
      description: "Document a preview interaction flow as video. Recording stops automatically after 10 minutes.",
      promptSnippet: "preview_recording_start: document an interaction flow as video",
      parameters: Type.Object({}),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const state = await controller.recordStart();
        return answer(`Recording the preview of ${state.url} since ${new Date(state.recordingSince ?? Date.now()).toISOString()}.`);
      }),
    }),
    defineTool({
      name: "preview_recording_stop",
      label: "preview_recording_stop",
      description: "Finish documenting an interaction flow and obtain the saved WebM recording.",
      promptSnippet: "preview_recording_stop: finish the video and obtain its file",
      parameters: Type.Object({}),
      ...sequential,
      execute: (_id, _params, signal) => run(signal, async () => {
        const recording = await controller.recordStop();
        if (!recording) return failure("No recording was running.");
        return answer(`Recording saved: ${recording.path} (${Math.round(recording.durationMs / 1000)} s, ${Math.round(recording.size / 1024)} KB, ${recording.mimeType}).`);
      }),
    }),
  ];
}
