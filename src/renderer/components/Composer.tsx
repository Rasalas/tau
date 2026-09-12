import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Brain, ChevronDown, GripVertical, Maximize2, Minimize2, Paperclip, Sparkles, SquarePen, Terminal, X } from "lucide-react";
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
import { ModelPicker, modelKey } from "./ModelPicker";
import { SubscriptionLoginPrompt } from "./SubscriptionLoginPrompt";
import { ProviderIconStack } from "./ProviderIconStack";
import { usePreferences } from "../renderer-services-context";
import { ExtensionPrompt, PromptSubmitContext, type PromptSubmitAction } from "./ExtensionPrompt";
import { LazyFeatureBoundary } from "./LazyFeature";
import { TaskProgress } from "./TaskProgress";
import { IMAGE_INPUT_UNAVAILABLE_MESSAGE } from "../../shared/thread-drop";
import {
  ComposerScopeStore,
  createDraftKey,
} from "../../workbench/composer-scope-store";
import { errorMessage } from "../../workbench/error-message";
import type { QueuedFollowUp } from "../../workbench/follow-up-queue";
import { readComposerDraft, writeComposerDraft } from "../../workbench/draft-store";
import { PromptHistory, loadStoredPromptHistory, saveStoredPromptHistory } from "../../workbench/prompt-history";
import { handleComposerReadlineKey } from "./useComposerReadline";
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
import { ComposerAttachmentsList } from "./ComposerAttachments";

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

const noSubscribe = () => () => {};
const noVersion = () => 0;

/** Pi's out-of-the-box reasoning level; shown as the Default badge. */
const DEFAULT_THINKING = "medium";
const MAX_COMPOSER_HEIGHT = 220;

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
  attachmentRef,
  onChange,
  onSubmit,
  onAbort,
  onCancelQueued,
  onSteerQueued,
  onReorderQueue,
  onSetModel,
  onSetThinking,
  runtimeChoice,
  prompt,
  promptsPending = 0,
  onAnswerPrompt,
  onCancelPrompt,
  onCompactContext,
  held = false,
  onNotify,
  onOpenPromptEditor,
  onRunShellAction,
}: {
  snapshot?: HostSnapshot;
  scopeStore: ComposerScopeStore;
  value?: string;
  seed?: string;
  draftStorageKey?: string;
  queue: readonly QueuedFollowUp[];
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
  /** What this thread has spent; absent when unknown or when costs are hidden. */
  threadUsage?: UiThreadUsage;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachmentRef?: RefObject<ComposerAttachmentHandle | null>;
  onChange?(value: string): void;
  onSubmit(text?: string, attachments?: UiPromptAttachment[], delivery?: "followUp" | "steer", skillDraft?: UiSkillDraft): Promise<SubmitResult>;
  onAbort(): void;
  onCancelQueued(id: string): void;
  /** Sends one queued message now, ahead of the rest of the queue. */
  onSteerQueued(id: string): void;
  onReorderQueue(id: string, toIndex: number): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  /** Offered while the composer targets a thread that does not exist yet. */
  runtimeChoice?: ComposerRuntimeChoice;
  prompt?: ExtensionUiPrompt;
  promptsPending?: number;
  /** `typed` is set when the answer came from the text field rather than a choice. */
  onAnswerPrompt?(value: string | boolean, typed?: boolean): void;
  onCancelPrompt?(): void;
  onCompactContext(): void;
  /** An extension is changing the workspace; submitting would target the wrong thread. */
  held?: boolean;
  onNotify?(message: string): void;
  /** Opens the current draft in an external editor via workspace extension. */
  onOpenPromptEditor?(): void;
  /** Direct shell execution for `! <command>` inputs. */
  onRunShellAction?(command: string): Promise<unknown>;
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
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkill>();
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const trigger = commandMenuDismissed ? undefined : composerTrigger(text, caret);
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
  const updateDraft = (next: string) => {
    scopeStore.setDraft(attachmentScope, next);
    writeComposerDraft(clientStorage, draftStorageKey, next);
    onChange?.(next);
    setSelectedSkill((current) => current && next.slice(current.start, current.end) === current.invocation ? current : undefined);
  };

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
  const preferences = usePreferences();
  // A model behind a subscription login is used only after its warning was read once (per provider).
  const [subscriptionAsk, setSubscriptionAsk] = useState<{ model?: UiModel; resubmit?: "followUp" | "steer" | "prompt" }>();
  const [promptSubmit, setPromptSubmit] = useState<PromptSubmitAction>();
  const registerPromptSubmit = useCallback((action: PromptSubmitAction | undefined) => setPromptSubmit(action), []);
  const needsSubscriptionAck = (model: UiModel | undefined): boolean =>
    model?.login === "subscription"
    && (snapshot?.backendKind === "antigravity" || snapshot?.backendKind === "claude-code")
    && !preferences.hasAcknowledgedSubscriptionLogin(model.provider);
  const chooseModel = (model: UiModel) => {
    if (needsSubscriptionAck(model)) setSubscriptionAsk({ model });
    else onSetModel(model.provider, model.id);
  };
  // Only a drag that starts on the grip reorders; text drags inside a row do not.
  const queueDragArmRef = useRef<string | undefined>(undefined);
  const [draggingQueuedId, setDraggingQueuedId] = useState<string>();
  const supportsImageInput = snapshot?.supportsImageInput ?? false;
  const streaming = Boolean(snapshot?.isStreaming);
  // An external runtime may pick model and reasoning itself; the pickers then only show what it reports.
  const runtimeOwnsModel = snapshot?.runtimeCapabilities?.ownsModelSelection === true;
  // A draft bound for another runtime than the visible thread: that catalog is
  // not this thread's, and the thread it will become does not exist yet.
  const draftOnOtherRuntime = runtimeChoice !== undefined && snapshot?.backendKind !== undefined && runtimeChoice.kind !== snapshot.backendKind;
  const modelSelectionAvailable = !runtimeOwnsModel && !draftOnOtherRuntime && (snapshot?.models.length ?? 0) > 0;
  const modelPickerAvailable = modelSelectionAvailable || runtimeChoice !== undefined;
  useEffect(() => {
    const onOpen = () => {
      if (modelPickerAvailable) setModelPickerOpen(true);
    };
    window.addEventListener("tau:open-model-picker", onOpen);
    return () => window.removeEventListener("tau:open-model-picker", onOpen);
  }, [modelPickerAvailable]);

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
  const { preview, setPreviewId, clearPreviewForScope, addFiles, removeAttachment } = useComposerAttachments({
    scopeStore,
    scope: attachmentScope,
    attachments,
    supportsImageInput,
    attachmentRef,
  });

  // An editor prompt arrives with text to edit; seed the field once.
  const seededPromptRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prompt || seededPromptRef.current === prompt.id) return;
    seededPromptRef.current = prompt.id;
    if (prompt.prefill) updateDraft(prompt.prefill);
  }, [prompt, updateDraft]);

  const answerable = prompt && prompt.answerElsewhere !== true;
  const submitCurrent = (delivery?: "followUp" | "steer") => {
    if (held) return;
    if (activeScopeSnapshot.submissionPending) return;
    if (needsSubscriptionAck(snapshot?.model)) {
      setSubscriptionAsk({ resubmit: delivery ?? "prompt" });
      return;
    }
    if (answerable && prompt) {
      if (!text.trim()) {
        if (promptSubmit && !promptSubmit.disabled) promptSubmit.submit();
        return;
      }
      onAnswerPrompt?.(text, true);
      updateDraft("");
      return;
    }
    const trimmedInput = text.trim();
    if (trimmedInput.startsWith("!") && onRunShellAction) {
      const shellCmd = trimmedInput.slice(1).trim();
      if (shellCmd.length > 0) {
        updateDraft("");
        recordPrompt(trimmedInput);
        void onRunShellAction(shellCmd).then((result) => {
          if (result && typeof result === "object" && "output" in result) {
            const out = (result as { output?: string; exitCode?: number }).output?.trim();
            if (out) {
              onNotify?.(out);
            } else if ((result as { exitCode?: number }).exitCode !== undefined) {
              onNotify?.(`Command exited with code ${(result as { exitCode?: number }).exitCode}`);
            }
          }
        }).catch((error) => {
          onNotify?.(errorMessage(error));
        });
        return;
      }
    }
    const submittedScope = attachmentScope;
    const submission = scopeStore.beginSubmission(submittedScope);
    if ("busy" in submission) return;
    const sendSubmission = async (handle: Awaited<typeof submission>) => {
      if (!handle.text.trim() && handle.attachments.length === 0) {
        handle.cancel();
        return;
      }
      // The selected skill is typed metadata. Keep the editor's text intact;
      // the host/runtime adapter resolves provider syntax at the boundary.
      const submittedText = handle.text;
      const skillDraft = selectedSkillDraft(submittedText, selectedSkill);
      // beginSubmission clears the live editor before the host round trip. Keep
      // the persisted copy in step so a reload cannot resurrect a sent prompt.
      if (draftStorageKey !== undefined) {
        writeComposerDraft(clientStorage, submittedScope, scopeStore.getSnapshot(submittedScope).draft);
      }
      let result: SubmitResult;
      try {
        result = skillDraft
          ? await onSubmit(submittedText, [...handle.attachments], delivery, skillDraft)
          : delivery
            ? await onSubmit(submittedText, [...handle.attachments], delivery)
            : await onSubmit(submittedText, [...handle.attachments]);
      } catch (error) {
        result = { accepted: false, message: errorMessage(error) };
      }
      handle.settle(result);
      // Settling empties an accepted draft in the scope store. The persisted
      // copy is written per keystroke and has to follow it, or the next start
      // seeds the composer with a prompt that was already sent.
      if (draftStorageKey !== undefined) {
        writeComposerDraft(clientStorage, submittedScope, scopeStore.getSnapshot(submittedScope).draft);
      }
      if (result.accepted) {
        recordPrompt(submittedText);
        clearPreviewForScope(submittedScope);
      }
    };
    const handleSubmissionError = (error: unknown) => {
      scopeStore.setAttachmentError(
        submittedScope,
        errorMessage(error),
        scopeStore.getAttachmentGeneration(submittedScope),
      );
    };
    if ("then" in submission) {
      void submission.then(sendSubmission).catch(handleSubmissionError);
    } else {
      void sendSubmission(submission).catch(handleSubmissionError);
    }
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

  return (
    <footer className="composer-zone">
      <div className="composer-surface" data-composer-surface="true">
      {snapshot?.taskProgress ? <TaskProgress progress={snapshot.taskProgress} placement="dock" /> : null}
      {queue.length > 0 ? (
        <div className="composer-queue" role="list" aria-label="Queued messages">
          {queue.map((entry, index) => {
            const label = entry.text.trim() || `Attached ${entry.attachments.map((attachment) => attachment.name).join(", ")}`;
            return (
              <div
                className={`composer-queue-item${draggingQueuedId === entry.id ? " dragging" : ""}`}
                key={entry.id}
                role="listitem"
                draggable
                onDragStart={(event) => {
                  if (queueDragArmRef.current !== entry.id) { event.preventDefault(); return; }
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", entry.id);
                  setDraggingQueuedId(entry.id);
                }}
                onDragOver={(event) => {
                  if (!draggingQueuedId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  if (!draggingQueuedId) return;
                  event.preventDefault();
                  if (draggingQueuedId !== entry.id) onReorderQueue(draggingQueuedId, index);
                  queueDragArmRef.current = undefined;
                  setDraggingQueuedId(undefined);
                }}
                onDragEnd={() => { queueDragArmRef.current = undefined; setDraggingQueuedId(undefined); }}
              >
                <button
                  className="composer-queue-grip"
                  type="button"
                  title="Drag to reorder — ⌥↑ / ⌥↓ also moves it"
                  aria-label={`Reorder queued message ${index + 1} of ${queue.length}`}
                  onPointerDown={() => { queueDragArmRef.current = entry.id; }}
                  onPointerUp={() => { queueDragArmRef.current = undefined; }}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                    event.preventDefault();
                    onReorderQueue(entry.id, event.key === "ArrowUp" ? index - 1 : index + 1);
                  }}
                >
                  <GripVertical size={13} />
                </button>
                <span title={label}>{label}</span>
                <button
                  className="composer-queue-steer"
                  type="button"
                  onClick={() => onSteerQueued(entry.id)}
                  title={streaming ? "Send now, interrupting the current turn" : "Send now"}
                >
                  {streaming ? "Steer" : "Send"}
                </button>
                <button
                  className="composer-queue-drop"
                  type="button"
                  onClick={() => onCancelQueued(entry.id)}
                  title="Drop this queued message"
                  aria-label="Drop this queued message"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
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
        className={`composer-frame ${queue.length > 0 || prompt ? "stacked" : ""} ${answerable ? "answering" : ""}`}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void addFiles(event.dataTransfer.files);
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length === 0) return;
          event.preventDefault();
          void addFiles(event.clipboardData.files);
        }}
      >
        <ComposerAttachmentsList
          attachments={attachments}
          onPreview={(id) => setPreviewId(id)}
          onRemove={(id) => removeAttachment(id)}
        />
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
          />
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
            const totalMatches = trigger?.kind === "@"
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
                if (trigger.kind === "@") {
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
              setCommandMenuDismissed(true);
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const now = event.metaKey || event.ctrlKey;
              // ⌘↵ on an empty field releases the message at the head of the queue.
              if (now && !text.trim() && attachments.length === 0 && queue[0] && !answerable) {
                onSteerQueued(queue[0].id);
                return;
              }
              const delivery = streaming ? (now ? "steer" : "followUp") : undefined;
              submitCurrent(delivery);
            }
          }}
          placeholder={
            answerable && prompt
              ? prompt.placeholder ?? "Answer yourself — ↵ sends it back to the extension"
              : text.trimStart().startsWith("!")
                ? text.trimStart().startsWith("!!")
                  ? "Silent shell mode — runs command without LLM context"
                  : "Shell mode — runs command and shares output with agent"
                : streaming
                  ? "Queue after this turn — ↵ queues, ⌘↵ steers now, ⌥↑ dequeues"
                  : "Direct the agent — $ skills, / commands, @ files, ⇧↵ newline"
          }
        />

        <div className="composer-toolbar">
          <div className="composer-chips">
          {text.trimStart().startsWith("!") ? (
            <span className="runtime-chip shell-mode-chip" title="Shell command mode">
              <Terminal size={12} className="chip-icon" />
              {text.trimStart().startsWith("!!") ? "Silent Shell" : "Shell"}
            </span>
          ) : null}
          <button
            className="runtime-chip"
            disabled={!modelPickerAvailable}
            title={modelSelectionAvailable
              ? runtimeChoice ? "Select runtime and model" : "Select model"
              : draftOnOtherRuntime ? `Change runtime or start with ${runtimeLabel}'s default model.`
                : runtimeOwnsModel ? "This runtime selects its own model." : "No models are available for this runtime."}
            aria-label={modelSelectionAvailable
              ? `${runtimeChoice ? "Select runtime and model" : "Select model"}: ${snapshot?.model?.name ?? "current model"}`
              : runtimeChoice ? `Select runtime and model: ${runtimeLabel}` : "Model selection unavailable"}
            onClick={() => { if (modelPickerAvailable) setModelPickerOpen(true); }}
          >
            {snapshot?.model && !draftOnOtherRuntime
              ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={runtimeChoice?.kind ?? snapshot.backendKind} className="chip-icon" />
              : runtimeChoice
                ? <ProviderIconStack runtimeProvider={runtimeChoice.kind} className="chip-icon" />
                : <Sparkles size={13} className="accent" />}
            {draftOnOtherRuntime
              ? "default model"
              : snapshot?.model?.name ?? (runtimeOwnsModel ? "runtime model" : "select model")}
            {modelPickerAvailable ? <ChevronDown size={12} className="chev" /> : null}
          </button>

          <span className="menu-anchor composer-runtime-menu-anchor">
            <button
              className="runtime-chip"
              disabled={!thinkingSelectionAvailable}
              title={thinkingSelectionAvailable
                ? "Reasoning"
                : draftOnOtherRuntime ? `${runtimeLabel} sets reasoning once this thread exists.`
                  : runtimeOwnsModel ? "This runtime controls reasoning itself." : "Reasoning controls are unavailable."}
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
                    heading: "REASONING",
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

          {composerControls.filter((control) => control.placement !== "footer").map((control) => (
            <LazyFeatureBoundary
              key={control.id}
              label={control.id}
              extensionId={control.extensionId}
              extensionName={control.extensionName}
              registry={registry}
              onNotify={onNotify}
            >
              <control.Component snapshot={snapshot} />
            </LazyFeatureBoundary>
          ))}

          </div>
          <span className="spacer" />

          <button
            className={`composer-action-btn${isExpanded ? " active" : ""}`}
            type="button"
            title={isExpanded ? "Collapse composer (⇧⌘E)" : "Expand composer (⇧⌘E)"}
            aria-label={isExpanded ? "Collapse composer" : "Expand composer"}
            onClick={() => setIsExpanded((prev) => !prev)}
          >
            {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>

          <button
            className="composer-action-btn"
            type="button"
            title="Edit prompt in external editor (⌘E / Ctrl+G)"
            aria-label="Edit prompt in external editor"
            onClick={() => onOpenPromptEditor?.()}
          >
            <SquarePen size={16} />
          </button>

          <button className="attach-button" type="button" title={supportsImageInput ? "Attach files" : IMAGE_INPUT_UNAVAILABLE_MESSAGE} aria-label="Attach files" disabled={!supportsImageInput} onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={17} />
          </button>
          <input
            ref={fileInputRef}
            className="attachment-input"
            aria-label="Choose attachment files"
            type="file"
            disabled={!supportsImageInput}
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {threadUsage ? <ThreadCost usage={threadUsage} /> : null}

          {contextUsage ? (
            <ContextMeter usage={contextUsage} breakdown={contextBreakdown} onCompact={onCompactContext} />
          ) : null}

          {answerable && prompt ? (() => {
            const submitLabel = text.trim() ? "Send answer" : promptSubmit?.label ?? "Send answer";
            return (
              <button
                className="prompt-submit-button"
                title={submitLabel}
                aria-label={submitLabel}
                disabled={held || (text.trim().length === 0 && (promptSubmit?.disabled ?? true))}
                onClick={() => {
                  if (text.trim()) submitCurrent();
                  else promptSubmit?.submit();
                }}
              >
                {submitLabel}
                <ArrowUp size={15} />
              </button>
            );
          })() : null}
          {streaming ? (
            <button className="send-button stop" title="Stop the run" aria-label="Stop the run" onClick={onAbort}><i /></button>
          ) : !answerable ? (
            <button
              className="send-button"
              title="Send"
              aria-label="Send"
              aria-busy={activeScopeSnapshot.submissionPending}
              disabled={held || activeScopeSnapshot.submissionPending || (text.trim().length === 0 && attachments.length === 0)}
              onClick={() => submitCurrent()}
            >
              <ArrowUp size={16} />
            </button>
          ) : null}
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
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={chooseModel}
          onClose={() => setModelPickerOpen(false)}
          runtime={runtimeChoice?.kind ?? snapshot?.backendKind}
          runtimeBackends={runtimeChoice?.backends}
          onSelectRuntime={runtimeChoice?.onSelect}
          modelsAvailable={!draftOnOtherRuntime}
        />
      ) : null}
      {subscriptionAsk ? (
        <SubscriptionLoginPrompt
          provider={(subscriptionAsk.model ?? snapshot?.model)?.provider ?? ""}
          onAccept={() => {
            const provider = (subscriptionAsk.model ?? snapshot?.model)?.provider;
            if (provider) preferences.acknowledgeSubscriptionLogin(provider);
            const { model, resubmit } = subscriptionAsk;
            setSubscriptionAsk(undefined);
            if (model) onSetModel(model.provider, model.id);
            if (resubmit) submitCurrent(resubmit === "prompt" ? undefined : resubmit);
          }}
          onDecline={() => {
            const { model } = subscriptionAsk;
            setSubscriptionAsk(undefined);
            if (model) setModelPickerOpen(true);
          }}
        />
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
          <control.Component snapshot={snapshot} />
        </LazyFeatureBoundary>
      ))}
      </div>
    </footer>
  );
}
