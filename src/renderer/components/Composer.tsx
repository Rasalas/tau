import { lazy, Suspense, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Brain, ChevronDown, Paperclip, Sparkles, Terminal, X } from "lucide-react";
import type {
  ExtensionUiPrompt,
  HostSnapshot,
  SubmissionResult,
  ThreadBackendKind,
  UiComposerCommand,
  UiContextUsage,
  UiModel,
  UiPromptAttachment,
  UiRuntimeBackend,
  UiSkillDraft,
  UiThreadUsage,
} from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { ContextMeter, type ContextBreakdown } from "./ContextMeter";
import { ThreadCost } from "./ThreadCost";
import { Menu } from "./Menu";
import { tooltipProps } from "./ui/Tooltip";
import { modelKey } from "./model-offerings";
import { ProviderIconStack } from "./ProviderIconStack";
import { usePreferences } from "../renderer-services-context";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
import { ExtensionPrompt, PromptSubmitContext, type PromptSubmitAction } from "./ExtensionPrompt";
import { LazyFeatureBoundary } from "./LazyFeature";
import { TaskProgress } from "./TaskProgress";
import { IMAGE_INPUT_UNAVAILABLE_MESSAGE } from "../../shared/thread-drop";
import { promptTakesFiles } from "../../shared/extension-prompt-options";
import {
  ComposerScopeStore,
  createDraftKey,
} from "../../workbench/composer-scope-store";
import { errorMessage } from "../../workbench/error-message";
import type { UiQueuedMessage } from "../../shared/contracts";
import { readComposerDraft, readComposerDraftState, writeComposerDraft, writeComposerDraftState } from "../../workbench/draft-store";
import { PromptHistory, loadStoredPromptHistory, saveStoredPromptHistory } from "../../workbench/prompt-history";
import { handleComposerReadlineKey } from "./useComposerReadline";
import { useComposerHistorySearch } from "./useComposerHistorySearch";
import { useComposerVim } from "./useComposerVim";
import {
  classifyComposerInput,
  useComposerSubmission,
  type ComposerDelivery,
} from "./useComposerSubmission";
import { useComposerAttachments, type ComposerAttachmentHandle } from "./useComposerAttachments";
import { useClientStorage } from "../client-storage-context";
import {
  type ComposerTrigger,
  type SelectedSkill,
  type ComposerArgMatch,
  skillName,
  composerTrigger,
  normalizeSkillInvocation,
  selectedSkillDraft,
  ComposerAutocompleteMenu,
} from "./ComposerAutocomplete";
import { ComposerInput } from "./ComposerInput";
import { useComposerChips } from "./useComposerChips";
import { useComposerCollapse } from "./useComposerCollapse";
import { findChipTokens, plainChipText, repairChipTokens, withoutChipTokens } from "./composer-chips";
import { ComposerFooterControls } from "./ComposerFooterControls";
import { composerEnter, sendHint } from "./composer-send-keys";
import { takePasteAsText } from "../paste-as-text";
import type { ComposerGateContext, ComposerGateContribution, ComposerInlineContext, ComposerTriggerItem, ModelSelectionContribution } from "../extension-system";

export {
  type ComposerTrigger,
  type SelectedSkill,
  composerTrigger,
  normalizeSkillInvocation,
  selectedSkillDraft,
};

type OpenMenu = "thinking" | undefined;

/** The runtime pick for a thread that does not exist yet. */
export interface ComposerRuntimeChoice {
  kind: ThreadBackendKind;
  backends: readonly UiRuntimeBackend[];
  onSelect(kind: ThreadBackendKind): void;
}

export interface ComposerControlHandle {
  openModelPicker(): void;
}

const noSubscribe = () => () => {};
const noVersion = () => 0;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const NO_INLINES: readonly never[] = [];
const NO_GATES: readonly ComposerGateContribution[] = [];
// The picker is its own chunk: nothing of it is drawn until it opens.
const ModelPicker = lazy(() => import("./ModelPicker").then((module) => ({ default: module.ModelPicker })));
const ComposerChipPopover = lazy(() => import("./ComposerChipPopover").then((module) => ({ default: module.ComposerChipPopover })));

/** A gate that asked: where the run stopped, and what finishes it. */
interface OpenGate {
  gate: ComposerGateContribution & { extensionId?: string; extensionName?: string };
  index: number;
  context: ComposerGateContext;
  proceed(): void;
  cancel?(): void;
}

/** Pi's out-of-the-box reasoning level; shown as the Default badge. */
const DEFAULT_THINKING = "medium";
const MAX_COMPOSER_HEIGHT = 220;
const COLLAPSED_COMPOSER_HEIGHT = 46;

/** Pi's level ids are identifiers; these are how they read in the menu. */
const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export type SubmitResult = SubmissionResult;

export type { ComposerAttachmentHandle } from "./useComposerAttachments";

export function Composer({
  snapshot,
  scopeStore,
  value,
  seed,
  draftStorageKey,
  queue,
  contextUsage,
  contextBreakdown,
  threadUsage,
  textareaRef,
  controlRef,
  attachmentRef,
  onChange,
  onSubmit,
  onAbort,
  onCancelQueued,
  onSteerQueued,
  onSetModel,
  onSetThinking,
  runtimeChoice,
  onNewThreadOnRuntime,
  prompt,
  promptsPending = 0,
  onAnswerPrompt,
  onCancelPrompt,
  onCompactContext,
  held = false,
  onNotify,
  onOpenPromptEditor,
  onRunShellAction,
  newThread = false,
}: {
  snapshot?: HostSnapshot;
  scopeStore: ComposerScopeStore;
  value?: string;
  seed?: string;
  draftStorageKey?: string;
  queue: readonly UiQueuedMessage[];
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
  /** What this thread has spent; absent when unknown or when costs are hidden. */
  threadUsage?: UiThreadUsage;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  controlRef?: RefObject<ComposerControlHandle | null>;
  attachmentRef?: RefObject<ComposerAttachmentHandle | null>;
  onChange?(value: string): void;
  onSubmit(text?: string, attachments?: UiPromptAttachment[], delivery?: ComposerDelivery, skillDraft?: UiSkillDraft): Promise<SubmitResult>;
  onAbort(): void;
  onCancelQueued(id: string): void;
  /** Sends one queued message now, ahead of the rest of the queue. */
  onSteerQueued(id: string): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  /** Offered while the composer targets a thread that does not exist yet. */
  runtimeChoice?: ComposerRuntimeChoice;
  /** Starts a new thread on another runtime, which an existing thread cannot change to; on `model` when one was chosen. */
  onNewThreadOnRuntime?(kind: ThreadBackendKind, model?: UiModel): void;
  prompt?: ExtensionUiPrompt;
  promptsPending?: number;
  /** `typed` is set when the answer came from the text field rather than a choice. */
  /** `attachments` are files the user sent with typed text, for a question that takes them. */
  onAnswerPrompt?(value: string | boolean, typed?: boolean, attachments?: UiPromptAttachment[]): void;
  onCancelPrompt?(): void;
  onCompactContext(): void;
  /** An extension is changing the workspace; submitting would target the wrong thread. */
  held?: boolean;
  onNotify?(message: string): void;
  /** Opens the current draft in an external editor via workspace extension. */
  onOpenPromptEditor?(): void;
  /** Direct shell execution for `! <command>` inputs. */
  onRunShellAction?(command: string, includeInContext?: boolean): Promise<unknown>;
  /** The composer is a draft whose thread does not exist yet. */
  newThread?: boolean;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  const clientStorage = useClientStorage();
  const attachmentScope = createDraftKey(draftStorageKey);
  const subscribeToScope = useCallback((listener: () => void) => scopeStore.subscribe(attachmentScope, listener), [attachmentScope, scopeStore]);
  const readScope = useCallback(() => scopeStore.getSnapshot(attachmentScope), [attachmentScope, scopeStore]);
  const activeScopeSnapshot = useSyncExternalStore(subscribeToScope, readScope, readScope);
  const attachments = activeScopeSnapshot.attachments;
  const attachmentError = activeScopeSnapshot.error;
  const [caret, setCaret] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  // Escape closes the menu for that token until a new one starts, not until the next keystroke.
  const [escapedToken, setEscapedToken] = useState<string>();
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkill>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chipInsertAt = useRef<number | undefined>(undefined);
  const [isExpanded, setIsExpanded] = useState(false);
  const text = value ?? activeScopeSnapshot.draft;
  // Extensions contribute slash commands and the rest of the toolbar; outside
  // the workbench shell (tests, previews) there are none.
  const registry = useContext(WorkbenchShellContext)?.registry;
  useSyncExternalStore(registry?.subscribe ?? noSubscribe, registry?.getVersion ?? noVersion, noVersion);
  const runtimeCommands = snapshot?.composerCommands;
  const desktopCommands = registry?.getSlashCommands();
  const commands = useMemo<UiComposerCommand[]>(() => {
    const merged = [...(runtimeCommands ?? [])];
    for (const command of desktopCommands ?? []) {
      // The runtime's spelling wins so the menu never lists a name twice.
      if (merged.some((entry) => entry.source !== "skill" && entry.name === command.name)) continue;
      merged.push({ name: command.name, description: command.description, argumentHint: command.argumentHint, source: "extension" });
    }
    return merged;
  }, [desktopCommands, runtimeCommands]);
  const inlines = registry?.getComposerInlines() ?? NO_INLINES;
  const extensionTriggers = useMemo(() => {
    const byChar = new Map<string, NonNullable<(typeof inlines)[number]["triggers"]>[number]>();
    for (const inline of inlines) for (const entry of inline.triggers ?? []) if (!byChar.has(entry.char)) byChar.set(entry.char, entry);
    return byChar;
  }, [inlines]);
  const extensionChars = useMemo(() => [...extensionTriggers.keys()], [extensionTriggers]);
  const parsedTrigger = commandMenuDismissed ? undefined : composerTrigger(text, caret, extensionChars);
  const trigger = parsedTrigger && `${parsedTrigger.kind}:${parsedTrigger.start}` === escapedToken ? undefined : parsedTrigger;
  const tokenEnded = parsedTrigger === undefined;
  useEffect(() => { if (tokenEnded) setEscapedToken(undefined); }, [tokenEnded]);
  const commandMatches = useMemo(() => {
    if (!trigger) return [];
    const query = trigger.query.toLowerCase();
    // Name matches outrank description matches so a typed prefix is never cut off by the cap.
    const rank = (command: UiComposerCommand) => {
      if (!query) return 0;
      const name = (command.source === "skill" ? skillName(command) : command.name).toLowerCase();
      if (name.startsWith(query)) return 0;
      if (name.includes(query) || command.name.toLowerCase().includes(query)) return 1;
      return command.description?.toLowerCase().includes(query) ? 2 : -1;
    };
    return commands
      .map((command, index) => ({ command, index, rank: trigger.kind === "$" && command.source !== "skill" ? -1 : rank(command) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, 10)
      .map((entry) => entry.command);
  }, [commands, trigger]);

  const shellContext = useContext(WorkbenchShellContext);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  useEffect(() => {
    if (trigger?.kind !== "@") return;
    const documentSource = shellContext?.registry.getDocumentSource();
    if (!documentSource) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (documentSource.listFiles) {
          const list = await documentSource.listFiles();
          if (!cancelled && list) setWorkspaceFiles(list);
        } else {
          const files = documentSource.getState().changes.files.map((f) => f.path);
          if (!cancelled) setWorkspaceFiles(files);
        }
      } catch {
        // ignore
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [shellContext, trigger?.kind]);

  const fileMatches = useMemo(() => {
    if (trigger?.kind !== "@") return [];
    const query = trigger.query.toLowerCase();
    return workspaceFiles
      .filter((path) => !query || path.toLowerCase().includes(query))
      .slice(0, 15);
  }, [trigger, workspaceFiles]);

  const argMatches = useMemo<ComposerArgMatch[]>(() => {
    if (trigger?.kind !== "arg") return [];
    const query = trigger.query.toLowerCase();
    if (trigger.command === "model") {
      const models = snapshot?.models ?? [];
      return models
        .filter((m) => !query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query))
        .slice(0, 10)
        .map((m) => ({
          id: `${m.provider}/${m.id}`,
          label: `${m.provider}/${m.id}`,
          description: m.name !== m.id ? m.name : undefined,
        }));
    }
    if (trigger.command === "thinking") {
      const levels = ["none", "low", "medium", "high", "max"];
      return levels
        .filter((l) => !query || l.startsWith(query))
        .map((l) => ({
          id: l,
          label: l,
          description: THINKING_LABELS[l] ?? l,
        }));
    }
    return [];
  }, [snapshot?.models, trigger]);

  useEffect(() => setCommandCursor(0), [trigger?.kind, trigger?.query]);
  const appliedSeed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (value !== undefined || draftStorageKey === undefined) return;
    if (activeScopeSnapshot.draft === "") {
      const persisted = readComposerDraft(clientStorage, draftStorageKey);
      if (persisted) scopeStore.setDraft(attachmentScope, persisted);
    }
  // The scope key is the lifecycle boundary; draft changes must not reload
  // persisted text after the user intentionally clears the field.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentScope, draftStorageKey, scopeStore, value]);
  useEffect(() => {
    if (seed !== undefined && value === undefined && seed !== appliedSeed.current) {
      appliedSeed.current = seed;
      scopeStore.setDraft(attachmentScope, seed);
    }
  }, [attachmentScope, scopeStore, seed, value]);
  const promptHistoryRef = useRef<PromptHistory>(null!);
  if (!promptHistoryRef.current) {
    promptHistoryRef.current = new PromptHistory({
      initialEntries: loadStoredPromptHistory(clientStorage),
    });
  }
  const recordPrompt = useCallback((promptText: string) => {
    if (!promptHistoryRef.current) return;
    promptHistoryRef.current.record(promptText);
    saveStoredPromptHistory(clientStorage, promptHistoryRef.current.getEntries());
  }, [clientStorage]);

  useEffect(() => {
    if (!snapshot?.messages) return;
    for (const message of snapshot.messages) {
      if (message.role === "user" && typeof message.text === "string" && message.text.trim()) {
        recordPrompt(message.text);
      }
    }
  }, [snapshot?.sessionId, snapshot?.messages, recordPrompt]);
  const updateDraft = useCallback((edited: string) => {
    // A Vim or Readline edit that cut into a chip takes the whole chip.
    const next = repairChipTokens(scopeStore.getSnapshot(attachmentScope).draft, edited)?.text ?? edited;
    scopeStore.setDraft(attachmentScope, next);
    writeComposerDraft(clientStorage, draftStorageKey, next);
    onChange?.(next);
    setSelectedSkill((current) => current && next.slice(current.start, current.end) === current.invocation ? current : undefined);
  }, [attachmentScope, clientStorage, draftStorageKey, onChange, scopeStore]);

  const selectCommand = (command: UiComposerCommand) => {
    if (!trigger) return;
    const name = command.source === "skill" ? skillName(command) : command.name;
    const invocation = `${trigger.kind}${name}`;
    const next = `${text.slice(0, trigger.start)}${invocation} ${text.slice(trigger.end)}`;
    const nextCaret = trigger.start + invocation.length + 1;
    updateDraft(next);
    if (command.source === "skill" && command.skillCommand) {
      setSelectedSkill({ name, invocation, command: command.skillCommand, start: trigger.start, end: trigger.start + invocation.length });
    } else {
      setSelectedSkill(undefined);
    }
    setCaret(nextCaret);
    setCommandMenuDismissed(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const selectFile = (filePath: string) => {
    if (!trigger) return;
    const invocation = `@${filePath}`;
    const next = `${text.slice(0, trigger.start)}${invocation} ${text.slice(trigger.end)}`;
    const nextCaret = trigger.start + invocation.length + 1;
    updateDraft(next);
    setCaret(nextCaret);
    setCommandMenuDismissed(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const selectExtension = (item: ComposerTriggerItem) => {
    if (trigger?.kind !== "extension" || !extensionTrigger) return;
    const next = `${text.slice(0, trigger.start)}${text.slice(trigger.end)}`;
    const nextCaret = trigger.start;
    chipInsertAt.current = nextCaret;
    updateDraft(next);
    setCaret(nextCaret);
    setCommandMenuDismissed(true);
    try { extensionTrigger.select(item, trigger.query, inlineContextRef.current); } catch (error) { onNotify?.(errorMessage(error)); }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const selectArg = (arg: ComposerArgMatch) => {
    if (!trigger || trigger.kind !== "arg") return;
    const next = `${text.slice(0, trigger.start)}${arg.id} ${text.slice(trigger.end)}`;
    const nextCaret = trigger.start + arg.id.length + 1;
    updateDraft(next);
    setCaret(nextCaret);
    setCommandMenuDismissed(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const runtimeCatalogs = useRuntimeCatalogs(modelPickerOpen);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const preferences = usePreferences();
  const gates = registry?.getComposerGates?.() ?? NO_GATES;
  const gatesRef = useRef(gates);
  gatesRef.current = gates;
  const [openGate, setOpenGate] = useState<OpenGate>();
  // Runs the gates from `from` on; the first that asks holds the action until it is answered.
  const passGates = useCallback((context: ComposerGateContext, proceed: () => void, cancel?: () => void, from = 0) => {
    const list = gatesRef.current;
    for (let index = from; index < list.length; index += 1) {
      const gate = list[index];
      let asks = false;
      try { asks = gate.check(context); } catch (error) { console.error(`Composer gate ${gate.id} failed`, error); }
      if (asks) { setOpenGate({ gate, index, context, proceed, ...(cancel ? { cancel } : {}) }); return; }
    }
    proceed();
  }, []);
  // A model added to a new thread's model set passes the same gates as a model chosen alone.
  const modelSet = newThread ? registry?.getModelSelection?.() : undefined;
  const gatedModelSet = useMemo<ModelSelectionContribution | undefined>(() => modelSet && {
    id: modelSet.id,
    selected: () => modelSet.selected(),
    subscribe: (listener) => modelSet.subscribe(listener),
    reset: () => modelSet.reset(),
    toggle: (model, current) => {
      if (modelSet.selected().includes(modelKey(model))) { modelSet.toggle(model, current); return; }
      passGates(
        { action: "model", model, ...(snapshot?.backendKind ? { runtime: snapshot.backendKind } : {}), ...(snapshot ? { snapshot } : {}) },
        () => modelSet.toggle(model, current),
      );
    },
  }, [modelSet, passGates, snapshot]);
  const [promptSubmit, setPromptSubmit] = useState<PromptSubmitAction>();
  const registerPromptSubmit = useCallback((action: PromptSubmitAction | undefined) => setPromptSubmit(action), []);
  // A model binds a draft to the runtime that offers it: the visible catalog's, or the one it came from.
  const applyModel = (model: UiModel, runtime = snapshot?.backendKind) => {
    if (runtimeChoice && runtime && runtimeChoice.kind !== runtime) runtimeChoice.onSelect(runtime);
    onSetModel(model.provider, model.id);
  };
  const chooseModel = (model: UiModel, from?: ThreadBackendKind) => {
    const runtime = from ?? snapshot?.backendKind;
    // A thread keeps its runtime; another runtime's model means a thread of its own.
    if (from && from !== snapshot?.backendKind && !runtimeChoice) {
      onNewThreadOnRuntime?.(from, model);
      return;
    }
    passGates(
      { action: "model", model, ...(runtime ? { runtime } : {}), ...(snapshot ? { snapshot } : {}) },
      () => {
        applyModel(model, runtime);
        // The popover hands focus back to its chip; with a model chosen, the prompt is next.
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
      () => setModelPickerOpen(true),
    );
  };
  // Kits' actions with another runtime than an existing thread's ("Continue in…").
  const switchCommands = modelPickerOpen && !runtimeChoice ? registry?.getCommandsFor?.("runtime-switch") : undefined;
  const runtimeActions = useMemo(() => (switchCommands ?? []).flatMap((command) => shellContext?.actions ? [{
    id: command.id,
    label: command.label.replace(/…$/u, ""),
    run: (runtime: string) => { void command.run(shellContext.actions!, { runtime }); },
  }] : []), [shellContext?.actions, switchCommands]);
  const supportsImageInput = snapshot?.supportsImageInput ?? false;
  const streaming = Boolean(snapshot?.isStreaming);
  // An external runtime may pick model and reasoning itself; the pickers then only show what it reports.
  const runtimeOwnsModel = snapshot?.runtimeCapabilities?.ownsModelSelection === true;
  // A draft bound for another runtime than the visible thread: that catalog is
  // not this thread's, and the thread it will become does not exist yet.
  const draftOnOtherRuntime = runtimeChoice !== undefined && snapshot?.backendKind !== undefined && runtimeChoice.kind !== snapshot.backendKind;
  const modelSelectionAvailable = !runtimeOwnsModel && !draftOnOtherRuntime && (snapshot?.models.length ?? 0) > 0;
  const modelPickerAvailable = modelSelectionAvailable || runtimeChoice !== undefined;
  const fileAttachments = !draftOnOtherRuntime && snapshot?.runtimeCapabilities?.fileAttachments === true;
  const inlineContext = useMemo<ComposerInlineContext>(() => ({
    scope: attachmentScope,
    ...(snapshot ? { snapshot } : {}),
    fileAttachments,
    imageInput: supportsImageInput,
  }), [attachmentScope, fileAttachments, snapshot, supportsImageInput]);
  // Handlers read the context at the moment they run, not the render they were made in.
  const inlineContextRef = useRef(inlineContext);
  inlineContextRef.current = inlineContext;
  const subscribeInlines = useCallback((listener: () => void) => {
    const unsubscribers = inlines.map((inline) => inline.subscribe?.(listener));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe?.(); };
  }, [inlines]);
  const readInlineContent = useCallback(
    // A chip is text: a contribution with chips has content when its tokens are in the draft.
    () => inlines.some((inline) => !inline.chips && inline.hasContent?.(attachmentScope) === true),
    [attachmentScope, inlines],
  );
  const inlineHasContent = useSyncExternalStore(subscribeInlines, readInlineContent, readInlineContent);
  const inlineTakesFiles = inlines.some((inline) => inline.takeFiles !== undefined);
  const takeFiles = useCallback((files: readonly File[]) => {
    let left = files;
    for (const inline of inlines) {
      if (!inline.takeFiles || left.length === 0) continue;
      try { left = inline.takeFiles(left, inlineContextRef.current); } catch (error) { onNotify?.(errorMessage(error)); }
    }
    return left;
  }, [inlines, onNotify]);
  const pasteText = (pasted: string): boolean => inlines.some((inline) => {
    try { return inline.pasteText?.(pasted, inlineContextRef.current) === true; } catch (error) { onNotify?.(errorMessage(error)); return false; }
  });
  const draftStates = useMemo(() => new Map(inlines.map((inline) => [inline.extensionId, {
    read: () => draftStorageKey === undefined ? undefined : readComposerDraftState(clientStorage, draftStorageKey, inline.extensionId),
    write: (state: unknown) => { if (draftStorageKey !== undefined) writeComposerDraftState(clientStorage, draftStorageKey, inline.extensionId, state); },
  }])), [clientStorage, draftStorageKey, inlines]);
  const extensionTrigger = trigger?.kind === "extension" && trigger.char ? extensionTriggers.get(trigger.char) : undefined;
  const [extensionMatches, setExtensionMatches] = useState<readonly ComposerTriggerItem[]>([]);
  const extensionQuery = extensionTrigger ? trigger?.query : undefined;
  useEffect(() => {
    if (!extensionTrigger || extensionQuery === undefined) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => extensionTrigger.search(extensionQuery, inlineContextRef.current))
      .then((items) => { if (!cancelled) setExtensionMatches(items.slice(0, 15)); }, () => { if (!cancelled) setExtensionMatches([]); });
    return () => { cancelled = true; };
  }, [extensionQuery, extensionTrigger]);
  useImperativeHandle(controlRef, () => ({
    openModelPicker: () => {
      if (modelPickerAvailable) setModelPickerOpen(true);
    },
  }), [controlRef, modelPickerAvailable]);

  useEffect(() => {
    const onEditorAction = (event: Event) => {
      const detail = (event as CustomEvent<{ type: "set" | "paste"; text: string }>).detail;
      if (!detail) return;
      if (detail.type === "set") {
        updateDraft(detail.text);
      } else if (detail.type === "paste") {
        updateDraft(text ? (text.endsWith("\n") ? text + detail.text : text + "\n" + detail.text) : detail.text);
      }
    };
    window.addEventListener("tau:composer-editor-action", onEditorAction);
    return () => window.removeEventListener("tau:composer-editor-action", onEditorAction);
  }, [text, updateDraft]);
  const thinkingSelectionAvailable = !runtimeOwnsModel && !draftOnOtherRuntime && (snapshot?.thinkingLevels.length ?? 0) > 1;
  const composerControls = registry?.getComposerControls() ?? [];
  const runtimeLabel = runtimeChoice?.backends.find((backend) => backend.kind === runtimeChoice.kind)?.label ?? runtimeChoice?.kind ?? "";
  const { preview, setPreviewId, clearPreviewForScope, addFiles } = useComposerAttachments({
    scopeStore,
    scope: attachmentScope,
    attachments,
    supportsImageInput,
    attachmentRef,
    ...(inlineTakesFiles ? { takeFiles } : {}),
  });

  const chips = useComposerChips({
    scope: attachmentScope,
    text,
    readText: useCallback(() => value ?? scopeStore.getSnapshot(attachmentScope).draft, [attachmentScope, scopeStore, value]),
    draftStorageKey,
    clientStorage,
    inlines,
    attachments,
    scopeStore,
    textareaRef,
    insertAt: chipInsertAt,
    paused: activeScopeSnapshot.submissionPending,
    updateDraft,
    setCaret,
  });
  const [openChip, setOpenChip] = useState<{ label: string; point: { x: number; y: number } }>();
  const chipTokens = useMemo(() => findChipTokens(text), [text]);
  const openChipPopover = (label: string, anchor?: HTMLElement | null) => {
    const drawn = anchor ?? [...document.querySelectorAll<HTMLElement>(".composer-mirror [data-chip]")].find((element) => element.dataset.chip === label);
    const rect = (drawn ?? textareaRef.current)?.getBoundingClientRect();
    setOpenChip({ label, point: { x: rect?.left ?? 0, y: rect?.top ?? 0 } });
  };

  const { submit: submitPrompt, answer: answerWithDraft } = useComposerSubmission({
    scopeStore,
    scope: attachmentScope,
    draftStorageKey,
    clientStorage,
    documentSource: shellContext?.registry.getDocumentSource?.(),
    selectedSkill,
    inlines,
    inlineContext,
    onSubmit,
    recordPrompt,
    clearPreviewForScope,
  });

  // An editor prompt arrives with text to edit; seed the field once.
  const seededPromptRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prompt || seededPromptRef.current === prompt.id) return;
    seededPromptRef.current = prompt.id;
    if (prompt.prefill) updateDraft(prompt.prefill);
  }, [prompt, updateDraft]);

  const answerable = prompt && prompt.answerElsewhere !== true;
  // A question that takes typed text takes the files waiting in the composer with it.
  const answerHasFiles = Boolean(answerable && prompt && promptTakesFiles(prompt) && (attachments.length > 0 || inlineHasContent));
  const submitRef = useRef<(delivery?: ComposerDelivery, gated?: boolean) => void>(() => {});
  const submitCurrent = useCallback((delivery?: ComposerDelivery, gated = false) => {
    if (held) return;
    // An answer's chips go along as its files; its text is the user's own words.
    const intent = classifyComposerInput({
      text: answerable ? withoutChipTokens(text) : plainChipText(text),
      answerable: Boolean(answerable),
      answerFiles: answerHasFiles,
      promptActionAvailable: Boolean(promptSubmit && !promptSubmit.disabled),
      shellActionAvailable: onRunShellAction !== undefined,
      delivery,
    });
    // An answer never waits for a prompt in flight: the prompt that asked may be the one still running.
    if (activeScopeSnapshot.submissionPending && intent.kind !== "prompt-answer" && intent.kind !== "prompt-action") return;
    switch (intent.kind) {
      case "noop":
        return;
      case "prompt-action":
        promptSubmit?.submit();
        return;
      case "prompt-answer":
        if (answerHasFiles) {
          answerWithDraft((answer, files) => onAnswerPrompt?.(answer, true, files));
          return;
        }
        onAnswerPrompt?.(intent.text, true);
        updateDraft("");
        return;
      case "shell":
        if (!onRunShellAction) return;
        updateDraft("");
        recordPrompt(intent.historyText);
        void onRunShellAction(intent.command, intent.includeInContext).catch((error) => {
          onNotify?.(errorMessage(error));
        });
        return;
      case "prompt": {
        if (gated) {
          chips.dropOrphans(text);
          submitPrompt(intent.delivery);
          return;
        }
        const runtime = runtimeChoice?.kind ?? snapshot?.backendKind;
        const model = draftOnOtherRuntime ? undefined : snapshot?.model;
        passGates(
          { action: "prompt", ...(model ? { model } : {}), ...(runtime ? { runtime } : {}), ...(snapshot ? { snapshot } : {}) },
          () => submitRef.current(delivery, true),
        );
        return;
      }
    }
  }, [
    activeScopeSnapshot.submissionPending,
    answerHasFiles,
    answerWithDraft,
    answerable,
    chips,
    held,
    onAnswerPrompt,
    onNotify,
    onRunShellAction,
    draftOnOtherRuntime,
    passGates,
    promptSubmit,
    recordPrompt,
    runtimeChoice?.kind,
    snapshot,
    submitPrompt,
    text,
    updateDraft,
  ]);
  submitRef.current = submitCurrent;
  const proceedGate = () => {
    if (!openGate) return;
    setOpenGate(undefined);
    passGates(openGate.context, openGate.proceed, openGate.cancel, openGate.index + 1);
  };
  const cancelGate = () => {
    if (!openGate) return;
    setOpenGate(undefined);
    openGate.cancel?.();
  };

  const handleDequeue = useCallback(() => {
    if (queue.length === 0) return;
    const head = queue[0];
    onCancelQueued(head.id);
    const restored = head.text ? (text ? (text.endsWith("\n") ? text + head.text : text + "\n" + head.text) : head.text) : text;
    updateDraft(restored);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(restored.length, restored.length);
    }, 0);
  }, [queue, onCancelQueued, updateDraft, text, textareaRef]);

  const prefSnapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const isVimEnabled = Boolean(prefSnapshot.vimMode);
  const sendShortcut = prefSnapshot.sendShortcut ?? "enter";
  const streamingBase = registry?.streamingDelivery() ?? "followUp";
  const inlineKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { key, shiftKey, altKey, metaKey, ctrlKey, currentTarget } = event;
    const keyEvent = { key, shiftKey, altKey, metaKey, ctrlKey, text, selectionStart: currentTarget.selectionStart, selectionEnd: currentTarget.selectionEnd };
    const setText = (next: string) => {
      updateDraft(next);
      setCaret(next.length);
      setCommandMenuDismissed(true);
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.length, next.length));
    };
    return inlines.some((inline) => {
      try { return inline.keyDown?.(keyEvent, { ...inlineContextRef.current, setText }) === true; } catch (error) { onNotify?.(errorMessage(error)); return false; }
    });
  };

  const historySearch = useComposerHistorySearch({
    promptHistory: promptHistoryRef.current,
    text,
    updateDraft,
    setCaret,
    textareaRef,
  });

  const zoneRef = useRef<HTMLElement>(null);
  const collapse = useComposerCollapse({
    enabled: prefSnapshot.composerCollapseOnScroll,
    idle: !text.includes("\n") && !prompt && !trigger && !historySearch.isSearching && !modelPickerOpen && !openChip && menu === undefined && !openGate,
    zoneRef,
  });

  const vim = useComposerVim({
    enabled: isVimEnabled,
    text,
    updateDraft,
    setCaret,
    textareaRef,
    onSubmit: () => submitCurrent(),
  });

  return (
    <footer ref={zoneRef} className={`composer-zone${collapse.collapsed ? " collapsed" : ""}`} data-keybinding-context="composer">
      <div className="composer-surface" data-composer-surface="true">
      {snapshot?.taskProgress ? <TaskProgress progress={snapshot.taskProgress} placement="dock" /> : null}
      {prompt ? (() => {
        // An extension that recognises the prompt draws it; core draws the four dialogs.
        const promptRenderer = registry?.getPromptRenderer(prompt);
        const Renderer = promptRenderer?.Component ?? ExtensionPrompt;
        return (
          <LazyFeatureBoundary
            label={prompt.id}
            extensionId={promptRenderer?.extensionId}
            extensionName={promptRenderer?.extensionName}
            registry={registry}
            onNotify={onNotify}
          >
            <PromptSubmitContext.Provider value={registerPromptSubmit}>
              <Renderer
                prompt={prompt}
                pending={promptsPending}
                onAnswer={(answer, typed) => { onAnswerPrompt?.(answer, typed); updateDraft(""); }}
                onCancel={() => { onCancelPrompt?.(); updateDraft(""); }}
              />
            </PromptSubmitContext.Provider>
          </LazyFeatureBoundary>
        );
      })() : null}
      <div
        className={`composer-frame ${prompt ? "stacked" : ""} ${answerable ? "answering" : ""}`}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
        onPaste={(event) => {
          // Paste as Text: the clipboard's text as it is, no fold and no file.
          if (takePasteAsText()) return;
          if (event.clipboardData.files.length === 0) {
            const pasted = event.clipboardData.getData("text/plain");
            if (pasted && pasteText(pasted)) event.preventDefault();
            return;
          }
          event.preventDefault();
          void addFiles(event.clipboardData.files);
        }}
      >
        {inlines.map((inline) => inline.Component ? (
          <LazyFeatureBoundary
            key={inline.id}
            label={inline.id}
            extensionId={inline.extensionId}
            extensionName={inline.extensionName}
            registry={registry}
            onNotify={onNotify}
          >
            <inline.Component {...inlineContext} draftState={draftStates.get(inline.extensionId)!} />
          </LazyFeatureBoundary>
        ) : null)}
        {attachmentError ? <div className="composer-attachment-error" role="alert">{attachmentError}</div> : null}
        {trigger ? (
          <ComposerAutocompleteMenu
            trigger={trigger}
            cursor={commandCursor}
            commandMatches={commandMatches}
            fileMatches={fileMatches}
            argMatches={argMatches}
            onSelectCommand={selectCommand}
            onSelectFile={selectFile}
            onSelectArg={selectArg}
            extensionMatches={extensionMatches}
            extensionLabel={extensionTrigger?.label}
            onSelectExtension={selectExtension}
            onHover={setCommandCursor}
          />
        ) : null}
        {historySearch.isSearching ? (
          <div className="composer-history-search" role="status" aria-live="polite">
            <span>(reverse-i-search)`<strong>{historySearch.searchQuery}</strong>`:</span>
            <b>{historySearch.matchedPrompt ?? <i>failing search</i>}</b>
            <small>↵ accept · esc cancel · ctrl+r cycle</small>
          </div>
        ) : null}
        <ComposerInput
          textareaRef={textareaRef}
          value={text}
          maxHeight={collapse.collapsed ? COLLAPSED_COMPOSER_HEIGHT : isExpanded ? 520 : MAX_COMPOSER_HEIGHT}
          skill={selectedSkill && text.slice(selectedSkill.start, selectedSkill.end) === selectedSkill.invocation ? selectedSkill : undefined}
          lookChip={chips.lookChip}
          onValueChange={(next, nextCaret) => {
            if (promptHistoryRef.current.isNavigating) {
              promptHistoryRef.current.resetCursor();
            }
            updateDraft(next);
            setCaret(nextCaret);
            setCommandMenuDismissed(false);
          }}
          onCaret={setCaret}
          onOpenChip={openChipPopover}
          onKeyDown={(event) => {
            if (historySearch.handleSearchKeyDown(event)) {
              return;
            }
            if (vim.handleVimKeyDown(event)) {
              return;
            }
            const totalMatches = trigger?.kind === "extension"
              ? extensionMatches.length
              : trigger?.kind === "@"
              ? fileMatches.length
              : trigger?.kind === "arg"
                ? argMatches.length
                : commandMatches.length;
            if (trigger && totalMatches > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCommandCursor((current) => (current + 1) % totalMatches);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCommandCursor((current) => (current - 1 + totalMatches) % totalMatches);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                if (trigger.kind === "extension") {
                  const item = extensionMatches[commandCursor];
                  if (item) selectExtension(item);
                } else if (trigger.kind === "@") {
                  const file = fileMatches[commandCursor];
                  if (file) selectFile(file);
                } else if (trigger.kind === "arg") {
                  const arg = argMatches[commandCursor];
                  if (arg) selectArg(arg);
                } else {
                  const command = commandMatches[commandCursor];
                  if (command) selectCommand(command);
                }
                return;
              }
            }
            if (trigger && event.key === "Escape") {
              event.preventDefault();
              setEscapedToken(`${trigger.kind}:${trigger.start}`);
              return;
            }
            if (!trigger && inlineKeyDown(event)) {
              event.preventDefault();
              return;
            }
            if (!trigger && event.key === "Escape" && !snapshot?.isStreaming) {
              textareaRef.current?.blur();
              (document.querySelector<HTMLElement>(".virtual-transcript") ?? document.querySelector<HTMLElement>(".transcript-viewport"))?.focus();
              return;
            }
            if (!trigger) {
              if (
                promptHistoryRef.current &&
                handleComposerReadlineKey(event, {
                  textareaRef,
                  text,
                  updateDraft,
                  setCaret,
                  promptHistory: promptHistoryRef.current,
                  onOpenPromptEditor,
                  onToggleExpanded: () => setIsExpanded((prev) => !prev),
                  onDequeue: handleDequeue,
                })
              ) {
                return;
              }
            }
            if (event.key === "Enter") {
              const now = event.metaKey || event.ctrlKey;
              // ⌘⇧↵ (`thread.steerQueuedMessage`) sends the oldest queued message and leaves the draft;
              // ⌘↵ on an empty field does the same.
              if (now && queue[0] && !answerable && (event.shiftKey || (!text.trim() && attachments.length === 0 && !inlineHasContent))) {
                event.preventDefault();
                onSteerQueued(queue[0].id);
                return;
              }
              const enter = composerEnter({ shift: event.shiftKey, mod: now, shortcut: sendShortcut, text, streaming, base: streamingBase });
              if (enter === "newline") return;
              event.preventDefault();
              submitCurrent(enter.delivery);
            }
          }}
          placeholder={
            answerable && prompt
              ? prompt.placeholder ?? "Answer yourself — ↵ sends it back to the extension"
              : isVimEnabled && vim.vimMode === "normal"
                ? "Vim NORMAL mode — press 'i' to insert, ↵ to send"
                : text.trimStart().startsWith("!")
                ? text.trimStart().startsWith("!!")
                  ? "Silent shell mode — runs command without LLM context"
                  : "Shell mode — runs command and shares output with agent"
                : sendHint(sendShortcut, streaming, streamingBase)
          }
        />
        {chipTokens.length > 0 ? (
          // For a screen reader and the keyboard's browse mode; the pointer clicks the chip itself.
          <div className="composer-chip-list" role="group" aria-label="Chips in the prompt">
            {chipTokens.map((token, index) => {
              const image = chips.chipFor(token.label)?.image;
              return image
                ? <button key={index} type="button" tabIndex={-1} aria-label={`Preview ${image.name}`} onClick={() => setPreviewId(image.id)} />
                : <button key={index} type="button" tabIndex={-1} aria-label={`Chip ${token.label}`} onClick={() => openChipPopover(token.label)} />;
            })}
          </div>
        ) : null}

        <div className="composer-toolbar">
          <ComposerFooterControls
            revision={text.trimStart().startsWith("!!") ? "silent-shell" : text.trimStart().startsWith("!") ? "shell" : ""}
            leading={<>
              {text.trimStart().startsWith("!") ? (
                <span className="runtime-chip shell-mode-chip" {...tooltipProps("Shell command mode")}>
                  <Terminal size={12} className="chip-icon" />
                  {text.trimStart().startsWith("!!") ? "Silent Shell" : "Shell"}
                </span>
              ) : null}
              <button
                ref={modelChipRef}
                className="runtime-chip composer-model-chip"
                aria-expanded={modelPickerOpen}
                aria-haspopup="dialog"
                disabled={!modelPickerAvailable}
                {...tooltipProps(modelSelectionAvailable
                  ? runtimeChoice ? "Select runtime and model" : "Select model"
                  : draftOnOtherRuntime ? `Change runtime or start with ${runtimeLabel}'s default model.`
                    : runtimeOwnsModel ? "This runtime selects its own model." : "No models are available for this runtime.", { shortcut: registry?.keybindingLabel?.("runtime.model") })}
                aria-label={modelSelectionAvailable
                  ? `${runtimeChoice ? "Select runtime and model" : "Select model"}: ${snapshot?.model?.name ?? "current model"}`
                  : runtimeChoice ? `Select runtime and model: ${runtimeLabel}` : "Model selection unavailable"}
                onClick={() => { if (modelPickerAvailable) setModelPickerOpen((open) => !open); }}
              >
                {snapshot?.model && !draftOnOtherRuntime
                  ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={runtimeChoice?.kind ?? snapshot.backendKind} className="chip-icon" />
                  : runtimeChoice
                    ? <ProviderIconStack runtimeProvider={runtimeChoice.kind} className="chip-icon" />
                    : <Sparkles size={13} className="accent" />}
                <span className="runtime-chip-label">{draftOnOtherRuntime
                  ? "default model"
                  : snapshot?.model?.name ?? (runtimeOwnsModel ? "runtime model" : "select model")}</span>
                {modelPickerAvailable ? <ChevronDown size={12} className="chev" /> : null}
              </button>
            </>}
            blocks={[
              { id: "reasoning", node: (
                <span className="menu-anchor composer-runtime-menu-anchor">
                  <button
                    className="runtime-chip"
                    data-composer-shortcut="composer.effort"
                    disabled={!thinkingSelectionAvailable}
                    {...tooltipProps(thinkingSelectionAvailable
                      ? "Reasoning"
                      : draftOnOtherRuntime ? `${runtimeLabel} sets reasoning once this thread exists.`
                        : runtimeOwnsModel ? "This runtime controls reasoning itself." : "Reasoning controls are unavailable.", { shortcut: thinkingSelectionAvailable ? registry?.keybindingLabel?.("runtime.cycle-thinking") : undefined })}
                    aria-label={thinkingSelectionAvailable ? "Reasoning" : "Reasoning controls unavailable"}
                    onClick={() => {
                      if (thinkingSelectionAvailable) setMenu(menu === "thinking" ? undefined : "thinking");
                    }}
                  >
                    <Brain size={13} />
                    {draftOnOtherRuntime ? "—" : snapshot?.thinkingLevel ?? "—"}
                    {thinkingSelectionAvailable ? <ChevronDown size={12} className="chev" /> : null}
                  </button>
                  {menu === "thinking" ? (
                    <Menu
                      placement="above"
                      sections={[
                        {
                          heading: "Reasoning",
                          items: (snapshot?.thinkingLevels ?? []).map((level) => ({
                            id: `thinking:${level}`,
                            label: THINKING_LABELS[level] ?? level,
                            badge: level === DEFAULT_THINKING ? "Default" : undefined,
                            selected: level === snapshot?.thinkingLevel,
                            disabled: !thinkingSelectionAvailable,
                            description: !thinkingSelectionAvailable && runtimeOwnsModel ? "This runtime controls reasoning itself." : undefined,
                          })),
                        },
                      ]}
                      onSelect={(id) => {
                        const [group, thinkingLevel] = id.split(":");
                        if (group === "thinking" && thinkingLevel) onSetThinking(thinkingLevel);
                      }}
                      onClose={() => setMenu(undefined)}
                    />
                  ) : null}
                </span>
              ) },
              ...composerControls.filter((control) => control.placement !== "footer").map((control) => ({ id: control.id, node: (
                <LazyFeatureBoundary
                  label={control.id}
                  extensionId={control.extensionId}
                  extensionName={control.extensionName}
                  registry={registry}
                  onNotify={onNotify}
                >
                  <control.Component snapshot={snapshot} actions={shellContext?.actions} />
                </LazyFeatureBoundary>
              ) })),
            ]}
          />

          {isVimEnabled ? (
            <span className={`vim-badge ${vim.vimMode}`}>
              {vim.vimMode === "normal" ? "NORMAL" : "INSERT"}
            </span>
          ) : null}

          {threadUsage ? <ThreadCost usage={threadUsage} /> : null}

          {contextUsage ? (
            <ContextMeter usage={contextUsage} breakdown={contextBreakdown} onCompact={onCompactContext} />
          ) : null}

          <button className="attach-button" type="button" {...tooltipProps(supportsImageInput || inlineTakesFiles ? "Attach files" : IMAGE_INPUT_UNAVAILABLE_MESSAGE)} aria-label="Attach files" disabled={!supportsImageInput && !inlineTakesFiles} onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={17} />
          </button>
          <input
            ref={fileInputRef}
            className="attachment-input"
            aria-label="Choose attachment files"
            type="file"
            tabIndex={-1}
            disabled={!supportsImageInput && !inlineTakesFiles}
            accept={inlineTakesFiles ? undefined : IMAGE_ACCEPT}
            multiple
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {answerable && prompt ? (() => {
            const typedAnswer = Boolean(withoutChipTokens(text).trim()) || (answerHasFiles && !(promptSubmit && !promptSubmit.disabled));
            const submitLabel = typedAnswer ? "Send answer" : promptSubmit?.label ?? "Send answer";
            return (
              <button
                className="prompt-submit-button"
                {...tooltipProps(submitLabel)}
                aria-label={submitLabel}
                disabled={held || (!typedAnswer && (promptSubmit?.disabled ?? true))}
                onClick={() => {
                  if (typedAnswer) submitCurrent();
                  else promptSubmit?.submit();
                }}
              >
                {submitLabel}
                <ArrowUp size={15} />
              </button>
            );
          })() : null}
          {streaming ? (
            <button className="send-button stop" {...tooltipProps("Stop the run", { shortcut: registry?.keybindingLabel?.("runtime.abort") })} aria-label="Stop the run" onClick={onAbort}><i /></button>
          ) : !answerable ? (
            <button
              className="send-button"
              {...tooltipProps("Send")}
              aria-label="Send"
              aria-busy={activeScopeSnapshot.submissionPending}
              disabled={held || activeScopeSnapshot.submissionPending || (text.trim().length === 0 && attachments.length === 0 && !inlineHasContent)}
              onClick={() => submitCurrent()}
            >
              <ArrowUp size={16} />
            </button>
          ) : null}
        </div>
      </div>

      {openChip ? (
        <Suspense fallback={null}>
        <ComposerChipPopover
          label={openChip.label}
          point={openChip.point}
          entry={chips.chipFor(openChip.label)}
          scope={attachmentScope}
          registry={registry}
          onNotify={onNotify}
          onPreview={(id) => setPreviewId(id)}
          onRemove={() => chips.removeChip(openChip.label)}
          onClose={() => setOpenChip(undefined)}
        />
        </Suspense>
      ) : null}
      {preview ? createPortal(
        <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onMouseDown={() => setPreviewId(undefined)}>
          <figure onMouseDown={(event) => event.stopPropagation()}>
            <button aria-label="Close preview" onClick={() => setPreviewId(undefined)}><X size={18} /></button>
            <img src={preview.previewUrl} alt={preview.name} />
            <figcaption>{preview.name}</figcaption>
          </figure>
        </div>,
        document.body,
      ) : null}

      {modelPickerOpen ? (
        <Suspense fallback={null}>
          <ModelPicker
            models={runtimeOwnsModel ? [] : snapshot?.models ?? []}
            activeKey={snapshot?.model && !draftOnOtherRuntime ? modelKey(snapshot.model) : undefined}
            onSelect={chooseModel}
            onClose={() => setModelPickerOpen(false)}
            runtime={runtimeChoice?.kind ?? snapshot?.backendKind}
            catalogRuntime={snapshot?.backendKind}
            runtimeBackends={runtimeChoice?.backends ?? snapshot?.runtimeBackends}
            catalogs={runtimeCatalogs}
            onSelectRuntime={runtimeChoice?.onSelect}
            onNewThreadOnRuntime={onNewThreadOnRuntime}
            runtimeActions={runtimeActions}
            badges={registry?.getModelBadges?.()}
            multiSelect={gatedModelSet}
            anchor={modelChipRef}
          />
        </Suspense>
      ) : null}
      {openGate ? (
        <div className="palette-backdrop composer-gate" onMouseDown={cancelGate} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelGate(); } }}>
          <div className="composer-gate-frame" onMouseDown={(event) => event.stopPropagation()}>
            <LazyFeatureBoundary
              label={openGate.gate.id}
              extensionId={openGate.gate.extensionId}
              extensionName={openGate.gate.extensionName}
              registry={registry}
              onNotify={onNotify}
              onError={cancelGate}
            >
              <openGate.gate.Component context={openGate.context} proceed={proceedGate} cancel={cancelGate} />
            </LazyFeatureBoundary>
          </div>
        </div>
      ) : null}

      {composerControls.filter((control) => control.placement === "footer").map((control) => (
        <LazyFeatureBoundary
          key={control.id}
          label={control.id}
          extensionId={control.extensionId}
          extensionName={control.extensionName}
          registry={registry}
          onNotify={onNotify}
        >
          <control.Component snapshot={snapshot} actions={shellContext?.actions} />
        </LazyFeatureBoundary>
      ))}
      </div>
    </footer>
  );
}
