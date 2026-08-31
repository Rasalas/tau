import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowUp, ChevronDown, CornerDownRight, Lock, LockOpen, Paperclip, Sparkles, X, Zap } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, ServiceTier, UiComposerCommand, UiContextUsage, UiPromptAttachment, WorkspaceInfo } from "../../shared/contracts";
import { ACCESS_LEVELS, type AccessLevel } from "../preferences";
import { ContextMeter, type ContextBreakdown } from "./ContextMeter";
import { Menu } from "./Menu";
import { ModelPicker, modelKey } from "./ModelPicker";
import { ExtensionPrompt, type QuestionnaireChoice } from "./ExtensionPrompt";
import { WorkspaceBar } from "./WorkspaceBar";
import { TaskProgress } from "./TaskProgress";
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

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
let nextAttachmentId = 0;

type PendingAttachment = UiPromptAttachment & { id: number; previewUrl: string };

type ComposerTrigger = { kind: "/" | "$"; query: string; start: number; end: number };

function skillName(command: UiComposerCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

export function composerTrigger(text: string, caret: number): ComposerTrigger | undefined {
  const before = text.slice(0, caret);
  const match = /^\s*([/$])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
  const start = before.lastIndexOf(match[1]);
  return { kind: match[1] as "/" | "$", query: match[2], start, end: caret };
}

export function normalizeSkillInvocation(text: string, commands: readonly UiComposerCommand[]): string {
  const match = /^(\s*)([$/])([^\s]+)(?=\s|$)/u.exec(text);
  if (!match) return text;
  const requested = match[3];
  const skill = commands.find((command) => command.source === "skill" && skillName(command) === requested);
  if (!skill) return text;
  if (match[2] === "/" && commands.some((command) => command.source !== "skill" && command.name === requested)) return text;
  return `${match[1]}/skill:${requested}${text.slice(match[0].length)}`;
}

function readImage(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      reject(new Error(`${file.name} is not a supported PNG, JPEG, GIF, or WebP image.`));
      return;
    }
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name} must be 10 MB or smaller.`));
      return;
    }
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
        id: nextAttachmentId++,
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
  value,
  seed,
  draftStorageKey,
  queue,
  accessLevel,
  contextUsage,
  contextBreakdown,
  textareaRef,
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
  value?: string;
  seed?: string;
  draftStorageKey?: string;
  queue: string[];
  accessLevel: AccessLevel;
  contextUsage?: UiContextUsage;
  contextBreakdown: ContextBreakdown;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange?(value: string): void;
  onSubmit(text?: string, attachments?: UiPromptAttachment[]): void;
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
  const [draft, setDraft] = useState(() => readComposerDraft(window.localStorage, draftStorageKey));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [previewId, setPreviewId] = useState<number>();
  const [caret, setCaret] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const preserveDraftForWorkspaceRef = useRef(false);
  if (workspaceBusy) preserveDraftForWorkspaceRef.current = true;
  const text = value ?? draft;
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
    if (value !== undefined) return;
    if (preserveDraftForWorkspaceRef.current && draft) {
      writeComposerDraft(window.localStorage, draftStorageKey, draft);
    } else {
      setDraft(readComposerDraft(window.localStorage, draftStorageKey));
    }
    preserveDraftForWorkspaceRef.current = false;
  }, [draftStorageKey, value]);
  useEffect(() => {
    if (seed !== undefined && value === undefined && seed !== appliedSeed.current) {
      appliedSeed.current = seed;
      setDraft(seed);
    }
  }, [seed, value]);
  const updateDraft = (next: string) => {
    if (value === undefined) {
      setDraft(next);
      writeComposerDraft(window.localStorage, draftStorageKey, next);
    }
    onChange?.(next);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const fastTier = snapshot?.serviceTier === "fast";
  const tierAvailable = Boolean(snapshot?.serviceTierAvailable);
  const streaming = Boolean(snapshot?.isStreaming);
  const accessLabel = ACCESS_LEVELS.find((level) => level.id === accessLevel)?.label ?? accessLevel;
  const preview = attachments.find((attachment) => attachment.id === previewId);

  const addFiles = async (files: FileList | readonly File[]) => {
    const available = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const candidates = Array.from(files).slice(0, available);
    if (candidates.length < files.length) setAttachmentError(`Attach at most ${MAX_ATTACHMENTS} images.`);
    const results = await Promise.allSettled(candidates.map(readImage));
    const accepted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejection) setAttachmentError(rejection.reason instanceof Error ? rejection.reason.message : String(rejection.reason));
    else if (candidates.length === files.length) setAttachmentError(undefined);
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted].slice(0, MAX_ATTACHMENTS));
  };

  // An editor prompt arrives with text to edit; seed the field once.
  const seededPromptRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prompt || seededPromptRef.current === prompt.id) return;
    seededPromptRef.current = prompt.id;
    if (prompt.prefill) updateDraft(prompt.prefill);
  }, [prompt, updateDraft]);

  const answerable = prompt && prompt.answerElsewhere !== true;
  const submitCurrent = () => {
    if (workspaceBusy) return;
    if (answerable && prompt) {
      if (!text.trim()) return;
      onAnswerPrompt?.(text, true);
      updateDraft("");
      return;
    }
    if (!text.trim() && attachments.length === 0) return;
    onSubmit(
      normalizeSkillInvocation(text, commands),
      attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment),
    );
    updateDraft("");
    setAttachments([]);
    setAttachmentError(undefined);
    setPreviewId(undefined);
  };

  return (
    <footer className="composer-zone">
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
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
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
              submitCurrent();
            }
          }}
          placeholder={
            answerable && prompt
              ? prompt.placeholder ?? "Answer yourself — ↵ sends it back to the extension"
              : streaming
                ? "Steer the run — ↵ queues it for the agent"
                : "Direct the agent — $ skills, / commands, @ files, ⇧↵ newline"
          }
        />

        <div className="composer-toolbar">
          <button className="runtime-chip" onClick={() => setModelPickerOpen(true)}>
            <Sparkles size={13} className="accent" />
            {snapshot?.model?.name ?? "select model"}
            <ChevronDown size={12} className="chev" />
          </button>

          <span className="menu-anchor">
            <button className="runtime-chip" onClick={() => setMenu(menu === "thinking" ? undefined : "thinking")}>
              <Zap size={13} />
              {snapshot?.thinkingLevel ?? "—"}
              {fastTier ? <i className="tier-mark">fast</i> : null}
              <ChevronDown size={12} className="chev" />
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

          <span className="menu-anchor">
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
                }))}
                onSelect={(id) => onSetAccess(id as AccessLevel)}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="spacer" />

          <button className="attach-button" type="button" title="Attach files" aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>
            <Paperclip size={17} />
          </button>
          <input
            ref={fileInputRef}
            className="attachment-input"
            aria-label="Choose attachment files"
            type="file"
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
              disabled={workspaceBusy || (text.trim().length === 0 && attachments.length === 0)}
              onClick={submitCurrent}
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
    </footer>
  );
}
