/**
 * Extension questionnaires append a "type your own answer" row to every select,
 * localized per the extension's active language. Tau's composer already is that
 * free-text answer, so the row is folded into it: hidden from the choices, and
 * chosen on the user's behalf when they type instead of clicking.
 */
const FREE_TEXT_LABELS = [
  "Type something.",
  "Schreibe etwas.",
  "Escribe algo.",
  "Écrivez quelque chose.",
  "Digite algo.",
  "Escreva algo.",
  "Введите что-нибудь.",
  "Введіть щось.",
  "输入内容",
];

export interface OptionParts {
  index?: string;
  label: string;
  detail?: string;
}

/**
 * Extensions hand us one string per choice, often shaped
 * "2. Commit changes — Review and commit the pending config".
 * Split it so the choice reads as a row, and fall back to the raw text.
 */
export function splitOption(raw: string): OptionParts {
  const numbered = /^\s*(\d+)[.)]\s*(.+)$/su.exec(raw);
  const index = numbered?.[1];
  const rest = (numbered?.[2] ?? raw).trim();
  const [label, ...detail] = rest.split(/\s+[—–]\s+/u);
  return { index, label: label.trim(), detail: detail.join(" — ").trim() || undefined };
}

function labelOf(option: string): string {
  return option.replace(/^\s*\d+[.)]\s*/u, "").trim();
}

export interface OptionPreview {
  /** 1-based option number the preview belongs to. */
  index: number;
  label: string;
  text: string;
}

/**
 * On RPC hosts the ask tool has no preview pane, so it appends each option's
 * preview to the select title as "--- 1. Label preview ---" blocks. Take them
 * back apart so the question stays a title and the previews sit by their options.
 */
export function splitPromptTitle(title: string): { question: string; previews: OptionPreview[] } {
  const marker = /\n\n--- (\d+)\. (.*?) preview ---\n/gu;
  const previews: OptionPreview[] = [];
  const first = marker.exec(title);
  if (!first) return { question: title, previews };
  const question = title.slice(0, first.index);
  const blocks = title.slice(first.index).split(/\n\n(?=--- \d+\. .*? preview ---\n)/u);
  for (const block of blocks) {
    const head = /^\n?--- (\d+)\. (.*?) preview ---\n([\s\S]*)$/u.exec(block);
    if (head) previews.push({ index: Number(head[1]), label: head[2], text: head[3] });
  }
  return { question, previews };
}

/**
 * Input prompts fold their instructions into the title after a blank line
 * (multi-select lists, "Type your answer:"); the first block is the question.
 */
export function splitInputTitle(title: string): { question: string; detail?: string } {
  const at = title.indexOf("\n\n");
  if (at < 0) return { question: title };
  return { question: title.slice(0, at), detail: title.slice(at + 2).trim() || undefined };
}

/** The raw option whose label matches, so a choice made ahead of time can be sent as-is. */
export function optionForLabel(options: readonly string[] | undefined, label: string): string | undefined {
  return options?.find((option) => splitOption(option).label === label);
}

/** The raw option that stands for "answer in your own words", if the select has one. */
export function freeTextOption(options: readonly string[] | undefined): string | undefined {
  return options?.find((option) => FREE_TEXT_LABELS.includes(labelOf(option)));
}

/** The options worth showing as clickable choices. */
export function choiceOptions(options: readonly string[] | undefined): string[] {
  const sentinel = freeTextOption(options);
  return (options ?? []).filter((option) => option !== sentinel);
}

/**
 * Whether files may go with the answer: a question that takes typed text
 * does, a pick among fixed choices (an approval, say) does not.
 */
export function promptTakesFiles(prompt: { kind: string; options?: readonly string[]; answerElsewhere?: boolean }): boolean {
  if (prompt.answerElsewhere === true) return false;
  return prompt.kind === "input" || prompt.kind === "editor" || (prompt.kind === "select" && freeTextOption(prompt.options) !== undefined);
}
