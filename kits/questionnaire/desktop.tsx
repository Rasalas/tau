import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ExtensionPromptFrame,
  OptionRow,
  choiceOptions,
  optionForLabel,
  splitInputTitle,
  splitOption,
  splitPromptTitle,
  usePromptSubmit,
  type DesktopExtension,
  type ExtensionUiAnswer,
  type ExtensionUiPrompt,
  type PromptRendererProps,
} from "tau";
import { QUESTIONNAIRE_HOST_EXTENSION_ID, questionnaireOf, type UiQuestionnaireQuestion } from "./protocol.js";

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

const key = (sessionId: string, index: number) => `${sessionId}:${index}`;

/**
 * Picks per questionnaire question, keyed by thread and index. A pick for a
 * question the extension has not reached yet is sent the moment it asks.
 */
export class QuestionnaireStore {
  private choices: Record<string, QuestionnaireChoice> = {};
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): Record<string, QuestionnaireChoice> => this.choices;

  choice(sessionId: string, index: number): QuestionnaireChoice | undefined {
    return this.choices[key(sessionId, index)];
  }

  set(sessionId: string, index: number, choice: QuestionnaireChoice): void {
    this.choices = { ...this.choices, [key(sessionId, index)]: choice };
    this.listeners.forEach((listener) => listener());
  }

  /** A fresh questionnaire: picks left from an earlier one in this thread are stale. */
  clear(sessionId: string): void {
    this.choices = Object.fromEntries(Object.entries(this.choices).filter(([entry]) => !entry.startsWith(`${sessionId}:`)));
    this.listeners.forEach((listener) => listener());
  }

  /** The answer a pre-pick gives this prompt, if the pick fits the question's shape. */
  intercept(prompt: ExtensionUiPrompt): ExtensionUiAnswer | undefined {
    const questionnaire = questionnaireOf(prompt);
    if (!questionnaire) return undefined;
    if (questionnaire.index === 0) {
      this.clear(prompt.sessionId);
      return undefined;
    }
    const pick = this.choice(prompt.sessionId, questionnaire.index);
    if (!pick || pick.answered || pick.labels.length === 0) return undefined;
    const question = questionnaire.questions[questionnaire.index];
    const value = prompt.kind === "select"
      ? optionForLabel(prompt.options, pick.labels[0])
      : prompt.kind === "input" && question?.multiSelect
        ? multiSelectValue(question, pick.labels)
        : undefined;
    if (!value) return undefined;
    this.set(prompt.sessionId, questionnaire.index, { labels: pick.labels, answered: true });
    return { value };
  }

  /** Keeps the labels of what was sent, for the page summary. */
  answered(prompt: ExtensionUiPrompt, answer: ExtensionUiAnswer): void {
    const questionnaire = questionnaireOf(prompt);
    if (!questionnaire || !("value" in answer)) return;
    const question = questionnaire.questions[questionnaire.index];
    // Multi-select answers are option numbers; keep the labels for the page summary.
    const labels = answer.typed
      ? [answer.value]
      : prompt.kind === "input" && question?.multiSelect
        ? answer.value.split(/[,\s]+/u).flatMap((token) => {
          const option = question.options[Number(token) - 1];
          return option ? [option.label] : [];
        })
        : [splitOption(answer.value).label];
    this.set(prompt.sessionId, questionnaire.index, { labels: labels.length > 0 ? labels : [answer.value], answered: true });
  }
}

function toggled(labels: readonly string[], label: string): string[] {
  return labels.includes(label) ? labels.filter((entry) => entry !== label) : [...labels, label];
}

export function createQuestionnairePrompt(store: QuestionnaireStore) {
  /**
   * One question of several: the header pages through them, earlier pages show
   * what was answered, later ones take a pick ahead of time.
   */
  return function QuestionnairePrompt({ prompt, pending, asker, agent, onAnswer, onCancel }: PromptRendererProps) {
    const choices = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const questionnaire = questionnaireOf(prompt)!;
    const total = questionnaire.questions.length;
    const current = questionnaire.index;
    const [page, setPage] = useState(current);
    // Picks gathered on the current multi-select page before they are sent.
    const [picked, setPicked] = useState<string[]>([]);
    // The option string a single choice will send; Answer sends it (design 1c).
    const [single, setSingle] = useState<string>();
    // A new prompt lands on its own question, wherever the user was browsing.
    useEffect(() => { setPage(current); setPicked([]); setSingle(undefined); }, [prompt.id, current]);
    const viewing = questionnaire.questions[page];
    const onCurrent = page === current;
    const asked = questionnaire.questions[current];
    // The tool asks a multi-select as a free-text input listing the options; with
    // the questionnaire in hand they can be rows again.
    const multi = Boolean(asked?.multiSelect && prompt.kind === "input");
    const hasChoices = prompt.kind === "select" || multi;
    const currentChoices = choiceOptions(prompt.options);
    const folded = prompt.kind === "select" ? splitPromptTitle(prompt.title) : { question: prompt.title, previews: [] };
    const input = prompt.kind === "input" ? splitInputTitle(prompt.title) : undefined;
    const title = viewing?.question ?? input?.question ?? folded.question;
    // A sub-agent is named; otherwise the question's topic names it better than the model does.
    const from = agent ?? (viewing?.header || asker);
    const message = onCurrent ? (prompt.message ?? (input && !multi ? input.detail : undefined)) : undefined;
    const pick = choices[key(prompt.sessionId, page)];
    const preselect = (index: number, labels: string[]) => store.set(prompt.sessionId, index, { labels, answered: false });
    const chosen = single !== undefined && currentChoices.includes(single) ? single : undefined;
    const submitPicked = useCallback(() => {
      if (multi && asked && picked.length > 0) onAnswer(multiSelectValue(asked, picked));
      else if (!multi && chosen !== undefined) onAnswer(chosen);
    }, [asked, chosen, multi, onAnswer, picked]);
    const sendLabel = !onCurrent || !hasChoices ? undefined : multi ? `Send${picked.length > 0 ? ` ${picked.length}` : ""}` : "Answer";
    const nothing = multi ? picked.length === 0 : chosen === undefined;
    usePromptSubmit(sendLabel, nothing, submitPicked);

    return (
      <ExtensionPromptFrame
        title={title}
        pending={pending}
        message={message}
        {...(from ? { from } : {})}
        {...(viewing && viewing.options.length > 0 ? { pick: viewing.multiSelect ? "any" as const : "one" as const } : {})}
        {...(sendLabel ? { submit: { label: sendLabel, disabled: nothing, enter: true, onSubmit: submitPicked } } : {})}
        header={<>
          {total > 1 ? (
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
        </>}
        hint={!onCurrent && page < current
          ? (pick ? `Answered: ${choiceSummary(pick)}` : "Answered")
          : !onCurrent
            ? (pick && pick.labels.length > 0
              ? `“${choiceSummary(pick)}” is sent when the extension gets here`
              : viewing && viewing.options.length === 0
                ? "Answered below when the extension gets here"
                : "Pick now; it is sent when the extension gets here")
            : hasChoices
              ? "Or type an answer below"
              : "Type your answer below"}
        footer={<button onClick={onCancel}>Skip</button>}
      >
        {onCurrent && hasChoices ? (
          <div className="extension-prompt-options">
            {multi && asked ? (
              asked.options.map((option) => (
                <OptionRow
                  key={option.label}
                  label={option.label}
                  detail={option.description}
                  mode="checkbox"
                  chosen={picked.includes(option.label)}
                  onPick={() => setPicked((value) => toggled(value, option.label))}
                />
              ))
            ) : (
              currentChoices.map((option) => {
                const split = splitOption(option);
                const { index } = split;
                // The questionnaire knows each label whole; "Leave it — small enough" with no description is one label.
                const known = asked?.options[Number(index) - 1];
                const label = known?.label ?? split.label;
                const detail = known ? known.description || undefined : split.detail;
                const preview = folded.previews.find((entry) => String(entry.index) === index)?.text;
                return <OptionRow key={option} index={index} label={label} detail={detail} preview={preview} mode="radio" chosen={option === chosen} onPick={() => setSingle(option)} />;
              })
            )}
          </div>
        ) : null}
        {!onCurrent && viewing ? (
          <div className="extension-prompt-options">
            {viewing.options.map((option) => (
              <OptionRow
                key={option.label}
                label={option.label}
                detail={option.description}
                mode={viewing.multiSelect ? "checkbox" : "radio"}
                chosen={pick?.labels.includes(option.label)}
                readOnly={page < current}
                onPick={page > current
                  ? () => preselect(page, viewing.multiSelect ? toggled(pick?.labels ?? [], option.label) : [option.label])
                  : undefined}
              />
            ))}
          </div>
        ) : null}
      </ExtensionPromptFrame>
    );
  };
}

/** Questionnaire Kit's desktop half: pages through the ask-user tool's questions. */
export function createQuestionnaireExtension(store = new QuestionnaireStore()): DesktopExtension {
  return {
    id: QUESTIONNAIRE_HOST_EXTENSION_ID,
    name: "Questionnaires",
    activate(plugin) {
      plugin.registerPromptRenderer({
        id: "questionnaire",
        profiles: ["desktop", "web", "compact"],
        match: (prompt) => prompt.answerElsewhere !== true && questionnaireOf(prompt) !== undefined,
        Component: createQuestionnairePrompt(store),
        intercept: (prompt) => store.intercept(prompt),
        onAnswered: (prompt, answer) => store.answered(prompt, answer),
      });
    },
  };
}

export const questionnaireExtension = createQuestionnaireExtension();

export default questionnaireExtension;
