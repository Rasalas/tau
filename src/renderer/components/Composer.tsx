import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Brain, ChevronDown, GripVertical, Paperclip, Sparkles, X } from "lucide-react";
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
import { ProviderIconStack, hasProviderMark } from "./ProviderIconStack";
import { usePreferences } from "../renderer-services-context";
import { ExtensionPrompt } from "./ExtensionPrompt";
import { LazyFeatureBoundary } from "./LazyFeature";
import { TaskProgress } from "./TaskProgress";
import {
  attachmentPolicyMessage,
  MAX_ATTACHMENTS,
  selectAttachmentCandidates,
} from "../../shared/prompt-attachment-limits";
import { IMAGE_INPUT_UNAVAILABLE_MESSAGE } from "../../shared/thread-drop";
import {
  ComposerScopeStore,
  allocateAttachmentId,
  createDraftKey,
  type ComposerScope,
  type ComposerScopeReference,
  type PendingAttachment,
} from "../../workbench/composer-scope-store";
import { errorMessage } from "../../workbench/error-message";
import type { QueuedFollowUp } from "../../workbench/follow-up-queue";
import { readComposerDraft, writeComposerDraft } from "../../workbench/draft-store";
import { useClientStorage } from "../client-storage-context";

type OpenMenu = "thinking" | "runtime" | undefined;
const RUNTIME_ITEM = "runtime:";

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

export interface ComposerAttachmentHandle {
  addFiles(files: FileList | readonly File[]): Promise<void>;
}

type ComposerTrigger = { kind: "/" | "$"; query: string; start: number; end: number };
interface SelectedSkill {
  name: string;
  invocation: string;
  command: string;
  start: number;
  end: number;
}

function skillName(command: UiComposerCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

/** Editor-only autocomplete trigger; submitted text is never classified or rewritten here. */
export function composerTrigger(text: string, caret: number): ComposerTrigger | undefined {
  const before = text.slice(0, caret);
  const match = /^\s*([/$])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
  const start = before.lastIndexOf(match[1]);
  return { kind: match[1] as "/" | "$", query: match[2], start, end: caret };
}

/** Legacy helper retained for extension consumers; submission itself keeps
 * user text unchanged and uses selected skill metadata instead. */
export function normalizeSkillInvocation(text: string, commands: readonly UiComposerCommand[]): string {
  const match = /^(\s*)([$/])([^\s]+)(?=\s|$)/u.exec(text);
  if (!match) return text;
  const requested = match[3];
  const skill = commands.find((command) => command.source === "skill" && skillName(command) === requested);
  if (!skill) return text;
  if (match[2] === "/" && commands.some((command) => command.source !== "skill" && command.name === requested)) return text;
  return `${match[1]}/skill:${requested}${text.slice(match[0].length)}`;
}

/** Turns an editor selection into typed metadata without parsing runtime text. */
export function selectedSkillDraft(text: string, selection?: SelectedSkill): UiSkillDraft | undefined {
  if (!selection || text.slice(selection.start, selection.end) !== selection.invocation) return undefined;
  if (text.slice(0, selection.start).trim()) return undefined;
  const suffix = text.slice(selection.end);
  return {
    source: "skill",
    name: selection.name,
    // The autocomplete separator is not part of the user's instruction. Only
    // that one separator is removed; all remaining whitespace is meaningful.
    visibleText: /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix,
    command: selection.command,
  };
}

function readImage(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => {
      const previewUrl = typeof reader.result === "string" ? reader.result : "";
      const separator = previewUrl.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${file.name} could not be decoded.`));
        return;
      }
      resolve({
        id: allocateAttachmentId(),
        kind: "image",
        name: file.name,
        mimeType: file.type,
        data: previewUrl.slice(separator + 1),
        size: file.size,
        previewUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

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
}) {
  const [menu, setMenu] = useState<OpenMenu>();
  const clientStorage = useClientStorage();
  const attachmentScope = createDraftKey(draftStorageKey);
  const subscribeToScope = useCallback((listener: () => void) => scopeStore.subscribe(attachmentScope, listener), [attachmentScope, scopeStore]);
  const readScope = useCallback(() => scopeStore.getSnapshot(attachmentScope), [attachmentScope, scopeStore]);
  const activeScopeSnapshot = useSyncExternalStore(subscribeToScope, readScope, readScope);
  const activeAttachmentScopeRef = useRef<ComposerScope>(attachmentScope);
  const attachments = activeScopeSnapshot.attachments;
  const attachmentError = activeScopeSnapshot.error;
  const [previewId, setPreviewId] = useState<number>();
  const [caret, setCaret] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkill>();
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    textarea.style.height = `${Math.min(contentHeight, MAX_COMPOSER_HEIGHT)}px`;
    textarea.style.overflowY = contentHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [text, textareaRef]);
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
  const updateDraft = (next: string) => {
    scopeStore.setDraft(attachmentScope, next);
    writeComposerDraft(clientStorage, draftStorageKey, next);
    onChange?.(next);
    setSelectedSkill((current) => current && next.slice(current.start, current.end) === current.invocation ? current : undefined);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const preferences = usePreferences();
  // A model behind a subscription login is used only after its warning was read once (per provider).
  const [subscriptionAsk, setSubscriptionAsk] = useState<{ model?: UiModel; resubmit?: "followUp" | "steer" | "prompt" }>();
  const needsSubscriptionAck = (model: UiModel | undefined): boolean =>
    model?.login === "subscription" && !preferences.hasAcknowledgedSubscriptionLogin(model.provider);
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
  const thinkingSelectionAvailable = !runtimeOwnsModel && !draftOnOtherRuntime && (snapshot?.thinkingLevels.length ?? 0) > 1;
  const composerControls = registry?.getComposerControls() ?? [];
  const runtimeLabel = runtimeChoice?.backends.find((backend) => backend.kind === runtimeChoice.kind)?.label ?? runtimeChoice?.kind ?? "";
  const preview = attachments.find((attachment) => attachment.id === previewId);

  useEffect(() => {
    const previousScope = activeAttachmentScopeRef.current;
    if (previousScope === attachmentScope) return;
    activeAttachmentScopeRef.current = attachmentScope;
    setPreviewId(undefined);
  }, [attachmentScope]);

  const processFiles = useCallback(async (
    files: FileList | readonly File[],
    scopeRef: ComposerScopeReference,
    capability: boolean,
    generation: number,
  ) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const state = scopeStore.getSnapshot(scopeRef.scope);
    if (!capability) {
      scopeStore.setAttachmentError(scopeRef.scope, IMAGE_INPUT_UNAVAILABLE_MESSAGE, generation);
      return;
    }
    const policy = selectAttachmentCandidates(
      incoming.map((file) => ({ item: file, name: file.name, mimeType: file.type, size: file.size })),
      state.attachments,
    );
    const validCandidates = policy.accepted.map((candidate) => candidate.item);
    const firstError = policy.rejected[0] ? attachmentPolicyMessage(policy.rejected[0]) : undefined;
    const results = await Promise.allSettled(validCandidates.map(readImage));
    const accepted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const error = firstError ?? (rejection ? errorMessage(rejection.reason) : undefined);
    scopeStore.setAttachmentError(scopeRef.scope, error, generation);
    if (accepted.length > 0) {
      scopeStore.addAttachments(scopeRef.scope, accepted, MAX_ATTACHMENTS);
    }
  }, [scopeStore]);
  const addFiles = useCallback((files: FileList | readonly File[]) => {
    // DataTransfer.files is a live FileList and may be emptied once the drop
    // event returns. Snapshot it before entering the asynchronous queue.
    const fileSnapshot = Array.from(files);
    const scopeRef = scopeStore.createScopeReference(attachmentScope);
    const state = scopeStore.getSnapshot(attachmentScope);
    const previous = state.attachmentProcessing;
    let generation = 0;
    const operation = previous
      .then(() => processFiles(fileSnapshot, scopeRef, supportsImageInput, generation))
      .finally(() => scopeStore.releaseScopeReference(scopeRef));
    generation = scopeStore.setAttachmentProcessing(attachmentScope, operation);
    return operation;
  }, [attachmentScope, processFiles, scopeStore, supportsImageInput]);
  useImperativeHandle(attachmentRef, () => ({ addFiles }), [addFiles]);

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
      if (!text.trim()) return;
      onAnswerPrompt?.(text, true);
      updateDraft("");
      return;
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
      if (result.accepted && activeAttachmentScopeRef.current === submittedScope) setPreviewId(undefined);
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
            <Renderer
              prompt={prompt}
              pending={promptsPending}
              onAnswer={(answer, typed) => { onAnswerPrompt?.(answer, typed); updateDraft(""); }}
              onCancel={() => { onCancelPrompt?.(); updateDraft(""); }}
            />
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
        {attachments.length > 0 ? (
          <div className="composer-attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.id}>
                <button
                  className="attachment-preview-button"
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreviewId(attachment.id)}
                >
                  <img src={attachment.previewUrl} alt="" />
                </button>
                <button
                  className="attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => {
                    scopeStore.removeAttachment(attachmentScope, attachment.id);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? <div className="composer-attachment-error" role="alert">{attachmentError}</div> : null}
        {trigger ? (
          <div className="composer-command-menu" role="listbox" aria-label={trigger.kind === "$" ? "Skills" : "Commands"}>
            {commandMatches.length > 0 ? commandMatches.map((command, index) => {
              const name = command.source === "skill" ? skillName(command) : command.name;
              const invocation = `${trigger.kind}${name}`;
              const choose = () => {
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
              return <button
                type="button"
                role="option"
                aria-selected={index === commandCursor}
                className={index === commandCursor ? "selected" : ""}
                key={`${command.source}:${command.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={choose}
              >
                <span className="composer-command-mark">{trigger.kind}</span>
                <span className="composer-command-copy">
                  <strong>{name}{command.argumentHint ? <i>{command.argumentHint}</i> : null}</strong>
                  <small>{command.description || (command.source === "skill" ? "Load this skill for the next turn" : "Run this command")}</small>
                </span>
                <span className={`composer-command-source ${command.source}`}>{command.source}</span>
              </button>;
            }) : <div className="composer-command-empty">No {trigger.kind === "$" ? "skill" : "command"} matches “{trigger.query}”.</div>}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => {
            updateDraft(event.target.value);
            setCaret(event.target.selectionStart);
            setCommandMenuDismissed(false);
          }}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (trigger && commandMatches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCommandCursor((current) => (current + 1) % commandMatches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCommandCursor((current) => (current - 1 + commandMatches.length) % commandMatches.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const command = commandMatches[commandCursor];
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
                requestAnimationFrame(() => textareaRef.current?.setSelectionRange(nextCaret, nextCaret));
                return;
              }
            }
            if (trigger && event.key === "Escape") {
              event.preventDefault();
              setCommandMenuDismissed(true);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const now = event.metaKey || event.ctrlKey;
              // ⌘↵ on an empty field releases the message at the head of the queue.
              if (now && !text.trim() && attachments.length === 0 && queue[0] && !answerable) {
                onSteerQueued(queue[0].id);
                return;
              }
              submitCurrent(streaming ? (now ? "steer" : "followUp") : undefined);
            }
          }}
          placeholder={
            answerable && prompt
              ? prompt.placeholder ?? "Answer yourself — ↵ sends it back to the extension"
              : streaming
                ? "Queue after this turn — ↵ queues, ⌘↵ steers now"
                : "Direct the agent — $ skills, / commands, @ files, ⇧↵ newline"
          }
        />

        <div className="composer-toolbar">
          <div className="composer-chips">
          {runtimeChoice ? (
            <span className="menu-anchor composer-runtime-menu-anchor">
              <button
                className="runtime-chip"
                title="The runtime this new thread will run on"
                aria-label={`Runtime: ${runtimeLabel}`}
                onClick={() => setMenu(menu === "runtime" ? undefined : "runtime")}
              >
                {hasProviderMark(runtimeChoice.kind) ? <ProviderIconStack modelProvider={runtimeChoice.kind} className="chip-icon" /> : null}
                {runtimeLabel}
                <ChevronDown size={12} className="chev" />
              </button>
              {menu === "runtime" ? (
                <Menu
                  placement="above"
                  sections={[{
                    heading: "RUNTIME",
                    items: runtimeChoice.backends.map((backend) => ({
                      id: `${RUNTIME_ITEM}${backend.kind}`,
                      label: backend.label,
                      selected: backend.kind === runtimeChoice.kind,
                    })),
                  }]}
                  onSelect={(id) => {
                    if (id.startsWith(RUNTIME_ITEM)) runtimeChoice.onSelect(id.slice(RUNTIME_ITEM.length));
                  }}
                  onClose={() => setMenu(undefined)}
                />
              ) : null}
            </span>
          ) : null}
          <button
            className="runtime-chip"
            disabled={!modelSelectionAvailable}
            title={modelSelectionAvailable
              ? "Select model"
              : draftOnOtherRuntime ? `This thread starts on ${runtimeLabel}'s own model; pick another once it exists.`
                : runtimeOwnsModel ? "This runtime selects its own model." : "No models are available for this runtime."}
            aria-label={modelSelectionAvailable
              ? `Select model: ${snapshot?.model?.name ?? "current model"}`
              : "Model selection unavailable"}
            onClick={() => { if (modelSelectionAvailable) setModelPickerOpen(true); }}
          >
            {snapshot?.model && !draftOnOtherRuntime
              ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={snapshot.backendKind} className="chip-icon" />
              : <Sparkles size={13} className="accent" />}
            {draftOnOtherRuntime
              ? "default model"
              : snapshot?.model?.name ?? (runtimeOwnsModel ? "runtime model" : "select model")}
            {modelSelectionAvailable ? <ChevronDown size={12} className="chev" /> : null}
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

          {streaming ? (
            <button className="send-button stop" title="Stop the run" onClick={onAbort}><i /></button>
          ) : (
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
          )}
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
