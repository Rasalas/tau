import type { ReactNode } from "react";
import type { UiComposerCommand, UiSkillDraft } from "../../shared/contracts";

export interface ComposerArgMatch {
  id: string;
  label: string;
  description?: string;
  hint?: string;
}

export interface ComposerTrigger {
  kind: "/" | "$" | "@" | "arg";
  query: string;
  start: number;
  end: number;
  command?: string;
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

/** Editor-only autocomplete trigger; submitted text is never classified or rewritten here. */
export function composerTrigger(text: string, caret: number): ComposerTrigger | undefined {
  const before = text.slice(0, caret);
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
}

export function ComposerAutocompleteMenu({
  trigger,
  cursor,
  commandMatches,
  fileMatches,
  argMatches = [],
  onSelectCommand,
  onSelectFile,
  onSelectArg,
}: ComposerAutocompleteMenuProps): ReactNode {
  if (trigger.kind === "@") {
    return (
      <div className="composer-command-menu" role="listbox" aria-label="Files">
        {fileMatches.length > 0 ? fileMatches.map((file, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === cursor}
            className={index === cursor ? "selected" : ""}
            key={file}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelectFile(file)}
          >
            <span className="composer-command-mark">@</span>
            <span className="composer-command-copy">
              <strong>{file}</strong>
            </span>
            <span className="composer-command-source file">file</span>
          </button>
        )) : <div className="composer-command-empty">No file matches “{trigger.query}”.</div>}
      </div>
    );
  }

  if (trigger.kind === "arg") {
    return (
      <div className="composer-command-menu" role="listbox" aria-label={`${trigger.command} arguments`}>
        {argMatches.length > 0 ? argMatches.map((arg, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === cursor}
            className={index === cursor ? "selected" : ""}
            key={arg.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelectArg?.(arg)}
          >
            <span className="composer-command-mark">/</span>
            <span className="composer-command-copy">
              <strong>{arg.label}{arg.hint ? <i>{arg.hint}</i> : null}</strong>
              {arg.description ? <small>{arg.description}</small> : null}
            </span>
            <span className="composer-command-source">{trigger.command}</span>
          </button>
        )) : <div className="composer-command-empty">No arguments match “{trigger.query}”.</div>}
      </div>
    );
  }

  return (
    <div className="composer-command-menu" role="listbox" aria-label={trigger.kind === "$" ? "Skills" : "Commands"}>
      {commandMatches.length > 0 ? commandMatches.map((command, index) => {
        const name = command.source === "skill" ? skillName(command) : command.name;
        return (
          <button
            type="button"
            role="option"
            aria-selected={index === cursor}
            className={index === cursor ? "selected" : ""}
            key={`${command.source}:${command.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelectCommand(command)}
          >
            <span className="composer-command-mark">{trigger.kind}</span>
            <span className="composer-command-copy">
              <strong>{name}{command.argumentHint ? <i>{command.argumentHint}</i> : null}</strong>
              <small>{command.description || (command.source === "skill" ? "Load this skill for the next turn" : "Run this command")}</small>
            </span>
            <span className={`composer-command-source ${command.source}`}>{command.source}</span>
          </button>
        );
      }) : <div className="composer-command-empty">No {trigger.kind === "$" ? "skill" : "command"} matches “{trigger.query}”.</div>}
    </div>
  );
}
