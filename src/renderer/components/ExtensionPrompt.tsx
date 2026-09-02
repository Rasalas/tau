import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import type { ExtensionUiPrompt } from "../../shared/contracts";
import { choiceOptions, freeTextOption, splitInputTitle, splitOption, splitPromptTitle } from "../../shared/extension-prompt-options";

export function OptionRow({
  index,
  label,
  detail,
  preview,
  chosen,
  readOnly,
  onPick,
}: {
  index?: string;
  label: string;
  detail?: string;
  /** Markdown the model attached to compare this option — a mockup, a snippet. */
  preview?: string;
  chosen?: boolean;
  readOnly?: boolean;
  onPick?(): void;
}) {
  return (
    <button
      className={`extension-option${chosen ? " chosen" : ""}${readOnly ? " read" : ""}`}
      disabled={readOnly}
      onClick={onPick}
    >
      {index ? <i>{index}</i> : <i className="bullet">›</i>}
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
        {preview ? <pre className="extension-option-preview">{preview}</pre> : null}
      </span>
    </button>
  );
}

/** The frame every prompt shares: mark, title, queue count, header extras, body, footer. */
export function ExtensionPromptFrame({
  title,
  pending,
  header,
  message,
  children,
  hint,
  footer,
}: {
  title: string;
  pending: number;
  header?: ReactNode;
  message?: string;
  children?: ReactNode;
  hint: string;
  footer?: ReactNode;
}) {
  return (
    <section className="extension-prompt" aria-label="Question from an extension">
      <header>
        <span className="extension-prompt-mark"><CircleHelp size={13} /></span>
        <strong title={title}>{title}</strong>
        {pending > 0 ? <small>{pending} more</small> : null}
        <span className="spacer" />
        {header}
      </header>
      {message ? <p className="extension-prompt-message">{message}</p> : null}
      {children}
      <footer>
        <span>{hint}</span>
        <span className="spacer" />
        {footer}
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
  onAnswer,
  onCancel,
}: {
  prompt: ExtensionUiPrompt;
  /** Further questions queued behind this one. */
  pending: number;
  onAnswer(value: string | boolean): void;
  onCancel(): void;
}) {
  // A question Pi asks in its own terminal cannot be answered here; offering
  // buttons and an input would be a lie.
  const elsewhere = prompt.answerElsewhere === true;
  const hasChoices = !elsewhere && (prompt.kind === "confirm" || prompt.kind === "select");
  // The composer below is the free-text answer; a row saying the same is noise.
  const currentChoices = choiceOptions(prompt.options);
  const acceptsFreeText = Boolean(freeTextOption(prompt.options));

  const folded = prompt.kind === "select" ? splitPromptTitle(prompt.title) : { question: prompt.title, previews: [] };
  const input = prompt.kind === "input" ? splitInputTitle(prompt.title) : undefined;
  const title = input?.question ?? folded.question;
  // What the tool folded into an input title is shown as message text.
  const message = prompt.message ?? input?.detail;

  return (
    <ExtensionPromptFrame
      title={title}
      pending={pending}
      message={message}
      hint={elsewhere
        ? "answer in Pi's terminal"
        : hasChoices
          ? (acceptsFreeText ? "or type your own answer below" : "or answer below")
          : "answer below"}
      footer={elsewhere ? null : <button onClick={onCancel}>Skip</button>}
    >
      {hasChoices ? (
        <div className="extension-prompt-options">
          {prompt.kind === "confirm" ? (
            <>
              <OptionRow label="Yes" onPick={() => onAnswer(true)} />
              <OptionRow label="No" onPick={() => onAnswer(false)} />
            </>
          ) : (
            currentChoices.map((option) => {
              const { index, label, detail } = splitOption(option);
              const preview = folded.previews.find((entry) => String(entry.index) === index)?.text;
              return <OptionRow key={option} index={index} label={label} detail={detail} preview={preview} onPick={() => onAnswer(option)} />;
            })
          )}
        </div>
      ) : null}
    </ExtensionPromptFrame>
  );
}
