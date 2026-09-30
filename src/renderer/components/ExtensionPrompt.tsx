import { Check, CircleHelp, Pencil, SquareTerminal, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ExtensionUiPrompt } from "../../shared/contracts";
import { choiceOptions, splitInputTitle, splitOption, splitPromptTitle } from "../../shared/extension-prompt-options";

import { usePromptSubmit } from "./prompt-submit";

// Its own module, so the composer and the `tau` module reach it without loading the dialogs.
export { PromptSubmitContext, usePromptSubmit, type PromptSubmitAction } from "./prompt-submit";

/** The words runtimes offer a tool approval in; such a select is drawn as one. */
const PERMISSION_WORDS = /^(Allow|Deny|Allow for this (session|thread))$/u;

export function OptionRow({
  label,
  detail,
  preview,
  chosen,
  readOnly,
  mode,
  onPick,
}: {
  /** The option's number as the extension wrote it; the row does not draw it. */
  index?: string;
  label: string;
  /** The second line under the label. */
  detail?: string;
  /** Markdown the model attached to compare this option. */
  preview?: string;
  chosen?: boolean;
  readOnly?: boolean;
  mode?: "radio" | "checkbox";
  onPick?(): void;
}) {
  return (
    <button
      type="button"
      className={`extension-option${mode ? ` mode-${mode}` : ""}${chosen ? " chosen" : ""}${readOnly ? " read" : ""}`}
      disabled={readOnly}
      aria-pressed={mode ? Boolean(chosen) : undefined}
      onClick={onPick}
    >
      {mode ? (
        <span className={`extension-option-indicator is-${mode}`} aria-hidden="true">
          {chosen && mode === "checkbox" ? <Check size={11} strokeWidth={3} /> : null}
        </span>
      ) : null}
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
        {preview ? <pre className="extension-option-preview">{preview}</pre> : null}
      </span>
    </button>
  );
}

/** The card's primary action: sends the picks, or approves. */
export interface PromptFrameSubmit {
  label: string;
  disabled?: boolean;
  /** Draws ⏎ beside the label: an empty composer's Enter does the same. */
  enter?: boolean;
  onSubmit(): void;
}

/**
 * The frame every question and approval shares, as the workbench design draws
 * it: a head with the kind, who asks and how many may be picked, the question,
 * its options, and a foot with the hint and the primary action.
 */
export function ExtensionPromptFrame({
  title,
  pending,
  kind = "question",
  from,
  pick,
  header,
  message,
  children,
  hint,
  footer,
  submit,
}: {
  title: string;
  pending: number;
  kind?: "question" | "approval";
  /** Who asks: the thread's agent, a sub-agent, or the question's topic. */
  from?: string;
  /** How many options may be chosen. */
  pick?: "one" | "any";
  header?: ReactNode;
  message?: string;
  children?: ReactNode;
  hint: string;
  footer?: ReactNode;
  submit?: PromptFrameSubmit;
}) {
  const approval = kind === "approval";
  // An approval names its action in the head, its path or command beside it (design 1a/1f).
  const inline = approval && message && !message.includes("\n") ? message : undefined;
  const kindLabel = approval ? title : "Question";
  return (
    <section className={`extension-prompt is-${kind}`} aria-label={from ? `${kindLabel} from ${from}` : kindLabel}>
      <header>
        <span className="extension-prompt-kind">
          {approval && /\b(edit|write)/iu.test(title) ? <Pencil size={11} aria-hidden="true" />
            : approval && /\b(run|command)/iu.test(title) ? <SquareTerminal size={11} aria-hidden="true" /> : <CircleHelp size={11} aria-hidden="true" />}
          {kindLabel}
        </span>
        {from ? <span className="extension-prompt-from" title={from}>{from}</span> : null}
        {inline ? <code className="extension-prompt-subject" title={inline}>{inline}</code> : null}
        {pending > 0 ? <small>{pending} more</small> : null}
        <span className="spacer" />
        {header}
        {pick ? <span className="extension-prompt-pick">pick {pick}</span> : null}
      </header>
      {approval ? null : <p className="extension-prompt-title">{title}</p>}
      {message && !inline ? approval
        ? <code className="extension-prompt-subject">{message}</code>
        : <p className="extension-prompt-message">{message}</p> : null}
      {children}
      <footer>
        {hint ? <span>{hint}</span> : null}
        <span className="spacer" />
        {footer}
        {submit ? (
          <button type="button" className="extension-prompt-send" disabled={submit.disabled} onClick={submit.onSubmit}>
            <Check size={11} aria-hidden="true" />
            {submit.label}
            {submit.enter ? <kbd aria-hidden="true">⏎</kbd> : null}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

/**
 * A blocking extension question, shown in the composer's own stack so it reads as
 * part of this thread. Other threads keep running, so this deliberately is not a
 * modal. Extensions may take over prompts they recognise (`registerPromptRenderer`).
 */
export function ExtensionPrompt({
  prompt,
  pending,
  asker,
  agent,
  onAnswer,
  onCancel,
}: {
  prompt: ExtensionUiPrompt;
  /** Further questions queued behind this one. */
  pending: number;
  /** Who asks, as the composer knows it. */
  asker?: string;
  /** The sub-agent that asks, when the question is a child thread's. */
  agent?: string | undefined;
  onAnswer(value: string | boolean): void;
  onCancel(): void;
}) {
  // A question Pi asks in its own terminal cannot be answered here; offering
  // buttons and an input would be a lie.
  const elsewhere = prompt.answerElsewhere === true;
  const options = prompt.options ?? [];
  // A yes-or-no question, or a runtime's Allow / Deny, is an approval.
  const permission = !elsewhere && prompt.kind === "select" && options.includes("Deny") && options.every((option) => PERMISSION_WORDS.test(option));
  const approval = prompt.kind === "confirm" || permission;
  const hasChoices = !elsewhere && prompt.kind === "select" && !permission;
  // The composer below is the free-text answer; a row saying the same is noise.
  const currentChoices = choiceOptions(prompt.options);
  const [picked, setPicked] = useState<string>();
  const chosen = currentChoices.includes(picked!) ? picked : undefined;
  const action = elsewhere ? undefined : approval ? "Allow" : hasChoices ? "Answer" : undefined;
  const waiting = hasChoices && chosen === undefined;
  // A confirm answers true, a runtime's approval its own word.
  const submit = () => onAnswer(approval ? !permission || "Allow" : chosen!);
  // Enter in the empty composer does what the card's ⏎ says.
  usePromptSubmit(action, waiting, submit);

  const folded = prompt.kind === "select" ? splitPromptTitle(prompt.title) : { question: prompt.title, previews: [] };
  const input = prompt.kind === "input" ? splitInputTitle(prompt.title) : undefined;
  const title = input?.question ?? folded.question;
  // What the tool folded into an input title is shown as message text.
  const message = prompt.message ?? input?.detail;
  const always = options.find((option) => option.startsWith("Allow for"));
  // The thread's own model heads a question; an approval names only a sub-agent (design 1a).
  const from = agent ?? (approval ? undefined : asker);

  return (
    <ExtensionPromptFrame
      title={title}
      pending={pending}
      kind={approval ? "approval" : "question"}
      {...(from ? { from } : {})}
      {...(hasChoices ? { pick: "one" as const } : {})}
      message={message}
      hint={elsewhere
        ? "Answer in Pi's terminal"
        : approval ? ""
          : hasChoices ? "Or type an answer below"
            : prompt.kind === "input" || prompt.kind === "editor" ? "Type your answer below; attached files go with it" : "Answer below"}
      footer={elsewhere ? null : approval
        ? <>
          <button type="button" onClick={() => onAnswer(permission ? "Deny" : false)}><X size={11} aria-hidden="true" />Deny</button>
          {always ? <button type="button" onClick={() => onAnswer(always)}>Always for this thread</button> : null}
        </>
        : <button type="button" onClick={onCancel}>Skip</button>}
      {...(action ? { submit: { label: action, enter: true, disabled: waiting, onSubmit: submit } } : {})}
    >
      {hasChoices ? (
        <div className="extension-prompt-options">
          {currentChoices.map((option) => {
            const { index, label, detail } = splitOption(option);
            const preview = folded.previews.find((entry) => String(entry.index) === index)?.text;
            return <OptionRow key={option} label={label} detail={detail} preview={preview} mode="radio" chosen={option === chosen} onPick={() => setPicked(option)} />;
          })}
        </div>
      ) : null}
      {prompt.kind === "custom" && prompt.lines && prompt.lines.length > 0 ? (
        <pre className="extension-prompt-custom">{prompt.lines.join("\n")}</pre>
      ) : null}
    </ExtensionPromptFrame>
  );
}
