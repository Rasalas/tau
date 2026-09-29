import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FileKindIcon } from "./FileKindIcon";
import type { UiComposerCommand, UiSkillDraft } from "../../shared/contracts";

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

export interface SelectedSkill {
  name: string;
  invocation: string;
  command: string;
  start: number;
  end: number;
}

export function skillName(command: UiComposerCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

const escapeCharacter = (char: string) => char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

/**
 * Editor-only autocomplete trigger; submitted text is never classified or
 * rewritten here. An extension's character wins over core's own `@`.
 */
export function composerTrigger(text: string, caret: number, extensionChars: readonly string[] = []): ComposerTrigger | undefined {
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
  // Match /command or $skill at start of prompt
  const match = /^\s*([/$])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
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

/** Turns an editor selection into typed metadata without parsing runtime text. */
export function selectedSkillDraft(text: string, selection?: SelectedSkill): UiSkillDraft | undefined {
  if (!selection || text.slice(selection.start, selection.end) !== selection.invocation) return undefined;
  if (text.slice(0, selection.start).trim()) return undefined;
  const suffix = text.slice(selection.end);
  return {
    source: "skill",
    name: selection.name,
    visibleText: /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix,
    command: selection.command,
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
