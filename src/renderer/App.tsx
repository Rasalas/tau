import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PanelRight, PanelRightClose } from "lucide-react";
import type {
  FileNode,
  HostEvent,
  HostSnapshot,
  ThreadIndexSnapshot,
  UiEditor,
  UiMessage,
  ToolApprovalRequest,
  UiToolRun,
  UiWorkspaceChanges,
  WorkspaceInfo,
} from "../shared/contracts";
import { ChangedFiles } from "./components/ChangedFiles";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import type { ContextBreakdown } from "./components/ContextMeter";
import { Menu } from "./components/Menu";
import { Message } from "./components/Message";
import { ReviewMode } from "./components/ReviewMode";
import { SettingsModal } from "./components/SettingsModal";
import { TitleBar } from "./components/TitleBar";
import { ToolApproval } from "./components/ToolApproval";
import { PanelIcon } from "./components/PanelIcon";
import { ToolGroup } from "./components/ToolGroup";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";
import { bundledExtensions } from "./extensions";
import { preferences, type AccessLevel } from "./preferences";
import { ThreadStore } from "./thread-store";
import {
  ThreadStoreContext,
  WorkbenchContext,
  WorkbenchShellContext,
  type TimelineEvent,
} from "./workbench-context";

const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

const mockSnapshot: HostSnapshot = {
  cwd: "/workspace/tau",
  branch: "main",
  sessionId: "prototype-preview",
  sessionName: "Split host snapshots & virtualize the thread list",
  sessionTitle: "Split host snapshots & virtualize the thread list",
  model: { provider: "anthropic", id: "preview", name: "sonnet-4.6" },
  models: [{ provider: "anthropic", id: "preview", name: "sonnet-4.6" }],
  thinkingLevel: "high",
  thinkingLevels: ["off", "low", "medium", "high"],
  messages: [
    { id: "welcome-user", role: "user", text: "Split the full host snapshots, stop calling SessionManager.listAll() on every switch, and virtualize the thread list for large sessions.", timestamp: Date.now() - 120000 },
    { id: "welcome-pi", role: "assistant", text: "Core keeps thread and session semantics; extensions only subscribe to individual thread shells. Press ⌘K to inspect the contribution registry.", timestamp: Date.now() - 110000 },
  ],
  isStreaming: false,
  activeTools: ["read", "bash", "edit", "write"],
  allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, description: `${name} tool` })),
  extensionCount: 2,
  contextUsage: { tokens: 68000, contextWindow: 200000, percent: 34 },
};

const mockThreadIndex: ThreadIndexSnapshot = {
  projects: [
    { path: "/workspace/tau", name: "tau", lastOpenedAt: Date.now() },
    { path: "/workspace/pi", name: "pi-coding-agent", lastOpenedAt: Date.now() - 7200000 },
    { path: "/workspace/lab", name: "agent-lab", lastOpenedAt: Date.now() - 86400000 },
  ],
  sessions: [
    { id: "prototype-preview", path: "preview", title: "Split host snapshots & virtualize the thread list", modifiedAt: Date.now(), projectPath: "/workspace/tau", projectName: "tau", branch: "main", messageCount: 12 },
    { id: "second", path: "second", title: "Renderer experiment", modifiedAt: Date.now() - 860000, projectPath: "/workspace/pi", projectName: "pi-coding-agent", branch: "feat/desktop-host", messageCount: 7 },
    { id: "third", path: "third", title: "Package both extension domains", modifiedAt: Date.now() - 7200000, projectPath: "/workspace/lab", projectName: "agent-lab", branch: "main", messageCount: 18 },
  ],
};

/** chars/4, the same heuristic the Pi SDK uses, so the dial's split is a real estimate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export default function App() {
  const safeMode = new URLSearchParams(window.location.search).get("safeMode") === "1";
  const [registry] = useState(() => {
    const value = new ExtensionRegistry();
    bundledExtensions.forEach((extension) => {
      value.addKnown(extension);
      if (!safeMode && preferences.isExtensionEnabled(extension.id)) value.activate(extension);
    });
    return value;
  });
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [threadStore] = useState(() => new ThreadStore());
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);

  const [snapshot, setSnapshot] = useState<HostSnapshot>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [tools, setTools] = useState<UiToolRun[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [changes, setChanges] = useState<UiWorkspaceChanges>(NO_CHANGES);
  const [editors, setEditors] = useState<UiEditor[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [approvals, setApprovals] = useState<ToolApprovalRequest[]>([]);
  const [workedMs, setWorkedMs] = useState<Record<string, number>>({});
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [activePanel, setActivePanel] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<string>();
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [review, setReview] = useState<{ path?: string }>();
  const [committing, setCommitting] = useState(false);
  const [composer, setComposer] = useState("");
  const [notice, setNotice] = useState<string>();
  const [dockOpen, setDockOpen] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const snapshotCacheRef = useRef(new Map<string, HostSnapshot>());
  const pendingDeltasRef = useRef(new Map<string, { text: string; thinking: string }>());
  const deltaFrameRef = useRef<number | undefined>(undefined);
  const reasoningRef = useRef(new Map<string, number>());
  const runningThreadRef = useRef<string>("");

  const flushAssistantDeltas = useCallback(() => {
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    const pending = pendingDeltasRef.current;
    if (pending.size === 0) return;
    pendingDeltasRef.current = new Map();
    setMessages((current) => current.map((message) => {
      const delta = pending.get(message.id);
      if (!delta) return message;
      return {
        ...message,
        text: message.text + delta.text,
        thinking: delta.thinking ? (message.thinking ?? "") + delta.thinking : message.thinking,
      };
    }));
  }, []);

  const queueAssistantDelta = useCallback((id: string, kind: "text" | "thinking", delta: string) => {
    const current = pendingDeltasRef.current.get(id) ?? { text: "", thinking: "" };
    current[kind] += delta;
    pendingDeltasRef.current.set(id, current);
    if (deltaFrameRef.current === undefined) {
      deltaFrameRef.current = requestAnimationFrame(flushAssistantDeltas);
    }
  }, [flushAssistantDeltas]);

  const applySnapshot = useCallback((next: HostSnapshot) => {
    pendingDeltasRef.current.clear();
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    snapshotCacheRef.current.set(next.sessionId, next);
    threadStore.applyHostSnapshot(next);
    setSnapshot(next);
    setMessages(next.messages);
    setTools([]);
  }, [threadStore]);

  const applyThreadIndex = useCallback((threadIndex: ThreadIndexSnapshot) => {
    threadStore.applyThreadIndex(threadIndex);
  }, [threadStore]);

  const addEvent = useCallback((label: string, detail?: string, timestamp = Date.now()) => {
    setEvents((current) => [...current.slice(-99), { id: `${timestamp}-${Math.random()}`, label, detail, timestamp }]);
  }, []);

  const refreshChanges = useCallback(async () => {
    if (!window.tau) return;
    try {
      setChanges(await window.tau.getChanges());
    } catch (error) {
      setNotice(String(error));
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!window.tau) return;
    try {
      setWorkspace(await window.tau.getWorkspaceInfo());
    } catch (error) {
      setNotice(String(error));
    }
  }, []);

  const handleHostEvent = useCallback((event: HostEvent) => {
    switch (event.type) {
      case "snapshot": applySnapshot(event.snapshot); break;
      case "thread-index": applyThreadIndex(event.threadIndex); break;
      case "agent-status": {
        threadStore.setStreaming(event.running);
        setSnapshot((current) => {
          if (event.running && current) runningThreadRef.current = current.sessionId;
          return current ? { ...current, isStreaming: event.running } : current;
        });
        setRunStartedAt(event.running ? Date.now() : undefined);
        if (!event.running) {
          // "Ready" is an unread badge: only raise it if the user was not watching this finish.
          const finished = runningThreadRef.current;
          const viewed = threadStore.getSnapshot().activeThreadId;
          if (finished && (finished !== viewed || document.hidden)) threadStore.markUnread(finished);
          runningThreadRef.current = "";
          void refreshChanges();
        }
        break;
      }
      case "assistant-start":
        reasoningRef.current.set(event.id, event.timestamp);
        setMessages((current) => current.some((message) => message.id === event.id)
          ? current
          : [...current, { id: event.id, role: "assistant", text: "", timestamp: event.timestamp }]);
        break;
      case "assistant-delta": {
        // The first visible token ends the reasoning stretch we report as "Worked for…".
        const startedAt = reasoningRef.current.get(event.id);
        if (startedAt !== undefined) {
          reasoningRef.current.delete(event.id);
          setWorkedMs((current) => ({ ...current, [event.id]: Date.now() - startedAt }));
        }
        queueAssistantDelta(event.id, "text", event.delta);
        break;
      }
      case "assistant-thinking":
        queueAssistantDelta(event.id, "thinking", event.delta);
        break;
      case "assistant-end":
        flushAssistantDeltas();
        reasoningRef.current.delete(event.message.id);
        setMessages((current) => current.map((message) => message.id === event.message.id ? event.message : message));
        break;
      case "tool-start":
        threadStore.toolStarted(event.tool.id, event.tool.name);
        setTools((current) => [...current.filter((tool) => tool.id !== event.tool.id), event.tool]);
        break;
      case "tool-update":
        setTools((current) => current.map((tool) => tool.id === event.id ? { ...tool, output: event.output } : tool));
        break;
      case "tool-end":
        threadStore.toolEnded(event.tool.id);
        setTools((current) => current.map((tool) => tool.id === event.tool.id ? event.tool : tool));
        if (event.tool.name === "edit" || event.tool.name === "write") void refreshChanges();
        break;
      case "event-log": addEvent(event.label, event.detail, event.timestamp); break;
      case "error": setNotice(event.message); break;
      case "tool-approval":
        setApprovals((current) => [...current, event.request]);
        break;
      case "queue":
        setQueue([...event.steering, ...event.followUp]);
        addEvent("queue.changed", `${event.steering.length} steering · ${event.followUp.length} follow-up`);
        break;
    }
  }, [addEvent, applySnapshot, applyThreadIndex, flushAssistantDeltas, queueAssistantDelta, refreshChanges, threadStore]);

  useEffect(() => {
    let unsubscribe = () => {};
    if (window.tau) {
      unsubscribe = window.tau.onHostEvent(handleHostEvent);
      window.tau.bootstrap().then((bootstrap) => {
        applyThreadIndex(bootstrap.threadIndex);
        applySnapshot(bootstrap.host);
        void refreshChanges();
        void refreshWorkspace();
      }).catch((error) => setNotice(String(error)));
      window.tau.listEditors().then(setEditors).catch(() => setEditors([]));
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, handleHostEvent, refreshChanges, refreshWorkspace]);

  useEffect(() => {
    void window.tau?.setAccessLevel(settings.accessLevel);
  }, [settings.accessLevel]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, tools]);

  useEffect(() => {
    if (runStartedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runStartedAt]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const panels = registry.getPanels();
  useEffect(() => {
    if (panels.length === 0) { setActivePanel(""); return; }
    if (!panels.some((panel) => panel.id === activePanel)) setActivePanel(panels[0].id);
  }, [activePanel, panels]);

  const refreshFiles = useCallback(async () => {
    if (window.tau) setFileTree((await window.tau.getFileTree()) ?? []);
    else setFileTree([
      { name: "src", path: "/workspace/tau/src", kind: "directory", children: [
        { name: "renderer", path: "/workspace/tau/src/renderer", kind: "directory", children: [
          { name: "thread-store.ts", path: "/workspace/tau/src/renderer/thread-store.ts", kind: "file" },
          { name: "App.tsx", path: "/workspace/tau/src/renderer/App.tsx", kind: "file" },
          { name: "extension-system.tsx", path: "/workspace/tau/src/renderer/extension-system.tsx", kind: "file" },
        ] },
      ] },
      { name: "README.md", path: "/workspace/tau/README.md", kind: "file" },
    ]);
  }, []);

  const createSession = useCallback(async () => {
    const next = await window.tau?.newSession();
    if (next) applySnapshot(next);
    else setNotice("New thread requires the Electron host");
  }, [applySnapshot]);

  const openPanel = useCallback((id: string) => { setActivePanel(id); setDockOpen(true); }, []);
  const openReview = useCallback((path?: string) => {
    void refreshChanges();
    setReview({ path });
  }, [refreshChanges]);

  const acceptWorkspace = useCallback((next: HostSnapshot) => {
    applySnapshot(next);
    if (next.cwd !== snapshot?.cwd) {
      setFileTree([]);
      setChanges(NO_CHANGES);
    }
    void refreshChanges();
    void refreshWorkspace();
  }, [applySnapshot, refreshChanges, refreshWorkspace, snapshot?.cwd]);

  const requireHost = useCallback((what: string): boolean => {
    if (window.tau) return true;
    setNotice(`${what} requires the Electron host`);
    return false;
  }, []);

  const chooseWorkspace = useCallback(async (): Promise<boolean> => {
    if (!requireHost("Project selection")) return false;
    try {
      const next = await window.tau!.chooseWorkspace();
      if (!next) return false;
      acceptWorkspace(next);
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost]);

  const openWorkspace = useCallback(async (path: string): Promise<boolean> => {
    if (path === snapshot?.cwd) return true;
    if (!requireHost("Project switching")) return false;
    try {
      acceptWorkspace(await window.tau!.openProject(path));
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost, snapshot?.cwd]);

  const cloneWorkspace = useCallback(async (repositoryUrl: string): Promise<boolean> => {
    if (!requireHost("Git clone")) return false;
    try {
      const next = await window.tau!.cloneProject(repositoryUrl);
      if (!next) return false;
      acceptWorkspace(next);
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    const startedAt = performance.now();
    const previous = snapshot;
    const target = threadStore.getSnapshot().threads.find((session) => session.path === path);
    const cached = target ? snapshotCacheRef.current.get(target.id) : undefined;
    if (cached) {
      applySnapshot({ ...cached, isStreaming: false });
      addEvent("thread.switch.cached", target?.title);
    }
    try {
      const next = await window.tau!.switchSession(path);
      acceptWorkspace(next);
      threadStore.markRead(next.sessionId);
      addEvent("thread.switch.confirmed", `${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } catch (error) {
      if (previous) applySnapshot(previous);
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, addEvent, applySnapshot, requireHost, snapshot, threadStore]);

  const generateThreadTitle = useCallback(async (provider: string, modelId: string, force = false): Promise<boolean> => {
    if (!requireHost("Title generation")) return false;
    try {
      applySnapshot(await window.tau!.generateThreadTitle(provider, modelId, force));
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [applySnapshot, requireHost]);

  const setModel = useCallback(async (provider: string, id: string) => {
    if (!requireHost("Model selection")) return;
    try {
      applySnapshot(await window.tau!.setModel(provider, id));
    } catch (error) {
      setNotice(String(error));
    }
  }, [applySnapshot, requireHost]);

  const setThinking = useCallback(async (level: string) => {
    if (!requireHost("Thinking level")) return;
    try {
      applySnapshot(await window.tau!.setThinkingLevel(level));
    } catch (error) {
      setNotice(String(error));
    }
  }, [applySnapshot, requireHost]);

  const compactContext = useCallback(async () => {
    if (!requireHost("Compaction")) return;
    try {
      applySnapshot(await window.tau!.compactContext());
      setNotice("Context compacted.");
    } catch (error) {
      setNotice(String(error));
    }
  }, [applySnapshot, requireHost]);

  const openInEditor = useCallback(async (path?: string) => {
    const editorId = settings.editorId ?? editors[0]?.id;
    if (!editorId) { setNotice("No supported editor found on PATH"); return; }
    if (!requireHost("Opening an editor")) return;
    try {
      await window.tau!.openInEditor(editorId, path);
    } catch (error) {
      setNotice(String(error));
    }
  }, [editors, requireHost, settings.editorId]);

  const commit = useCallback(async (message: string, push: boolean) => {
    if (!requireHost("Committing")) return;
    setCommitting(true);
    try {
      const result = await window.tau!.commit(message, push);
      setChanges(result.changes);
      setNotice(result.detail);
      addEvent("git.commit", result.detail);
      void refreshWorkspace();
      if (result.changes.files.length === 0) setReview(undefined);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setCommitting(false);
    }
  }, [addEvent, refreshWorkspace, requireHost]);

  const runWorkspaceAction = useCallback(async (action: () => Promise<HostSnapshot>) => {
    if (!requireHost("Worktrees")) return;
    setWorkspaceBusy(true);
    try {
      acceptWorkspace(await action());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }, [acceptWorkspace, requireHost]);

  const resolveApproval = useCallback((id: string, allowed: boolean) => {
    setApprovals((current) => current.filter((request) => request.id !== id));
    void window.tau?.resolveToolApproval(id, allowed);
  }, []);

  const settleActiveThread = useCallback(() => {
    const activeId = threadStore.getSnapshot().activeThreadId;
    if (!activeId) return;
    preferences.toggleSettled(activeId);
  }, [threadStore]);

  const actions: WorkbenchActions = useMemo(() => ({
    openPanel,
    openCommandPalette: () => setPaletteOpen(true),
    openSettings: (page) => setSettingsPage(page ?? "defaults"),
    openReview: () => openReview(),
    newSession: () => void createSession(),
    switchSession,
    settleActiveThread,
    abort: () => void window.tau?.abort(),
    focusComposer: (seed) => { if (seed) setComposer(seed); composerRef.current?.focus(); },
    notify: setNotice,
    chooseWorkspace,
    openWorkspace,
    cloneWorkspace,
    generateThreadTitle,
    regenerateTitle: async (force = true) => {
      const model = snapshot?.model;
      if (!model) { setNotice("No model is selected for this thread."); return false; }
      return generateThreadTitle(model.provider, model.id, force);
    },
  }), [
    chooseWorkspace, cloneWorkspace, createSession, generateThreadTitle, openPanel,
    openReview, openWorkspace, settleActiveThread, snapshot?.model, switchSession,
  ]);

  const submit = useCallback(async () => {
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    if (snapshot?.isStreaming) {
      if (window.tau) {
        try { await window.tau.steer(text); } catch (error) { setNotice(String(error)); }
      } else {
        setQueue((current) => [...current, text]);
      }
      return;
    }
    if (snapshot) threadStore.markRead(snapshot.sessionId);
    const optimistic: UiMessage = { id: `local-${Date.now()}`, role: "user", text, timestamp: Date.now() };
    setMessages((current) => [...current, optimistic]);
    if (window.tau) {
      try {
        await window.tau.sendPrompt(text);
        await registry.notifyPromptSubmitted({ prompt: text, snapshot }, actions);
      } catch (error) {
        setNotice(String(error));
      }
    } else {
      setSnapshot((current) => current ? { ...current, isStreaming: true } : current);
      setRunStartedAt(Date.now());
      window.setTimeout(() => {
        setMessages((current) => [...current, {
          id: `mock-${Date.now()}`,
          role: "assistant",
          text: "Preview mode received the prompt. Launch `npm start` to send it through the real Pi SDK.",
          timestamp: Date.now(),
        }]);
        setSnapshot((current) => current ? { ...current, isStreaming: false } : current);
        setRunStartedAt(undefined);
      }, 650);
    }
  }, [actions, composer, registry, snapshot, threadStore]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (meta && event.key.toLowerCase() === "n") { event.preventDefault(); void createSession(); }
      if (meta && event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); settleActiveThread(); }
      if (meta && event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); openReview(); }
      if (
        event.key === "Escape" &&
        snapshot?.isStreaming &&
        !paletteOpen &&
        !document.querySelector('[aria-modal="true"]')
      ) void window.tau?.abort();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const contextBreakdown: ContextBreakdown = useMemo(() => {
    const usage = snapshot?.contextUsage;
    if (!usage) return { messages: 0, toolOutput: 0, system: 0 };
    const messageTokens = messages.reduce(
      (total, message) => total + estimateTokens(message.text) + estimateTokens(message.thinking ?? ""),
      0,
    );
    const toolTokens = tools.reduce((total, tool) => total + estimateTokens(tool.output ?? ""), 0);
    const accounted = Math.min(usage.tokens, messageTokens + toolTokens);
    const scale = messageTokens + toolTokens > 0 ? accounted / (messageTokens + toolTokens) : 0;
    return {
      messages: Math.round(messageTokens * scale),
      toolOutput: Math.round(toolTokens * scale),
      system: Math.max(0, usage.tokens - accounted),
    };
  }, [messages, snapshot?.contextUsage, tools]);

  const contextValue = useMemo(
    () => ({ snapshot, tools, events, fileTree, changes, registry, refreshFiles, refreshChanges, openReview, applySnapshot, handleHostEvent }),
    [snapshot, tools, events, fileTree, changes, registry, refreshFiles, refreshChanges, openReview, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot, registry }), [snapshot, registry]);
  const sidebarContributions = registry.getSidebarContributions();
  const commands = registry.getCommands();
  const activeEditor = editors.find((editor) => editor.id === settings.editorId) ?? editors[0];
  const shellClassName = [
    "app-shell",
    sidebarContributions.length === 0 ? "no-sidebar" : "",
    panels.length === 0 ? "no-dock" : "",
    dockOpen ? "" : "dock-closed",
  ].filter(Boolean).join(" ");

  const overlays = (
    <>
      {approvals[0] ? (
        <ToolApproval
          request={approvals[0]}
          pending={approvals.length - 1}
          onResolve={resolveApproval}
        />
      ) : null}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        extensionCount={registry.getExtensionNames().length}
        actions={actions}
        onClose={() => setPaletteOpen(false)}
      />
      {settingsPage ? (
        <SettingsModal
          page={settingsPage}
          snapshot={snapshot}
          registry={registry}
          onSetPage={setSettingsPage}
          onSetModel={(provider, id) => void setModel(provider, id)}
          onSetThinking={(level) => void setThinking(level)}
          onClose={() => setSettingsPage(undefined)}
          onNotify={setNotice}
        />
      ) : null}
      {notice ? (
        <button className="toast" onClick={() => setNotice(undefined)}>
          <b>NOTICE</b><span>{notice}</span><i>×</i>
        </button>
      ) : null}
    </>
  );

  if (review) {
    return (
      <ThreadStoreContext.Provider value={threadStore}>
        <WorkbenchShellContext.Provider value={shellContextValue}>
          <WorkbenchContext.Provider value={contextValue}>
            <ReviewMode
              changes={changes}
              selectedPath={review.path ?? changes.files[0]?.path}
              editor={activeEditor}
              busy={committing}
              onSelect={(path) => setReview({ path })}
              onBack={() => setReview(undefined)}
              onCommit={(message, push) => void commit(message, push)}
              onOpenInEditor={(path) => void openInEditor(path)}
              loadDiff={async (path) => window.tau
                ? window.tau.getFileDiff(path)
                : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }}
            />
            {overlays}
          </WorkbenchContext.Provider>
        </WorkbenchShellContext.Provider>
      </ThreadStoreContext.Provider>
    );
  }

  return (
    <ThreadStoreContext.Provider value={threadStore}>
      <WorkbenchShellContext.Provider value={shellContextValue}>
        <WorkbenchContext.Provider value={contextValue}>
          <div className={shellClassName}>
            <TitleBar
              cwd={snapshot?.cwd}
              editors={editors}
              activeEditor={activeEditor}
              changedCount={changes.files.length}
              dockOpen={dockOpen}
              onOpenInEditor={() => void openInEditor()}
              onChooseEditor={(id) => preferences.setEditor(id)}
              onCommit={() => openReview()}
              onOpenPalette={() => setPaletteOpen(true)}
              onToggleDock={() => setDockOpen((value) => !value)}
            />

            {sidebarContributions.map((contribution) => (
              <contribution.Component key={contribution.id} actions={actions} />
            ))}

            <main className="conversation-column">
              <header className="conversation-header">
                <h1>{snapshot?.sessionTitle || "Untitled thread"}</h1>
                {snapshot?.branch ? <span className="branch-chip">{snapshot.branch}</span> : null}
                <span className="title-spacer" />
                <span className="menu-anchor">
                  <button className="chrome-ghost glyph" aria-label="Thread actions" onClick={() => setThreadMenuOpen(true)}>⋯</button>
                  {threadMenuOpen ? (
                    <Menu
                      align="right"
                      items={[
                        { id: "rename", label: "Rename this thread" },
                        { id: "settle", label: "Settle thread", hint: "⌘⇧S" },
                        { id: "review", label: "Review changes", hint: "⌘⇧D" },
                        { id: "editor", label: activeEditor ? `Open in ${activeEditor.name}` : "Open in editor" },
                      ]}
                      onSelect={(id) => {
                        if (id === "rename") void actions.regenerateTitle(true);
                        if (id === "settle") settleActiveThread();
                        if (id === "review") openReview();
                        if (id === "editor") void openInEditor();
                      }}
                      onClose={() => setThreadMenuOpen(false)}
                    />
                  ) : null}
                </span>
              </header>

              <div className="transcript" ref={transcriptRef}>
                <div className="transcript-inner">
                  {messages.map((message) => (
                    <Message key={message.id} message={message} workedMs={workedMs[message.id]} />
                  ))}
                  <ToolGroup tools={tools} registry={registry} />
                  <ChangedFiles changes={changes} onOpenDiff={openReview} />
                  {snapshot?.isStreaming ? (
                    <div className="live-status">
                      <span className="spinner" />
                      <span>Pi is working{runStartedAt ? ` · ${elapsedLabel(now - runStartedAt)}` : ""}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              <Composer
                snapshot={snapshot}
                value={composer}
                queue={queue}
                accessLevel={settings.accessLevel}
                contextUsage={snapshot?.contextUsage}
                contextBreakdown={contextBreakdown}
                textareaRef={composerRef}
                onChange={setComposer}
                onSubmit={() => void submit()}
                onAbort={() => void window.tau?.abort()}
                onCancelQueued={(index) => setQueue((current) => current.filter((_, at) => at !== index))}
                onSetModel={(provider, id) => void setModel(provider, id)}
                onSetThinking={(level) => void setThinking(level)}
                onSetAccess={(level: AccessLevel) => preferences.setAccessLevel(level)}
                onCompactContext={() => void compactContext()}
                workspace={workspace}
                workspaceBusy={workspaceBusy}
                onOpenWorktree={(path) => void openWorkspace(path)}
                onCreateWorktree={(branch) => void runWorkspaceAction(() => window.tau!.createWorktree(branch))}
                onSwitchRef={(ref) => void runWorkspaceAction(() => window.tau!.switchRef(ref))}
              />
            </main>

            {panels.length > 0 ? (
              <aside className="instrument-dock">
                {dockOpen ? (
                  <div className="panel-stage">
                    {panels.map((panel) => (
                      <div className={activePanel === panel.id ? "panel active" : "panel"} key={panel.id}>
                        <panel.Component active={activePanel === panel.id} extensionName={panel.extensionName} />
                      </div>
                    ))}
                  </div>
                ) : null}
                <nav className="panel-rail">
                  {panels.map((panel) => (
                    <button
                      key={panel.id}
                      title={panel.label}
                      aria-label={panel.label}
                      className={dockOpen && activePanel === panel.id ? "active" : ""}
                      onClick={() => openPanel(panel.id)}
                    >
                      <PanelIcon name={panel.glyph} />
                    </button>
                  ))}
                  <span className="spacer" />
                  <button
                    title={dockOpen ? "Collapse panel" : "Expand panel"}
                    aria-label={dockOpen ? "Collapse panel" : "Expand panel"}
                    onClick={() => setDockOpen((value) => !value)}
                  >
                    {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
                  </button>
                </nav>
              </aside>
            ) : null}
          </div>
          {overlays}
        </WorkbenchContext.Provider>
      </WorkbenchShellContext.Provider>
    </ThreadStoreContext.Provider>
  );
}
