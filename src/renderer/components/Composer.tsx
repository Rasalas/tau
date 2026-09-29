import { lazy, Suspense, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, ChevronDown, Lock, Paperclip, Shrink, Sparkles, Terminal, X } from "lucide-react";
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
} from "../../shared/contracts";
import { WorkbenchShellContext } from "../workbench-context";
import { ContextMeter, type ContextBreakdown } from "./ContextMeter";
import { ComposerMenuItem, ExtensionPrompt } from "../deferred-surfaces";
import { tooltipProps } from "./ui/Tooltip";
import { modelKey } from "./model-offerings";
import { ProviderIconStack } from "./ProviderIconStack";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { usePreferences } from "../renderer-services-context";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
import { PromptSubmitContext, type PromptSubmitAction } from "./prompt-submit";
import { usePromptArrival } from "./use-prompt-arrival";
import { LazyFeatureBoundary } from "./LazyFeature";
import { useHostCapabilities } from "../use-host-capabilities";
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
import type { ChipLayerApi } from "./ComposerChipLayer";
import { plainChipText } from "./composer-chip-token";
import { ComposerFooterControls, type FooterBlock } from "./ComposerFooterControls";
import { composerEnter, sendHint, sendShortcutFor } from "./composer-send-keys";
import { onScreenKeyboardShown, primaryPointerIsTouch } from "../touch-input";
import { takePasteAsText } from "../paste-as-text";
import { THINKING_LABELS } from "../thinking-levels";
import type { ThinkingChoice } from "./ModelPicker";
import type { ComposerGateContext, ComposerGateContribution, ComposerInlineContext, ComposerTriggerItem, ModelSelectionContribution } from "../extension-system";

export {
  type ComposerTrigger,
  type SelectedSkill,
  composerTrigger,
  normalizeSkillInvocation,
  selectedSkillDraft,
};

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
// Chips in the text load after the textarea is up, so the first key never waits for them.
const ComposerChipLayer = lazy(() => import("./ComposerChipLayer"));

/** A gate that asked: where the run stopped, and what finishes it. */
interface OpenGate {
  gate: ComposerGateContribution & { extensionId?: string; extensionName?: string };
  index: number;
  context: ComposerGateContext;
  proceed(): void;
  cancel?(): void;
}

const MAX_COMPOSER_HEIGHT = 220;
/** From this share of the context on, the dial leaves the menu for the row: compacting is worth a look then. */
const CONTEXT_DIAL_PERCENT = 75;

/** How a level reads in the footer, where it stands without the menu's heading. */
function thinkingLabel(level: string): string {
  return level === "off" ? "Reasoning off" : THINKING_LABELS[level] ?? level;
}

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
  lead,
}: {
  snapshot?: HostSnapshot;
  scopeStore: ComposerScopeStore;
  value?: string;
  seed?: string;
  draftStorageKey?: string;
  queue: readonly UiQueuedMessage[];
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
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
  /** Core's chips before the model, after the kits' `lead` controls (a draft's project). */
  lead?: ReactNode;
}) {
  const { readOnly } = useHostCapabilities();
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
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const contentHeight = textarea.scrollHeight;
    if (contentHeight <= 0) {
      textarea.style.height = "";
      return;
    }
    const currentMaxHeight = isExpanded ? 520 : MAX_COMPOSER_HEIGHT;
    textarea.style.height = `${Math.min(contentHeight, currentMaxHeight)}px`;
    textarea.style.overflowY = contentHeight > currentMaxHeight ? "auto" : "hidden";
  }, [isExpanded, text, textareaRef]);
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
  const chipLayer = useRef<ChipLayerApi | undefined>(undefined);
  const updateDraft = useCallback((edited: string) => {
    // An edit that cut into a chip (a Backspace, Vim's `x`, Readline's ctrl+w) takes the whole chip.
    const next = chipLayer.current?.repair(scopeStore.getSnapshot(attachmentScope).draft, edited)?.text ?? edited;
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
  // "thinking": opened from the reasoning level, with the focus on the picker's thinking column.
  const [modelPickerOpen, setModelPickerOpen] = useState<boolean | "thinking">(false);
  const runtimeCatalogs = useRuntimeCatalogs(modelPickerOpen !== false);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const modelChosenRef = useRef(false);
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
        { action: "model", model, ...(snapshot?.backendKind ? { runtime: snapshot.backendKind } : {}), ...(newThread ? { newThread: true } : {}), ...(snapshot ? { snapshot } : {}) },
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
    let passed = false;
    passGates(
      { action: "model", model, ...(runtime ? { runtime } : {}), ...(newThread ? { newThread: true } : {}), ...(snapshot ? { snapshot } : {}) },
      () => {
        passed = true;
        applyModel(model, runtime);
        // The popover hands focus back to its chip; with a model chosen, the prompt is next once it closes.
        modelChosenRef.current = true;
      },
      () => setModelPickerOpen(true),
    );
    // A gate that asks takes the picker's place.
    if (!passed) setModelPickerOpen(false);
  };
  const closeModelPicker = () => {
    setModelPickerOpen(false);
    if (!modelChosenRef.current) return;
    modelChosenRef.current = false;
    requestAnimationFrame(() => textareaRef.current?.focus());
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
  // The picker's third column: the reasoning of the model in use, where this thread can set it.
  const pickerThinking: ThinkingChoice = runtimeOwnsModel || draftOnOtherRuntime ? { levels: [] } : {
    levels: snapshot?.thinkingLevels ?? [],
    level: snapshot?.thinkingLevel,
    onSelect: (level) => { onSetThinking(level); modelChosenRef.current = true; },
  };
  const { preview, setPreviewId, clearPreviewForScope, addFiles } = useComposerAttachments({
    scopeStore,
    scope: attachmentScope,
    attachments,
    supportsImageInput,
    attachmentRef,
    ...(inlineTakesFiles ? { takeFiles } : {}),
  });

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

  // A question takes the field only once the typing stops; the draft waits aside until it is answered.
  const arrival = usePromptArrival({ prompt, scope: attachmentScope, scopeStore, setDraft: updateDraft });
  const answerable = prompt && arrival.armed;
  // A question that takes typed text takes the files waiting in the composer with it.
  const answerHasFiles = Boolean(answerable && prompt && promptTakesFiles(prompt) && (attachments.length > 0 || inlineHasContent));
  const submitRef = useRef<(delivery?: ComposerDelivery, gated?: boolean) => void>(() => {});
  const submitCurrent = useCallback((delivery?: ComposerDelivery, gated = false) => {
    if (held || arrival.waiting) return;
    // An answer's chips go along as its files; its text is the user's own words.
    const intent = classifyComposerInput({
      text: plainChipText(text, Boolean(answerable)),
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
          chipLayer.current?.dropOrphans(text);
          submitPrompt(intent.delivery);
          return;
        }
        const runtime = runtimeChoice?.kind ?? snapshot?.backendKind;
        const model = draftOnOtherRuntime ? undefined : snapshot?.model;
        passGates(
          { action: "prompt", ...(model ? { model } : {}), ...(runtime ? { runtime } : {}), ...(newThread ? { newThread: true } : {}), ...(snapshot ? { snapshot } : {}) },
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
    arrival.waiting,
    held,
    onAnswerPrompt,
    onNotify,
    onRunShellAction,
    draftOnOtherRuntime,
    newThread,
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
  // A touch screen's send button names no chord; which keyboard types decides what Enter does, when it is pressed.
  const [touchKeyboard] = useState(primaryPointerIsTouch);
  const streamingBase = registry?.streamingDelivery() ?? "followUp";
  const hasDraft = text.trim().length > 0 || attachments.length > 0 || inlineHasContent;
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

  const vim = useComposerVim({
    enabled: isVimEnabled,
    text,
    updateDraft,
    setCaret,
    textareaRef,
    onSubmit: () => submitCurrent(),
  });

  const attachAvailable = supportsImageInput || inlineTakesFiles;
  // A model without reasoning levels shows none; a runtime that picks its own still says which.
  const thinkingLevel = thinkingSelectionAvailable || (runtimeOwnsModel && !draftOnOtherRuntime) ? snapshot?.thinkingLevel : undefined;
  const menuControls = composerControls.filter((control) => control.placement === "menu");
  const leadControls = composerControls.filter((control) => control.placement === "lead");
  const menuShortcuts = menuControls.flatMap((control) => control.shortcuts ?? []);
  // The row is the design's: model, reasoning, the "…" menu, send. Kits' chips fold into the menu first;
  // attach lives there (and in drag and paste), the context dial too until the context runs short.
  const contextPercent = contextUsage ? Math.round(Math.min(100, Math.max(0, contextUsage.percent))) : 0;
  const footerBlocks: FooterBlock[] = [
    ...(thinkingLevel ? [{ id: "reasoning", rank: 3, node: (
      <button
        className="runtime-chip composer-thinking-chip"
        data-composer-shortcut="composer.effort"
        disabled={!thinkingSelectionAvailable}
        {...tooltipProps(thinkingSelectionAvailable
          ? "Reasoning"
          : runtimeOwnsModel ? "This runtime controls reasoning itself." : "Reasoning controls are unavailable.", { shortcut: thinkingSelectionAvailable ? registry?.keybindingLabel?.("runtime.cycle-thinking") : undefined })}
        aria-label={thinkingSelectionAvailable ? `Reasoning: ${thinkingLabel(thinkingLevel)}` : "Reasoning controls unavailable"}
        aria-expanded={modelPickerOpen === "thinking"}
        aria-haspopup="dialog"
        onClick={() => { if (thinkingSelectionAvailable) setModelPickerOpen((open) => open === "thinking" ? false : "thinking"); }}
      >
        {thinkingLabel(thinkingLevel)}
      </button>
    ) }] : []),
    ...composerControls.filter((control) => control.placement === undefined || control.placement === "toolbar").map((control) => ({ id: control.id, node: (
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
    ...(contextUsage ? [{
      id: "context",
      end: true,
      rank: 2,
      menuOnly: contextPercent < CONTEXT_DIAL_PERCENT,
      node: <ContextMeter usage={contextUsage} breakdown={contextBreakdown} onCompact={onCompactContext} />,
      menuNode: <ComposerMenuItem
        icon={<Shrink size={13} />}
        label="Compact context"
        detail={`${contextPercent}% of the context used`}
        onSelect={onCompactContext}
      />,
    }] : []),
    {
      id: "attach",
      menuOnly: true,
      node: <ComposerMenuItem
        icon={<Paperclip size={13} />}
        label="Attach files"
        disabled={!attachAvailable}
        disabledReason={IMAGE_INPUT_UNAVAILABLE_MESSAGE}
        onSelect={() => fileInputRef.current?.click()}
      />,
    },
  ];

  // The host refuses every send and change from a Read-only device (ADR 0024); say so instead of offering them.
  if (readOnly) {
    return (
      <footer className="composer-zone" data-keybinding-context="composer">
        <div className="composer-surface composer-read-only" role="note">
          <Lock size={14} aria-hidden="true" />
          <span>{prompt ? "The agent is waiting for an answer. " : ""}This device is paired Read only: it follows threads, and sending or changing them needs Full access.</span>
        </div>
      </footer>
    );
  }

  return (
    <footer className="composer-zone" data-keybinding-context="composer">
      <div className="composer-surface" data-composer-surface="true">
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
              <div className={`prompt-arrival ${arrival.waiting ? "waiting" : ""}`} inert={arrival.waiting}>
                <Renderer
                  prompt={prompt}
                  pending={promptsPending}
                  {...(snapshot?.model?.name ? { asker: snapshot.model.name } : {})}
                  onAnswer={(answer, typed) => { onAnswerPrompt?.(answer, typed); updateDraft(""); }}
                  onCancel={() => { onCancelPrompt?.(); updateDraft(""); }}
                />
              </div>
              {arrival.waiting ? <p className="prompt-arrival-note" role="status">The agent asks something. It opens once you stop typing, so your keys stay in your draft.</p>
                : arrival.stashed ? <p className="prompt-arrival-note" role="status">Your draft is set aside and comes back after the answer.</p> : null}
            </PromptSubmitContext.Provider>
          </LazyFeatureBoundary>
        );
      })() : null}
      <div
        ref={frameRef}
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
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => {
            if (promptHistoryRef.current.isNavigating) {
              promptHistoryRef.current.resetCursor();
            }
            updateDraft(event.target.value);
            setCaret(event.target.selectionStart);
            setCommandMenuDismissed(false);
          }}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            arrival.noteTyping();
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
              const shortcut = sendShortcutFor(prefSnapshot.sendShortcut, { touch: touchKeyboard, onScreen: onScreenKeyboardShown() });
              const enter = composerEnter({ shift: event.shiftKey, mod: now, shortcut, text, streaming, base: streamingBase });
              if (enter === "newline") return;
              event.preventDefault();
              submitCurrent(enter.delivery);
            }
          }}
          placeholder={
            answerable && prompt
              // A plain input's own hint; a renderer that draws the choices says it with them.
              ? (prompt.kind === "input" && !registry?.getPromptRenderer(prompt) ? prompt.placeholder : undefined) ?? "Answer in text…"
              : isVimEnabled && vim.vimMode === "normal"
                ? "Vim NORMAL mode — press 'i' to insert, ↵ to send"
                // Short, as in the design; the chords are in the send button's tooltip.
                : streaming ? "Steer, or queue a follow-up…" : "Ask anything, or hand it work…"
          }
        />
        <Suspense fallback={null}>
          <ComposerChipLayer
            apiRef={chipLayer}
            scope={attachmentScope}
            draftStorageKey={draftStorageKey}
            scopeStore={scopeStore}
            textareaRef={textareaRef}
            insertAt={chipInsertAt}
            updateDraft={updateDraft}
            setCaret={setCaret}
            selectedSkill={selectedSkill}
            onNotify={onNotify}
            onPreview={setPreviewId}
          />
        </Suspense>

        <div className="composer-toolbar">
          <ComposerFooterControls
            revision={`${text.trimStart().startsWith("!!") ? "silent-shell" : text.trimStart().startsWith("!") ? "shell" : ""}|${snapshot?.model?.name ?? ""}|${snapshot?.thinkingLevel ?? ""}`}
            leading={<>
              {leadControls.map((control) => (
                <LazyFeatureBoundary key={control.id} label={control.id} extensionId={control.extensionId} extensionName={control.extensionName} registry={registry} onNotify={onNotify}>
                  <control.Component snapshot={snapshot} actions={shellContext?.actions} />
                </LazyFeatureBoundary>
              ))}
              {lead}
              {leadControls.length > 0 || lead ? <span className="composer-lead-rule" aria-hidden /> : null}
              {text.trimStart().startsWith("!") ? (
                <span className="runtime-chip shell-mode-chip" {...tooltipProps("Shell command mode")}>
                  <Terminal size={12} className="chip-icon" />
                  {text.trimStart().startsWith("!!") ? "Silent Shell" : "Shell"}
                </span>
              ) : null}
              <button
                ref={modelChipRef}
                className="runtime-chip composer-model-chip"
                aria-expanded={modelPickerOpen === true}
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
                  ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={runtimeChoice?.kind ?? snapshot.backendKind ?? DEFAULT_RUNTIME} plan={modelOnPlan(snapshot.model)} modelName={snapshot.model.name} className="chip-icon" />
                  : runtimeChoice
                    ? <ProviderIconStack runtimeProvider={runtimeChoice.kind} className="chip-icon" />
                    : <Sparkles size={13} className="accent" />}
                <span className="runtime-chip-label">{draftOnOtherRuntime
                  ? "default model"
                  : snapshot?.model?.name ?? (runtimeOwnsModel ? "runtime model" : "select model")}</span>
                {modelPickerAvailable ? <ChevronDown size={12} className="chev" /> : null}
              </button>
            </>}
            blocks={footerBlocks}
            menu={menuControls.length > 0 ? menuControls.map((control) => (
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
            )) : undefined}
            menuShortcuts={menuShortcuts}
          />

          {isVimEnabled ? (
            <span className={`vim-badge ${vim.vimMode}`}>
              {vim.vimMode === "normal" ? "NORMAL" : "INSERT"}
            </span>
          ) : null}

          <input
            ref={fileInputRef}
            className="attachment-input"
            aria-label="Choose attachment files"
            type="file"
            tabIndex={-1}
            disabled={!attachAvailable}
            accept={inlineTakesFiles ? undefined : IMAGE_ACCEPT}
            multiple
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {streaming ? (
            <button className={`send-button stop${answerable ? " answering" : ""}`} {...tooltipProps("Stop the run", { shortcut: registry?.keybindingLabel?.("runtime.abort") })} aria-label="Stop the run" onClick={onAbort}><i /></button>
          ) : null}
          {(() => {
            // One send button, always there: it answers, steers or queues, or sends; with nothing to send it rests.
            const typedAnswer = answerable && (Boolean(plainChipText(text, true).trim()) || (answerHasFiles && !(promptSubmit && !promptSubmit.disabled)));
            const { label, hint } = answerable
              ? { label: typedAnswer ? "Send answer" : promptSubmit?.label ?? "Send answer", hint: undefined }
              : sendHint(prefSnapshot.sendShortcut ?? "enter", streaming, streamingBase, touchKeyboard);
            return (
              <button
                className="send-button"
                {...tooltipProps(hint ?? label)}
                aria-label={label}
                aria-busy={activeScopeSnapshot.submissionPending}
                disabled={held || (answerable
                  ? !typedAnswer && (promptSubmit?.disabled ?? true)
                  : arrival.waiting || activeScopeSnapshot.submissionPending || !hasDraft)}
                onClick={() => {
                  if (answerable && !typedAnswer) promptSubmit?.submit();
                  else submitCurrent(streaming && !answerable ? streamingBase : undefined);
                }}
              >
                <ArrowUp size={16} />
              </button>
            );
          })()}
        </div>
      </div>

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
            onClose={closeModelPicker}
            runtime={runtimeChoice?.kind ?? snapshot?.backendKind}
            catalogRuntime={snapshot?.backendKind}
            runtimeBackends={runtimeChoice?.backends ?? snapshot?.runtimeBackends}
            catalogs={runtimeCatalogs}
            onSelectRuntime={runtimeChoice?.onSelect}
            onNewThreadOnRuntime={onNewThreadOnRuntime}
            runtimeActions={runtimeActions}
            badges={registry?.getModelBadges?.()}
            multiSelect={gatedModelSet}
            thinking={pickerThinking}
            {...(modelPickerOpen === "thinking" ? { focus: "thinking" as const } : {})}
            anchor={modelChipRef}
            placeAgainst={frameRef}
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
