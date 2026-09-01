import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ArrowUp, ChevronDown, CornerDownRight, Lock, LockOpen, Paperclip, Sparkles, X, Zap } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, ServiceTier, SubmissionResult, UiComposerCommand, UiContextUsage, UiPromptAttachment, UiSkillDraft, WorkspaceInfo } from "../../shared/contracts";
import { ACCESS_LEVELS, type AccessLevel } from "../preferences";
import { ContextMeter, type ContextBreakdown } from "./ContextMeter";
import { Menu } from "./Menu";
import { ModelPicker, modelKey } from "./ModelPicker";
import { ExtensionPrompt, type QuestionnaireChoice } from "./ExtensionPrompt";
import { WorkspaceBar } from "./WorkspaceBar";
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
} from "../composer-scope-store";
import { errorMessage } from "../error-message";
import { readComposerDraft, writeComposerDraft } from "../draft-store";

type OpenMenu = "thinking" | "access" | undefined;

/** Pi's out-of-the-box reasoning level; shown as the Default badge. */
const DEFAULT_THINKING = "medium";

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
  accessLevel,
  contextUsage,
  contextBreakdown,
  textareaRef,
  attachmentRef,
  onChange,
  onSubmit,
  onAbort,
  onCancelQueued,
  onSetModel,
  onSetThinking,
  onSetServiceTier,
  prompt,
  promptsPending = 0,
  onAnswerPrompt,
  onCancelPrompt,
  promptChoices,
  onPreselectQuestion,
  onSetAccess,
  onCompactContext,
  workspace,
  workspaceBusy,
  onOpenWorktree,
  onCreateWorktree,
  onSwitchRef,
}: {
  snapshot?: HostSnapshot;
  scopeStore: ComposerScopeStore;
  value?: string;
  seed?: string;
  draftStorageKey?: string;
  queue: string[];
  accessLevel: AccessLevel;
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachmentRef?: RefObject<ComposerAttachmentHandle | null>;
  onChange?(value: string): void;
  onSubmit(text?: string, attachments?: UiPromptAttachment[], delivery?: "followUp" | "steer", skillDraft?: UiSkillDraft): Promise<SubmitResult>;
  onAbort(): void;
  onCancelQueued(index: number): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  onSetServiceTier(tier: ServiceTier): void;
  prompt?: ExtensionUiPrompt;
  promptsPending?: number;
  /** `typed` is set when the answer came from the text field rather than a choice. */
  onAnswerPrompt?(value: string | boolean, typed?: boolean): void;
  onCancelPrompt?(): void;
  /** Picks per question of the prompt's questionnaire, answered or waiting. */
  promptChoices?: Record<number, QuestionnaireChoice>;
  onPreselectQuestion?(index: number, labels: string[]): void;
  onSetAccess(level: AccessLevel): void;
  onCompactContext(): void;
  workspace?: WorkspaceInfo;
  workspaceBusy: boolean;
  onOpenWorktree(path: string): Promise<boolean>;
  onCreateWorktree(branch: string, baseRef: string): Promise<boolean>;
  onSwitchRef(ref: string): Promise<boolean>;
}) {
  const [menu, setMenu] = useState<OpenMenu>();
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
  const commands = snapshot?.composerCommands ?? [];
  const trigger = commandMenuDismissed ? undefined : composerTrigger(text, caret);
  const commandMatches = useMemo(() => {
    if (!trigger) return [];
    const query = trigger.query.toLowerCase();
    return commands.filter((command) => {
      if (trigger.kind === "$" && command.source !== "skill") return false;
      const name = command.source === "skill" ? skillName(command) : command.name;
      return !query || name.toLowerCase().includes(query) || command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query);
    }).slice(0, 10);
  }, [commands, trigger]);
  useEffect(() => setCommandCursor(0), [trigger?.kind, trigger?.query]);
  const appliedSeed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (value !== undefined || draftStorageKey === undefined) return;
    if (activeScopeSnapshot.draft === "") {
      const persisted = readComposerDraft(window.localStorage, draftStorageKey);
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
    writeComposerDraft(window.localStorage, draftStorageKey, next);
    onChange?.(next);
    setSelectedSkill((current) => current && next.slice(current.start, current.end) === current.invocation ? current : undefined);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const fastTier = snapshot?.serviceTier === "fast";
  const supportsImageInput = snapshot?.supportsImageInput ?? false;
  const tierAvailable = Boolean(snapshot?.serviceTierAvailable);
  const streaming = Boolean(snapshot?.isStreaming);
  const claudeCode = snapshot?.backendKind === "claude-code";
  const modelSelectionAvailable = !claudeCode && (snapshot?.models.length ?? 0) > 0;
  const thinkingSelectionAvailable = !claudeCode && (snapshot?.thinkingLevels.length ?? 0) > 1;
  const accessLabel = ACCESS_LEVELS.find((level) => level.id === accessLevel)?.label ?? accessLevel;
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
    const snapshot = Array.from(files);
    const scopeRef = scopeStore.createScopeReference(attachmentScope);
    const state = scopeStore.getSnapshot(attachmentScope);
    const previous = state.attachmentProcessing;
    let generation = 0;
    const operation = previous
      .then(() => processFiles(snapshot, scopeRef, supportsImageInput, generation))
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
    if (workspaceBusy) return;
    if (activeScopeSnapshot.submissionPending) return;
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
      {prompt ? (
        <ExtensionPrompt
          prompt={prompt}
          pending={promptsPending}
          choices={promptChoices}
          onAnswer={(value) => { onAnswerPrompt?.(value); updateDraft(""); }}
          onCancel={() => { onCancelPrompt?.(); updateDraft(""); }}
          onPreselect={onPreselectQuestion}
        />
      ) : null}
      {queue.length > 0 ? (
        <div className="composer-queue">
          {queue.map((entry, index) => (
            <div className="composer-queue-item" key={`${index}-${entry}`}>
              <CornerDownRight size={13} />
              <span title={entry}>{entry}</span>
              <button onClick={() => onCancelQueued(index)} title="Drop this queued message">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className={`composer-frame ${queue.length > 0 || prompt ? "stacked" : ""} ${answerable ? "answering" : ""}`}
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
              submitCurrent(streaming
                ? event.metaKey || event.ctrlKey ? "steer" : "followUp"
                : undefined);
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
          <button
            className="runtime-chip"
            disabled={!modelSelectionAvailable}
            title={modelSelectionAvailable ? "Select model" : claudeCode ? "Claude Code selects its model in the Claude runtime." : "No models are available for this runtime."}
            aria-label={modelSelectionAvailable
              ? `Select model: ${snapshot?.model?.name ?? "current model"}`
              : "Model selection unavailable"}
            onClick={() => { if (modelSelectionAvailable) setModelPickerOpen(true); }}
          >
            <Sparkles size={13} className="accent" />
            {snapshot?.model?.name ?? (claudeCode ? "Claude Code model" : "select model")}
            {modelSelectionAvailable ? <ChevronDown size={12} className="chev" /> : null}
          </button>

          <span className="menu-anchor composer-runtime-menu-anchor">
            <button
              className="runtime-chip"
              disabled={!thinkingSelectionAvailable && !tierAvailable}
              title={thinkingSelectionAvailable || tierAvailable ? "Reasoning and service tier" : claudeCode ? "Claude Code does not expose Pi thinking levels or service tiers." : "Reasoning controls are unavailable."}
              aria-label={thinkingSelectionAvailable || tierAvailable ? "Reasoning and service tier" : "Reasoning controls unavailable"}
              onClick={() => {
                if (thinkingSelectionAvailable || tierAvailable) setMenu(menu === "thinking" ? undefined : "thinking");
              }}
            >
              <Zap size={13} />
              {snapshot?.thinkingLevel ?? "—"}
              {fastTier ? <i className="tier-mark">fast</i> : null}
              {thinkingSelectionAvailable || tierAvailable ? <ChevronDown size={12} className="chev" /> : null}
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
                      description: !thinkingSelectionAvailable && claudeCode ? "Claude Code controls reasoning in its own runtime." : undefined,
                    })),
                  },
                  {
                    heading: "SERVICE TIER",
                    items: [
                      {
                        id: "tier:standard",
                        label: "Standard",
                        badge: "Default",
                        selected: !fastTier,
                      },
                      {
                        id: "tier:fast",
                        label: "Fast",
                        description: tierAvailable
                          ? "Priority routing, higher cost"
                          : "Not offered for this model's provider",
                        selected: fastTier,
                        disabled: !tierAvailable,
                      },
                    ],
                  },
                ]}
                onSelect={(id) => {
                  const [group, value] = id.split(":");
                  if (group === "thinking") onSetThinking(value);
                  else onSetServiceTier(value as ServiceTier);
                }}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="menu-anchor composer-runtime-menu-anchor">
            <button className="runtime-chip" onClick={() => setMenu(menu === "access" ? undefined : "access")}>
              {accessLevel === "full" ? <LockOpen size={13} /> : <Lock size={13} />}
              {accessLabel}
              <ChevronDown size={12} className="chev" />
            </button>
            {menu === "access" ? (
              <Menu
                placement="above"
                heading="Access"
                items={ACCESS_LEVELS.map((level) => ({
                  id: level.id,
                  label: level.label,
                  selected: level.id === accessLevel,
                  disabled: claudeCode && level.id === "ask",
                  description: claudeCode && level.id === "ask"
                    ? "Claude Code print mode cannot surface interactive approvals; choose read-only or full access."
                    : undefined,
                }))}
                onSelect={(id) => onSetAccess(id as AccessLevel)}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

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
              disabled={workspaceBusy || activeScopeSnapshot.submissionPending || (text.trim().length === 0 && attachments.length === 0)}
              onClick={() => submitCurrent()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>

      {preview ? (
        <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onMouseDown={() => setPreviewId(undefined)}>
          <figure onMouseDown={(event) => event.stopPropagation()}>
            <button aria-label="Close preview" onClick={() => setPreviewId(undefined)}><X size={18} /></button>
            <img src={preview.previewUrl} alt={preview.name} />
            <figcaption>{preview.name}</figcaption>
          </figure>
        </div>
      ) : null}

      {modelPickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setModelPickerOpen(false)}
        />
      ) : null}

      <WorkspaceBar
        info={workspace}
        busy={workspaceBusy}
        onOpenWorktree={onOpenWorktree}
        onCreateWorktree={onCreateWorktree}
        onSwitchRef={onSwitchRef}
      />
      </div>
    </footer>
  );
}
