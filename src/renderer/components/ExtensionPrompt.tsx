import { ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";
import { useEffect, useState } from "react";
import type { ExtensionUiPrompt, UiQuestionnaireQuestion } from "../../shared/contracts";
import { choiceOptions, freeTextOption, splitInputTitle, splitOption, splitPromptTitle } from "../../shared/extension-prompt-options";

/** What the user picked (or pre-picked) for one question of a questionnaire. */
export interface QuestionnaireChoice {
  /** One label for a single choice, several for a multi-select, free text as one entry. */
  labels: string[];
  /** Sent to the extension already; a pre-pick is still waiting for its turn. */
  answered: boolean;
}

export function choiceSummary(choice: QuestionnaireChoice): string {
  return choice.labels.join(", ");
}

/** Multi-select answers travel as 1-based option numbers, the way the tool reads them. */
export function multiSelectValue(question: UiQuestionnaireQuestion, labels: readonly string[]): string {
  return question.options
    .map((option, index) => labels.includes(option.label) ? String(index + 1) : undefined)
    .filter((entry): entry is string => Boolean(entry))
    .join(",");
}

function OptionRow({
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

function toggled(labels: readonly string[], label: string): string[] {
  return labels.includes(label) ? labels.filter((entry) => entry !== label) : [...labels, label];
}

/**
 * A blocking extension question, shown in the composer's own stack so it reads as
 * part of this thread. Other threads keep running, so this deliberately is not a
 * modal. When the question is one of several, the header pages through them:
 * earlier pages show what was answered, later ones take a pick ahead of time.
 */
export function ExtensionPrompt({
  prompt,
  pending,
  choices = {},
  onAnswer,
  onCancel,
  onPreselect,
}: {
  prompt: ExtensionUiPrompt;
  /** Further questions queued behind this one. */
  pending: number;
  /** Picks per question index for this questionnaire. */
  choices?: Record<number, QuestionnaireChoice>;
  onAnswer(value: string | boolean): void;
  onCancel(): void;
  /** Records picks for a question the extension has not asked yet. */
  onPreselect?(index: number, labels: string[]): void;
}) {
  // A question Pi asks in its own terminal cannot be answered here; offering
  // buttons and an input would be a lie.
  const elsewhere = prompt.answerElsewhere === true;
  const questionnaire = prompt.questionnaire;
  const total = questionnaire?.questions.length ?? 1;
  const current = questionnaire?.index ?? 0;
  const [page, setPage] = useState(current);
  // Picks gathered on the current multi-select page before they are sent.
  const [picked, setPicked] = useState<string[]>([]);
  // A new prompt lands on its own question, wherever the user was browsing.
  useEffect(() => { setPage(current); setPicked([]); }, [prompt.id, current]);
  const viewing = questionnaire?.questions[page];
  const onCurrent = !questionnaire || page === current;
  const asked = questionnaire?.questions[current];
  // The tool asks a multi-select as a free-text input listing the options; with
  // the questionnaire in hand they can be rows again.
  const multi = Boolean(asked?.multiSelect && prompt.kind === "input");
  const hasChoices = !elsewhere && (prompt.kind === "confirm" || prompt.kind === "select" || multi);
  // The composer below is the free-text answer; a row saying the same is noise.
  const currentChoices = choiceOptions(prompt.options);
  const acceptsFreeText = Boolean(freeTextOption(prompt.options)) || multi;

  const folded = prompt.kind === "select" ? splitPromptTitle(prompt.title) : { question: prompt.title, previews: [] };
  const input = prompt.kind === "input" ? splitInputTitle(prompt.title) : undefined;
  const title = viewing
    ? `${viewing.header ? `[${viewing.header}] ` : ""}${viewing.question}`
    : input?.question ?? folded.question;
  // What the tool folded into an input title is shown as message text, except
  // the option list a multi-select renders as rows anyway.
  const message = onCurrent ? (prompt.message ?? (input && !multi ? input.detail : undefined)) : undefined;
  const pick = choices[page];

  return (
    <section className="extension-prompt" aria-label="Question from an extension">
      <header>
        <span className="extension-prompt-mark"><CircleHelp size={13} /></span>
        <strong title={title}>{title}</strong>
        {pending > 0 ? <small>{pending} more</small> : null}
        <span className="spacer" />
        {questionnaire && total > 1 ? (
          <nav className="extension-pager" aria-label="Questions">
            <button type="button" aria-label="Previous question" disabled={page === 0} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={13} />
            </button>
            <span>{page + 1}/{total}</span>
            <button type="button" aria-label="Next question" disabled={page >= total - 1} onClick={() => setPage(page + 1)}>
              <ChevronRight size={13} />
            </button>
          </nav>
        ) : null}
      </header>

      {message ? <p className="extension-prompt-message">{message}</p> : null}

      {onCurrent && hasChoices ? (
        <div className="extension-prompt-options">
          {prompt.kind === "confirm" ? (
            <>
              <OptionRow label="Yes" onPick={() => onAnswer(true)} />
              <OptionRow label="No" onPick={() => onAnswer(false)} />
            </>
          ) : multi && asked ? (
            asked.options.map((option, at) => (
              <OptionRow
                key={option.label}
                index={String(at + 1)}
                label={option.label}
                detail={option.description}
                chosen={picked.includes(option.label)}
                onPick={() => setPicked((value) => toggled(value, option.label))}
              />
            ))
          ) : (
            currentChoices.map((option) => {
              const { index, label, detail } = splitOption(option);
              const preview = folded.previews.find((entry) => String(entry.index) === index)?.text;
              return <OptionRow key={option} index={index} label={label} detail={detail} preview={preview} onPick={() => onAnswer(option)} />;
            })
          )}
        </div>
      ) : null}

      {!onCurrent && viewing ? (
        <div className="extension-prompt-options">
          {viewing.options.map((option, at) => (
            <OptionRow
              key={option.label}
              index={String(at + 1)}
              label={option.label}
              detail={option.description}
              chosen={pick?.labels.includes(option.label)}
              readOnly={page < current}
              onPick={page > current
                ? () => onPreselect?.(page, viewing.multiSelect ? toggled(pick?.labels ?? [], option.label) : [option.label])
                : undefined}
            />
          ))}
        </div>
      ) : null}

      <footer>
        <span>
          {elsewhere
            ? "answer in Pi's terminal"
            : !onCurrent && page < current
              ? (pick ? `answered: ${choiceSummary(pick)}` : "answered")
              : !onCurrent
                ? (pick && pick.labels.length > 0
                  ? `“${choiceSummary(pick)}” is sent when the extension gets here`
                  : `pick ${viewing?.multiSelect ? "any" : "one"} now — it is sent when the extension gets here`)
                : multi
                  ? "pick any that apply, or type your own answer below"
                  : hasChoices
                    ? (acceptsFreeText ? "or type your own answer below" : "or answer below")
                    : "answer below"}
        </span>
        <span className="spacer" />
        {onCurrent && multi && asked ? (
          <button className="primary" disabled={picked.length === 0} onClick={() => onAnswer(multiSelectValue(asked, picked))}>
            Send{picked.length > 0 ? ` ${picked.length}` : ""}
          </button>
        ) : null}
        {elsewhere ? null : <button onClick={onCancel}>Skip</button>}
      </footer>
    </section>
  );
}
