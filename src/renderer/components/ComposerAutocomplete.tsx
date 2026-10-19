import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FileKindIcon } from "./FileKindIcon";
import type { UiComposerCommand, UiSkillDraft } from "../../shared/contracts";
import { parseSelectedSkillRun } from "../../shared/skill-envelope";

export interface ComposerArgMatch {
  id: string;
  label: string;
  description?: string;
  hint?: string;
}

export interface ComposerTrigger {
  kind: "/" | "$" | "@" | "arg" | "extension";
  query: string;
  start: number;
  end: number;
  command?: string;
  /** The character an extension registered, for `kind: "extension"`. */
  char?: string;
}

/** A skill picked from the `$` menu; where the text holds it is read off the text, so edits before it cannot strand it. */
export interface SelectedSkill {
  name: string;
  invocation: string;
  command: string;
}

export interface SkillToken {
  start: number;
  end: number;
  skill: SelectedSkill;
}

/** Where the text names a selected skill: its `$name` or `/name` alone between whitespace or an end. */
export function skillTokens(text: string, selected: readonly SelectedSkill[]): SkillToken[] {
  if (selected.length === 0) return [];
  const tokens: SkillToken[] = [];
  for (const skill of selected) {
    for (let from = text.indexOf(skill.invocation); from >= 0; from = text.indexOf(skill.invocation, from + 1)) {
      const end = from + skill.invocation.length;
      if ((from === 0 || /\s/u.test(text[from - 1]!)) && (end === text.length || /\s/u.test(text[end]!))) tokens.push({ start: from, end, skill });
    }
  }
  return tokens.sort((a, b) => a.start - b.start);
}

/** Whether the text still names a skill the selection holds. */
export function namesSelectedSkill(text: string, skill: SelectedSkill): boolean {
  return skillTokens(text, [skill]).length > 0;
}

export function skillName(command: UiComposerCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

const escapeCharacter = (char: string) => char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

/**
 * Editor-only autocomplete trigger; submitted text is never classified or
 * rewritten here. An extension's character wins over core's own `@`.
 */
export function composerTrigger(
  text: string,
  caret: number,
  extensionChars: readonly string[] = [],
  /** Skill names, when the runtime loads a skill named anywhere in the text; a `$` past the start then opens the menu while one matches. */
  skillNames?: readonly string[],
): ComposerTrigger | undefined {
  const before = text.slice(0, caret);
  if (extensionChars.length > 0) {
    const pattern = new RegExp(`(?:^|\\s)(${extensionChars.map(escapeCharacter).join("|")})([^\\s]*)$`, "u");
    const extensionMatch = pattern.exec(before);
    if (extensionMatch) {
      const char = extensionMatch[1]!;
      const query = extensionMatch[2] ?? "";
      return { kind: "extension", char, query, start: caret - query.length - char.length, end: caret };
    }
  }
  // Match @file anywhere in the prompt preceded by start or whitespace
  const atMatch = /(?:^|\s)(@)([^\s]*)$/u.exec(before);
  if (atMatch) {
    const start = before.lastIndexOf("@");
    return { kind: "@", query: atMatch[2] ?? "", start, end: caret };
  }
  // Match /command <arg> at start of prompt
  const argMatch = /^\s*\/([a-zA-Z0-9_-]+)\s+([^\s]*)$/u.exec(before);
  if (argMatch) {
    const start = before.lastIndexOf(argMatch[2] ?? "");
    return { kind: "arg", command: argMatch[1], query: argMatch[2] ?? "", start, end: caret };
  }
  const inline = skillNames && /(?:^|\s)\$([^\s]*)$/u.exec(before);
  if (inline) {
    const query = inline[1]!.toLowerCase();
    if (skillNames.some((name) => name.toLowerCase().includes(query))) {
      return { kind: "$", query: inline[1]!, start: before.lastIndexOf("$"), end: caret };
    }
  }
  // Match /command or $skill at start of prompt
  const match = /^\s*([/$])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
  // A second slash in the word, even past the caret, makes it a path such as /tmp/build.sh.
  if (match[1] === "/" && `${match[2]}${/^[^\s]*/u.exec(text.slice(caret))![0]}`.includes("/")) return undefined;
  const start = before.lastIndexOf(match[1]!);
  return { kind: match[1] as "/" | "$", query: match[2] ?? "", start, end: caret };
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

/**
 * Turns the editor's skill selection into typed metadata without parsing
 * runtime text. The skills lead in the order the text names them; the text
 * after the leading ones goes as it was typed. A runtime that takes one skill
 * gets the first, and only when it leads.
 */
export function selectedSkillDraft(text: string, selected: readonly SelectedSkill[], multiple = false): UiSkillDraft | undefined {
  const tokens = skillTokens(text, selected);
  const first = tokens[0];
  if (!first) return undefined;
  const skills = [...new Map(tokens.map((token) => [token.skill.name, token.skill])).values()];
  const run = parseSelectedSkillRun(text, new Set(multiple ? skills.map((skill) => skill.name) : [first.skill.name]));
  if (!multiple && !run) return undefined;
  const [lead, ...more] = multiple ? skills : [first.skill];
  return {
    source: "skill",
    name: lead!.name,
    visibleText: run ? run.userMessage : text,
    command: lead!.command,
    ...(more.length > 0 ? { additionalSkills: more.map((skill) => ({ name: skill.name, command: skill.command })) } : {}),
  };
}

export interface ComposerAutocompleteMenuProps {
  trigger: ComposerTrigger;
  cursor: number;
  commandMatches: readonly UiComposerCommand[];
  fileMatches: readonly string[];
  argMatches?: readonly ComposerArgMatch[];
  onSelectCommand(command: UiComposerCommand): void;
  onSelectFile(file: string): void;
  onSelectArg?(arg: ComposerArgMatch): void;
  /** Rows of an extension's trigger menu, and what the menu lists. */
  extensionMatches?: readonly ComposerArgMatch[];
  extensionLabel?: string;
  onSelectExtension?(item: ComposerArgMatch): void;
  /** Moves the cursor to the row under the pointer. */
  onHover?(index: number): void;
}

interface MenuRow {
  key: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  description?: string;
  /** Where the entry comes from, as a quiet note at the end of the row. */
  source?: string;
  select(): void;
}

function menuRows(props: ComposerAutocompleteMenuProps): { label: string; empty: string; rows: MenuRow[] } {
  const { trigger } = props;
  if (trigger.kind === "extension") {
    return {
      label: props.extensionLabel ?? "Suggestions",
      empty: `Nothing matches “${trigger.query}”.`,
      rows: (props.extensionMatches ?? []).map((item) => ({ key: item.id, label: item.label, hint: item.hint, description: item.description, select: () => props.onSelectExtension?.(item) })),
    };
  }
  if (trigger.kind === "@") {
    return {
      label: "Files",
      empty: `No file matches “${trigger.query}”.`,
      rows: props.fileMatches.map((file) => {
        const slash = file.lastIndexOf("/");
        return { key: file, label: slash >= 0 ? file.slice(slash + 1) : file, icon: <FileKindIcon name={file} />, description: slash >= 0 ? file : undefined, select: () => props.onSelectFile(file) };
      }),
    };
  }
  if (trigger.kind === "arg") {
    return {
      label: `${trigger.command} arguments`,
      empty: `No arguments match “${trigger.query}”.`,
      rows: (props.argMatches ?? []).map((arg) => ({ key: arg.id, label: arg.label, hint: arg.hint, description: arg.description, select: () => props.onSelectArg?.(arg) })),
    };
  }
  const skills = trigger.kind === "$";
  return {
    label: skills ? "Skills" : "Commands",
    empty: `No ${skills ? "skill" : "command"} matches “${trigger.query}”.`,
    rows: props.commandMatches.map((command) => ({
      key: `${command.source}:${command.name}`,
      label: `${trigger.kind}${command.source === "skill" ? skillName(command) : command.name}`,
      hint: command.argumentHint,
      description: command.description || (command.source === "skill" ? "Load this skill for the next turn" : "Run this command"),
      source: command.source,
      select: () => props.onSelectCommand(command),
    })),
  };
}

/** One list for every trigger: 32 px rows, name and description on one line. */
export function ComposerAutocompleteMenu(props: ComposerAutocompleteMenuProps): ReactNode {
  const { label, empty, rows } = menuRows(props);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current?.children[props.cursor]?.scrollIntoView?.({ block: "nearest" });
  }, [props.cursor]);
  return (
    <div ref={list} className="composer-command-menu" role="listbox" aria-label={label}>
      {rows.length > 0 ? rows.map((row, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === props.cursor}
          className={index === props.cursor ? "selected" : ""}
          key={row.key}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => { if (index !== props.cursor) props.onHover?.(index); }}
          onClick={row.select}
        >
          {row.icon}
          <strong>{row.label}{row.hint ? <i>{row.hint}</i> : null}</strong>
          {row.description ? <small>{row.description}</small> : null}
          {row.source ? <em className="composer-command-source">{row.source}</em> : null}
        </button>
      )) : <div className="composer-command-empty">{empty}</div>}
    </div>
  );
}
