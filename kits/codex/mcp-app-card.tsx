import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AppWindow } from "lucide-react";
import {
  FRAME_MAX_HEIGHT,
  SandboxFrame,
  errorMessage,
  useClientEnvironment,
  useColorScheme,
  type HostExtensionClient,
  type SandboxFrameHandle,
  type ToolCardProps,
  type UiToolRun,
  type WorkbenchActions,
} from "tau";
import { BridgeRefusal, makeMcpAppBridge, type DisplayMode, type McpAppBridge } from "./mcp-app-bridge.js";
import { fileBytes, hostContextOf, saveFile, styleVariables } from "./mcp-app-environment.js";
import {
  MCP_APP_COMMANDS,
  MCP_APP_EXTRA,
  type McpAppApproveInput,
  type McpAppCallToolInput,
  type McpAppModelContextInput,
  type McpAppOpen,
  type McpAppOpenInput,
  type McpAppReadResourceInput,
  type McpAppReleaseInput,
  type McpAppRef,
  type McpAppSendMessageInput,
  type McpAppTarget,
} from "./mcp-app-protocol.js";

/** Waits, in ms, between asks while the host is still reading the document. */
const RETRY_DELAYS = [500, 1000, 2000, 4000];
/** A call that is still waiting after this long probably has a prompt card above the composer. */
const PROMPT_GRACE_MS = 300;

const fullscreenSupported = () => typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

type Ready = Extract<McpAppOpen, { state: "ready" }>;
type View =
  | { kind: "opening" }
  | { kind: "ready"; open: Ready; src: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "closed" };

export interface McpAppCardOptions {
  retryDelays?: readonly number[];
  promptGraceMs?: number;
  teardownTimeoutMs?: number;
}

/** Whether a tool call of this card carries an app. */
export const hasMcpApp = (tool: UiToolRun): boolean => Boolean(tool.extras?.[MCP_APP_EXTRA]);

const refOf = (tool: UiToolRun): McpAppRef => tool.extras![MCP_APP_EXTRA] as McpAppRef;

/** The tool card: the call's summary line, and the app in a sandboxed frame once the host has it. */
export function createMcpAppCard(host: HostExtensionClient, options: McpAppCardOptions = {}): ComponentType<ToolCardProps> {
  return function McpAppCard({ tools, actions }: ToolCardProps) {
    return <>{tools.map((tool) => <McpAppItem key={tool.id} tool={tool} actions={actions} host={host} options={options} />)}</>;
  };
}

function Summary({ app, tool }: { app: McpAppRef; tool: UiToolRun }) {
  const running = tool.status === "running";
  return (
    <div className="mcp-app-line">
      {running ? <span className="spinner tone-current small" aria-hidden="true" /> : <AppWindow size={14} aria-hidden="true" />}
      <span className="mcp-app-server">{app.server}</span>
      <span className="mcp-app-tool">{app.tool}</span>
      {running ? <span className="mcp-app-status">Running</span> : tool.status === "error" ? <span className="mcp-app-status" data-tone="error">Failed</span> : null}
    </div>
  );
}

const Output = ({ tool }: { tool: UiToolRun }) => tool.output?.trim() ? <pre className="mcp-app-output">{tool.output}</pre> : null;

function McpAppItem({ tool, actions, host, options }: { tool: UiToolRun; actions: WorkbenchActions; host: HostExtensionClient; options: McpAppCardOptions }) {
  const ref = refOf(tool);
  const scheme = useColorScheme();
  const environment = useClientEnvironment();
  const [view, setView] = useState<View>({ kind: "opening" });
  const [generation, setGeneration] = useState(0);
  const [height, setHeight] = useState<number | undefined>();
  const [width, setWidth] = useState(0);
  const [fullscreen, setFullscreenState] = useState(false);
  const handle = useRef<SandboxFrameHandle>(null);
  const bridge = useRef<McpAppBridge | undefined>(undefined);
  // What the bridge's callbacks read; they outlive the render that made them.
  const live = useRef({ scheme, fullscreen, width, actions, toolDefinition: undefined as unknown, release: environment.release?.version, profile: environment.profile, prompting: 0 });
  const settled = tool.status === "done";

  useEffect(() => {
    live.current.actions = actions;
    live.current.scheme = scheme;
    live.current.fullscreen = fullscreen;
    live.current.width = width;
    live.current.profile = environment.profile;
    bridge.current?.updateHostContext();
  }, [actions, scheme, fullscreen, width, environment.profile]);

  const setFullscreen = useCallback((value: boolean) => {
    live.current.fullscreen = value;
    setFullscreenState(value);
  }, []);

  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    // The frame resource this effect minted, until it is given back.
    let minted: string | undefined;
    let mine: McpAppBridge | undefined;
    const threadId = live.current.actions.activeThread()?.sessionId;
    if (!threadId) {
      setView({ kind: "unavailable", reason: "Open the thread to see the app." });
      return;
    }
    const target: McpAppTarget = { threadId, itemId: tool.id };
    const send = <T,>(command: keyof typeof MCP_APP_COMMANDS, input: object = {}) => host.invoke(MCP_APP_COMMANDS[command], { ...target, ...input }) as Promise<T>;

    // A prompt card sits under the top layer, so full screen ends before one is raised.
    const leaveFullscreen = () => { if (live.current.fullscreen) flushSync(() => setFullscreen(false)); };
    const prompting = async <T,>(work: () => Promise<T>): Promise<T> => {
      live.current.prompting += 1;
      try { return await work(); } finally { live.current.prompting -= 1; }
    };

    const stop = () => {
      if (!mine) return;
      // Posted first; the frame may already be gone.
      void mine.teardown();
      mine.dispose();
      mine = undefined;
      bridge.current = undefined;
    };
    const release = () => {
      if (minted === undefined) return;
      const path = minted;
      minted = undefined;
      void send("release", { path } satisfies Omit<McpAppReleaseInput, keyof McpAppTarget>).catch(() => undefined);
    };

    const mount = (open: Ready) => {
      let src: string;
      minted = open.path;
      try {
        if (!host.resourceUrl) throw new Error("This client cannot show apps.");
        src = host.resourceUrl(open.path);
      } catch (error) {
        release();
        setView({ kind: "unavailable", reason: errorMessage(error) });
        return;
      }
      live.current.toolDefinition = open.toolDefinition;
      const created = makeMcpAppBridge({
        post: (message) => handle.current?.post(message),
        hostContext: () => hostContextOf({
          scheme: live.current.scheme,
          displayMode: live.current.fullscreen ? "fullscreen" : "inline",
          fullscreenAvailable: fullscreenSupported(),
          width: live.current.width,
          size: () => handle.current?.size() ?? { width: 0, height: 0 },
          maxHeight: FRAME_MAX_HEIGHT,
          profile: live.current.profile,
          ...(live.current.release ? { release: live.current.release } : {}),
          toolId: tool.id,
          toolDefinition: live.current.toolDefinition,
          styles: styleVariables,
        }),
        ...(live.current.release ? { version: live.current.release } : {}),
        ...(options.teardownTimeoutMs !== undefined ? { teardownTimeoutMs: options.teardownTimeoutMs } : {}),
        sandbox: { ...(open.csp ? { csp: open.csp } : {}), ...(open.permissions ? { permissions: open.permissions } : {}) },
        callTool: async (request) => {
          const grace = setTimeout(leaveFullscreen, options.promptGraceMs ?? PROMPT_GRACE_MS);
          try { return await prompting(() => send("callTool", request satisfies Omit<McpAppCallToolInput, keyof McpAppTarget>)); } finally { clearTimeout(grace); }
        },
        readResource: (uri) => send("readResource", { uri } satisfies Omit<McpAppReadResourceInput, keyof McpAppTarget>),
        sendMessage: async (text) => {
          leaveFullscreen();
          await prompting(() => send("sendMessage", { text } satisfies Omit<McpAppSendMessageInput, keyof McpAppTarget>));
        },
        updateModelContext: async (context) => { await send("modelContext", context satisfies Omit<McpAppModelContextInput, keyof McpAppTarget>); },
        openLink: (url) => {
          if (!handle.current?.hasUserActivation()) throw new BridgeRefusal("Links open only from a click in the app.");
          live.current.actions.openExternal(url);
        },
        downloadFile: async (files) => {
          leaveFullscreen();
          const answer = await prompting(() => send<unknown>("approve", { kind: "download", names: files.map((file) => file.name) } satisfies Omit<McpAppApproveInput, keyof McpAppTarget>));
          if (answer !== true && (typeof answer !== "object" || answer === null || (answer as { allowed?: unknown }).allowed !== true)) throw new BridgeRefusal("Declined by the user.");
          const saved = [];
          for (const file of files) saved.push(await fileBytes(file, (uri) => send("readResource", { uri } satisfies Omit<McpAppReadResourceInput, keyof McpAppTarget>)));
          for (const file of saved) saveFile(file);
        },
        requestDisplayMode: (mode: DisplayMode): DisplayMode => {
          if (mode === "inline") { setFullscreen(false); return "inline"; }
          if (mode !== "fullscreen" || live.current.prompting > 0 || !fullscreenSupported()) return live.current.fullscreen ? "fullscreen" : "inline";
          setFullscreen(true);
          return "fullscreen";
        },
        onSizeChanged: ({ height: next }) => { if (next !== undefined && !live.current.fullscreen) setHeight(Math.ceil(next)); },
        onRequestTeardown: () => {
          const closing = mine;
          if (!closing) return;
          void closing.teardown().finally(() => {
            if (mine !== closing || cancelled) return;
            setFullscreen(false);
            stop();
            release();
            setView({ kind: "closed" });
          });
        },
      });
      mine = created;
      bridge.current = created;
      created.setToolCall({ arguments: open.toolInput, ...(open.toolResult ? { result: open.toolResult } : {}) });
      setView({ kind: "ready", open, src });
    };

    const delays = options.retryDelays ?? RETRY_DELAYS;
    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        let answer: McpAppOpen;
        try {
          answer = await send<McpAppOpen>("open", { colorScheme: live.current.scheme } satisfies Omit<McpAppOpenInput, keyof McpAppTarget>);
        } catch (error) {
          if (!cancelled) setView({ kind: "unavailable", reason: errorMessage(error) });
          return;
        }
        if (cancelled) {
          if (answer.state === "ready") { minted = answer.path; release(); }
          return;
        }
        if (answer.state === "ready") { mount(answer); return; }
        if (answer.state === "unavailable") { setView({ kind: "unavailable", reason: answer.reason }); return; }
        if (attempt >= delays.length) { setView({ kind: "unavailable", reason: "The app is not ready yet." }); return; }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        if (cancelled) return;
      }
    })();

    return () => {
      cancelled = true;
      stop();
      release();
    };
  // The thread cannot change under a card; a new call is a new card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, generation, tool.id]);

  const reopen = () => {
    setHeight(undefined);
    setView({ kind: "opening" });
    setGeneration((value) => value + 1);
  };

  let body: ReactNode = null;
  if (tool.status !== "done") body = <Output tool={tool} />;
  else if (view.kind === "opening") body = <p className="mcp-app-reason" role="status">Opening the app…</p>;
  else if (view.kind === "unavailable") body = <><p className="mcp-app-reason">{view.reason}</p><Output tool={tool} /></>;
  else if (view.kind === "closed") {
    body = (
      <p className="mcp-app-reason mcp-app-closed">
        <span>The {ref.server} app was closed</span>
        <button type="button" className="mcp-app-show" onClick={reopen}>Show app</button>
      </p>
    );
  } else {
    body = (
      <SandboxFrame
        key={generation}
        src={view.src}
        title={`${ref.server} · ${ref.tool}`}
        permissions={view.open.permissions}
        height={height}
        bordered={view.open.prefersBorder}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
        onMessage={(data) => bridge.current?.receive(data)}
        onStopped={() => { bridge.current?.dispose(); }}
        onWidth={setWidth}
        label={ref.server}
        handleRef={handle}
      />
    );
  }

  return (
    <section className="mcp-app" data-state={view.kind}>
      <Summary app={ref} tool={tool} />
      {body}
    </section>
  );
}
