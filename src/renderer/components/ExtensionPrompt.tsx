import { Check, CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import type { ExtensionUiPrompt } from "../../shared/contracts";
import { choiceOptions, splitInputTitle, splitOption, splitPromptTitle } from "../../shared/extension-prompt-options";

// Its own module, so the composer and the `tau` module reach it without loading the dialogs.
export { PromptSubmitContext, usePromptSubmit, type PromptSubmitAction } from "./prompt-submit";

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
  const kindLabel = kind === "approval" ? "Approval" : "Question";
  return (
    <section className={`extension-prompt is-${kind}`} aria-label={from ? `${kindLabel} from ${from}` : kindLabel}>
      <header>
        <span className="extension-prompt-kind"><CircleHelp size={13} aria-hidden="true" />{kindLabel}</span>
        {from ? <span className="extension-prompt-from" title={from}>{from}</span> : null}
        {pending > 0 ? <small>{pending} more</small> : null}
        <span className="spacer" />
        {header}
        {pick ? <span className="extension-prompt-pick">pick {pick}</span> : null}
      </header>
      <p className="extension-prompt-title">{title}</p>
      {message ? kind === "approval"
        ? <code className="extension-prompt-subject">{message}</code>
        : <p className="extension-prompt-message">{message}</p> : null}
      {children}
      <footer>
        {hint ? <span>{hint}</span> : null}
        <span className="spacer" />
        {footer}
        {submit ? (
          <button type="button" className="extension-prompt-send" disabled={submit.disabled} onClick={submit.onSubmit}>
            <Check size={14} aria-hidden="true" />
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
  onAnswer,
  onCancel,
}: {
  prompt: ExtensionUiPrompt;
  /** Further questions queued behind this one. */
  pending: number;
  /** Who asks, as the composer knows it. */
  asker?: string;
  onAnswer(value: string | boolean): void;
  onCancel(): void;
}) {
  // A question Pi asks in its own terminal cannot be answered here; offering
  // buttons and an input would be a lie.
  const elsewhere = prompt.answerElsewhere === true;
  // A yes-or-no question is an approval: Approve and Decline, as T3 Code draws one.
  const approval = prompt.kind === "confirm";
  const hasChoices = !elsewhere && prompt.kind === "select";
  // The composer below is the free-text answer; a row saying the same is noise.
  const currentChoices = choiceOptions(prompt.options);

  const folded = prompt.kind === "select" ? splitPromptTitle(prompt.title) : { question: prompt.title, previews: [] };
  const input = prompt.kind === "input" ? splitInputTitle(prompt.title) : undefined;
  const title = input?.question ?? folded.question;
  // What the tool folded into an input title is shown as message text.
  const message = prompt.message ?? input?.detail;

  return (
    <ExtensionPromptFrame
      title={title}
      pending={pending}
      kind={approval ? "approval" : "question"}
      {...(asker ? { from: asker } : {})}
      {...(hasChoices ? { pick: "one" as const } : {})}
      message={message}
      hint={elsewhere
        ? "Answer in Pi's terminal"
        : approval ? ""
          : hasChoices ? "Or type an answer below"
            : prompt.kind === "input" || prompt.kind === "editor" ? "Type your answer below; attached files go with it" : "Answer below"}
      footer={elsewhere ? null : approval
        ? <button type="button" onClick={() => onAnswer(false)}>Decline</button>
        : <button type="button" onClick={onCancel}>Skip</button>}
      {...(approval && !elsewhere ? { submit: { label: "Approve", onSubmit: () => onAnswer(true) } } : {})}
    >
      {hasChoices ? (
        <div className="extension-prompt-options">
          {currentChoices.map((option) => {
            const { index, label, detail } = splitOption(option);
            const preview = folded.previews.find((entry) => String(entry.index) === index)?.text;
            return <OptionRow key={option} label={label} detail={detail} preview={preview} mode="radio" onPick={() => onAnswer(option)} />;
          })}
        </div>
      ) : null}
      {prompt.kind === "custom" && prompt.lines && prompt.lines.length > 0 ? (
        <div className="extension-prompt-custom">
          <pre style={{ margin: "8px 0", padding: "8px", background: "var(--code-bg)", borderRadius: "var(--radius-sm)", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.4" }}>
            {prompt.lines.join("\n")}
          </pre>
        </div>
      ) : null}
    </ExtensionPromptFrame>
  );
}
